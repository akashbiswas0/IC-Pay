import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, merchant } from "./auth.js";
import { config, hasLoyalty } from "./config.js";
import { pool, transaction } from "./db.js";
import { requireAwsWallet } from "./wallets.js";
import { AppError } from "./errors.js";
import { routerSnapshot } from "./payment-router.js";
import { multibaas, merchantBytes32 } from "./multibaas.js";
import { submitOperator, reconcileOperator } from "./operator.js";
import { validateAcceptedSettlement } from "./settlement.js";
import { loyaltyABI, pointUnit } from "./loyalty-protocol.js";
import { confirmedRewardBlock } from "./rewards.js";
import { loyaltyPaymentState } from "./loyalty.js";
const tokenEvents = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
export function publicRefund(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    status:
      row.stage === "confirmed"
        ? "confirmed"
        : row.stage === "failed"
          ? "failed"
          : row.error_code === "refund_submission_unknown"
            ? "reconciling"
            : row.operator_status === "signed"
              ? "submitting"
              : row.operator_status === "confirmed"
                ? "pending"
                : (row.operator_status ?? "queued"),
    amount: row.amount,
    txHash: row.tx_hash ?? row.operator_tx_hash ?? null,
    explorerUrl:
      (row.tx_hash ?? row.operator_tx_hash) && config.EXPLORER_URL
        ? `${config.EXPLORER_URL.replace(/\/$/, "")}/tx/${row.tx_hash ?? row.operator_tx_hash}`
        : null,
    errorCode: row.error_code ?? null,
  };
}
const refundSelect =
  "SELECT r.*,o.status operator_status,o.tx_hash operator_tx_hash FROM loyalty_refunds r LEFT JOIN operator_transactions o ON o.id=CASE WHEN r.stage='approval' THEN r.approval_operation_id ELSE r.refund_operation_id END";
export async function readRefundByInvoice(invoiceId: string) {
  return publicRefund(
    (
      await pool.query(
        refundSelect +
          " WHERE r.invoice_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 1",
        [invoiceId],
      )
    ).rows[0],
  );
}
export async function requestRefund(
  accountId: string,
  mid: string,
  invoiceId: string,
  requestId: string,
) {
  if (!hasLoyalty)
    throw new AppError(
      "loyalty_unconfigured",
      "Loyalty refunds are not configured.",
      503,
    );
  return transaction(async (db) => {
    await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    const old = (
      await db.query(
        "SELECT * FROM loyalty_refunds WHERE account_id=$1 AND request_id=$2 FOR UPDATE",
        [accountId, requestId],
      )
    ).rows[0];
    if (old) {
      if (
        old.invoice_id !== invoiceId ||
        old.merchant_id !== mid ||
        old.account_id !== accountId
      )
        throw new AppError(
          "request_conflict",
          "This refund request belongs to a different payment.",
          409,
        );
      return publicRefund(old);
    }
    const payment = (
      await db.query(
        "SELECT i.*,j.wallet_id,j.tx_hash,j.block_number,j.block_hash,w.address payer FROM invoices i JOIN payment_jobs j ON j.invoice_id=i.id JOIN wallets w ON w.id=j.wallet_id WHERE i.id=$1 AND i.merchant_id=$2 AND i.status='confirmed' AND j.status='confirmed' FOR UPDATE OF i,j",
        [invoiceId, mid],
      )
    ).rows[0];
    if (
      !payment ||
      routerSnapshot(payment.router_address, payment.router_label).kind !==
        "loyalty"
    )
      throw new AppError(
        "refund_unavailable",
        "Only a confirmed loyalty payment can be refunded.",
        409,
      );
    if (
      payment.chain_id !== config.CHAIN_ID ||
      payment.token !== config.TOKEN_ADDRESS
    )
      throw new AppError(
        "refund_network_changed",
        "Restore the original payment network to refund.",
        409,
      );
    const previousAttempts = (
      await db.query(
        "SELECT * FROM loyalty_refunds WHERE invoice_id=$1 ORDER BY created_at DESC,id DESC FOR UPDATE",
        [invoiceId],
      )
    ).rows;
    const active = previousAttempts.find(
      (attempt) => attempt.stage !== "failed",
    );
    if (active) return publicRefund(active);
    if (previousAttempts.length) {
      for (const attempt of previousAttempts) {
        for (const id of [
          attempt.approval_operation_id,
          attempt.refund_operation_id,
        ]) {
          const known = (
            await db.query("SELECT id FROM operator_transactions WHERE id=$1", [
              id,
            ])
          ).rows[0];
          if (!known) {
            if (
              id === attempt.approval_operation_id
                ? attempt.approval_attempted_at
                : attempt.refund_attempted_at
            )
              throw new AppError(
                "refund_submission_unknown",
                "A prior refund signature needs reconciliation before retry.",
                409,
              );
            continue;
          }
          const checked = await reconcileOperator(id);
          if (
            !["confirmed", "failed"].includes(checked.status) ||
            (id === attempt.refund_operation_id &&
              checked.status === "confirmed")
          )
            throw new AppError(
              "refund_retry_unavailable",
              "An earlier refund transaction still needs reconciliation.",
              409,
            );
        }
      }
      const anchor = await confirmedRewardBlock();
      const state = await loyaltyPaymentState(
        payment.payer,
        invoiceId,
        anchor,
        payment.router_address,
        payment.router_label,
      );
      if (
        state.refunded !== false ||
        String(state.netAmount) !== payment.amount ||
        String(state.merchantId) !== merchantBytes32(mid) ||
        String(state.recipient).toLowerCase() !== payment.recipient
      )
        throw new AppError(
          "refund_retry_unavailable",
          "The original on-chain payment cannot safely be retried for refund.",
          409,
        );
    }
    const wallet = (
      await db.query(
        "SELECT w.* FROM wallets w JOIN merchant_operators m ON m.account_id=w.account_id WHERE w.account_id=$1 AND m.merchant_id=$2 AND w.card_id IS NULL AND w.status='ready' AND w.address=$3 FOR UPDATE OF w",
        [accountId, mid, payment.recipient],
      )
    ).rows[0];
    if (!wallet)
      throw new AppError(
        "refund_wallet_unavailable",
        "The original merchant receiving wallet is unavailable.",
        409,
      );
    const keyId = requireAwsWallet(wallet),
      id = randomUUID();
    const row = (
      await db.query(
        "INSERT INTO loyalty_refunds(id,invoice_id,merchant_id,account_id,request_id,payer,recipient,amount,chain_id,token_address,router_address,router_label,key_id,approval_operation_id,refund_operation_id,stage)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *",
        [
          id,
          invoiceId,
          mid,
          accountId,
          requestId,
          payment.payer,
          payment.recipient,
          payment.amount,
          payment.chain_id,
          payment.token,
          payment.router_address,
          payment.router_label,
          keyId,
          randomUUID(),
          randomUUID(),
          BigInt(payment.amount) === 0n ? "refund" : "approval",
        ],
      )
    ).rows[0];
    return publicRefund(row);
  });
}
export function refundReceiptMatches(
  logs: any[],
  row: any,
  state: Record<string, any>,
  confirmed: { timestamp: string | number },
) {
  if (
    state.refunded !== true ||
    String(state.merchantId) !== merchantBytes32(row.merchant_id) ||
    String(state.recipient).toLowerCase() !== row.recipient ||
    String(state.netAmount) !== row.amount
  )
    return false;
  const refunds = logs.filter((log) => {
    if (log.removed || String(log.address).toLowerCase() !== row.router_address)
      return false;
    try {
      const e = loyaltyABI.parseLog(log);
      return (
        e?.name === "PaymentRefunded" &&
        e.args.invoiceId === row.invoice_id &&
        e.args.merchantId === merchantBytes32(row.merchant_id) &&
        String(e.args.payer).toLowerCase() === row.payer &&
        String(e.args.recipient).toLowerCase() === row.recipient &&
        String(e.args.token).toLowerCase() === row.token_address &&
        String(e.args.amount) === row.amount &&
        BigInt(e.args.pointsRestoredUnits) <=
          BigInt(state.redeemedPoints) * pointUnit(config.TOKEN_DECIMALS) &&
        BigInt(e.args.earnedReversedUnits) ===
          (BigInt(state.earnedExpiresAt) > BigInt(confirmed.timestamp)
            ? BigInt(state.earnedUnits)
            : BigInt(state.debtRepaid))
      );
    } catch {
      return false;
    }
  });
  if (refunds.length !== 1) return false;
  if (BigInt(row.amount) === 0n) return true;
  return (
    logs.filter((log) => {
      if (
        log.removed ||
        String(log.address).toLowerCase() !== row.token_address
      )
        return false;
      try {
        const e = tokenEvents.parseLog(log);
        return (
          e?.name === "Transfer" &&
          String(e.args.from).toLowerCase() === row.recipient &&
          String(e.args.to).toLowerCase() === row.payer &&
          String(e.args.value) === row.amount
        );
      } catch {
        return false;
      }
    }).length === 1
  );
}
function approvalMatches(logs: any[], row: any) {
  return logs.some((log) => {
    if (log.removed || String(log.address).toLowerCase() !== row.token_address)
      return false;
    try {
      const e = tokenEvents.parseLog(log);
      return (
        e?.name === "Approval" &&
        String(e.args.owner).toLowerCase() === row.recipient &&
        String(e.args.spender).toLowerCase() === row.router_address &&
        String(e.args.value) === row.amount
      );
    } catch {
      return false;
    }
  });
}
export async function guardRefundWallet<T>(
  row: any,
  action: () => Promise<T>,
): Promise<T> {
  return transaction(async (db) => {
    const a = (
      await db.query("SELECT role FROM accounts WHERE id=$1 FOR UPDATE", [
        row.account_id,
      ])
    ).rows[0];
    const w = (
      await db.query(
        "SELECT w.* FROM wallets w JOIN merchant_operators m ON m.account_id=w.account_id WHERE w.account_id=$1 AND m.merchant_id=$2 AND w.card_id IS NULL FOR UPDATE OF w",
        [row.account_id, row.merchant_id],
      )
    ).rows[0];
    if (
      a?.role !== "merchant" ||
      !w ||
      w.status !== "ready" ||
      w.address !== row.recipient ||
      requireAwsWallet(w) !== row.key_id
    )
      throw new AppError(
        "refund_wallet_changed",
        "The original merchant refund wallet changed.",
        409,
      );
    return action();
  });
}
/** An allowance is shared state: serialize the entire approval/refund lifecycle per merchant spender. */
export async function dueLoyaltyRefunds() {
  return (
    await pool.query(`SELECT r.* FROM loyalty_refunds r WHERE
 ((r.stage IN ('approval','refund') AND (r.error_code IS NULL OR r.updated_at<now()-interval '30 seconds')) OR
 (r.stage='confirmed' AND r.updated_at<now()-interval '5 minutes'))
 AND (r.stage='confirmed' OR NOT EXISTS(SELECT 1 FROM loyalty_refunds older WHERE older.recipient=r.recipient AND older.token_address=r.token_address AND older.router_address=r.router_address AND older.stage IN ('approval','refund') AND (older.created_at,older.id)<(r.created_at,r.id)))
 ORDER BY r.created_at,r.id LIMIT 2`)
  ).rows;
}
export async function processLoyaltyRefunds(
  shouldStop: () => boolean = () => false,
  onProgress: () => Promise<void> = async () => {},
) {
  const rows = await dueLoyaltyRefunds();
  for (const row of rows) {
    if (shouldStop()) break;
    await onProgress();
    try {
      if (
        row.chain_id !== config.CHAIN_ID ||
        row.token_address !== config.TOKEN_ADDRESS ||
        routerSnapshot(row.router_address, row.router_label).kind !== "loyalty"
      )
        throw new AppError(
          "refund_network_changed",
          "Restore the original refund deployment.",
          409,
        );
      const payment = (
        await pool.query(
          "SELECT j.* FROM payment_jobs j WHERE j.invoice_id=$1",
          [row.invoice_id],
        )
      ).rows[0];
      if (
        !payment ||
        payment.status !== "confirmed" ||
        !(await validateAcceptedSettlement(payment))
      )
        throw new AppError(
          "refund_payment_unconfirmed",
          "The original payment must remain confirmed before refunding.",
          409,
        );
      const approval = row.stage === "approval",
        id = approval ? row.approval_operation_id : row.refund_operation_id,
        attempted = approval
          ? row.approval_attempted_at
          : row.refund_attempted_at;
      const old = (
        await pool.query("SELECT id FROM operator_transactions WHERE id=$1", [
          id,
        ])
      ).rows[0];
      if (!old && attempted)
        throw new AppError(
          "refund_submission_unknown",
          "This refund needs reconciliation before another signature.",
          409,
        );
      let operation;
      if (old) operation = await reconcileOperator(id);
      else {
        await guardRefundWallet(row, async () => undefined);
        operation = await submitOperator(
          row.key_id,
          approval ? row.token_address : row.router_address,
          approval ? config.TOKEN_CONTRACT : row.router_label,
          approval ? "approve" : "refund",
          approval
            ? [row.router_address, row.amount]
            : [row.invoice_id, row.payer],
          id,
          async () => {
            const column = approval
              ? "approval_attempted_at"
              : "refund_attempted_at";
            const changed = await pool.query(
              `UPDATE loyalty_refunds SET ${column}=now(),error_code=NULL,updated_at=now() WHERE id=$1 AND ${column} IS NULL RETURNING id`,
              [row.id],
            );
            if (!changed.rowCount)
              throw new AppError(
                "refund_submission_unknown",
                "This refund stage was already attempted.",
                409,
              );
          },
          (action) => guardRefundWallet(row, action),
          onProgress,
        );
      }
      if (operation.status === "failed") {
        await pool.query(
          "UPDATE loyalty_refunds SET stage='failed',error_code='refund_transaction_reverted',updated_at=now() WHERE id=$1",
          [row.id],
        );
        continue;
      }
      if (operation.status !== "confirmed") {
        await pool.query(
          "UPDATE loyalty_refunds SET stage=$2,error_code=NULL,updated_at=now() WHERE id=$1",
          [row.id, approval ? "approval" : "refund"],
        );
        continue;
      }
      const receipt = (await multibaas.receipt(operation.txHash)).data;
      const accepted = (
        await pool.query(
          "SELECT block_number,block_hash FROM operator_transactions WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (
        !receipt ||
        !accepted?.block_number ||
        String(receipt.transactionHash).toLowerCase() !==
          operation.txHash.toLowerCase() ||
        receipt.blockHash !== accepted.block_hash ||
        BigInt(receipt.blockNumber ?? -1) !== BigInt(accepted.block_number) ||
        BigInt(receipt.status ?? 0) !== 1n
      )
        throw new AppError(
          "refund_receipt_mismatch",
          "Refund receipt is not the accepted canonical transaction.",
          502,
        );
      if (approval) {
        if (!approvalMatches(receipt.logs, row))
          throw new AppError(
            "refund_approval_mismatch",
            "The refund allowance was not confirmed.",
            502,
          );
        await pool.query(
          "UPDATE loyalty_refunds SET stage='refund',error_code=NULL,updated_at=now() WHERE id=$1",
          [row.id],
        );
        continue;
      }
      const state = await loyaltyPaymentState(
        row.payer,
        row.invoice_id,
        {
          number: BigInt(receipt.blockNumber).toString(),
          hash: receipt.blockHash,
        },
        row.router_address,
        row.router_label,
      );
      const block = await multibaas.block(receipt.blockNumber);
      if (block.hash !== receipt.blockHash)
        throw new AppError(
          "refund_reorganization",
          "Refund is being reconciled.",
          503,
        );
      if (
        !refundReceiptMatches(receipt.logs, row, state, {
          timestamp: block.timestamp,
        })
      )
        throw new AppError(
          "refund_receipt_mismatch",
          "Actual returned tokens and refund points do not match this payment.",
          502,
        );
      await pool.query(
        "UPDATE loyalty_refunds SET stage='confirmed',tx_hash=$2,error_code=NULL,updated_at=now() WHERE id=$1",
        [row.id, operation.txHash],
      );
    } catch (error) {
      await pool.query(
        "UPDATE loyalty_refunds SET stage=CASE WHEN stage='confirmed' THEN 'refund' ELSE stage END,error_code=$2,updated_at=now() WHERE id=$1",
        [
          row.id,
          error instanceof AppError
            ? error.code
            : "refund_provider_unavailable",
        ],
      );
    }
  }
}
export async function loyaltyRefundRoutes(app: FastifyInstance) {
  app.post("/v1/invoices/:id/refund", async (req) => {
    const account = await authenticate(req),
      mid = merchant(account);
    const { id } = z
      .object({ id: z.string().regex(/^0x[0-9a-f]{64}$/) })
      .parse(req.params);
    const { requestId } = z
      .object({ requestId: z.uuid() })
      .strict()
      .parse(req.body);
    return requestRefund(account.id, mid, id, requestId);
  });
  app.get("/v1/refunds/:id", async (req) => {
    const a = await authenticate(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = (
      await pool.query(
        refundSelect +
          " JOIN invoices i ON i.id=r.invoice_id WHERE r.id=$1 AND (r.merchant_id=$2 OR i.account_id=$3)",
        [id, a.merchant_id, a.id],
      )
    ).rows[0];
    if (!row) throw new AppError("not_found", "Refund not found.", 404);
    return publicRefund(row);
  });
}
