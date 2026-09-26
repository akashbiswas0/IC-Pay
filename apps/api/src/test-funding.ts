import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, customer } from "./auth.js";
import { resolveCard } from "./card-wallets.js";
import { config, hasTestFunding } from "./config.js";
import { pool, transaction } from "./db.js";
import { AppError } from "./errors.js";
import { multibaas } from "./multibaas.js";
import { reconcileOperator, submitOperator } from "./operator.js";
const scope = z.object({ cardId: z.string().uuid().optional() }).strict();
const mintEvents = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const testFundingAmount = () =>
  (1000n * 10n ** BigInt(config.TOKEN_DECIMALS)).toString();
function publicClaim(row: any) {
  return row
    ? {
        id: row.id,
        status: row.status,
        cardId: row.card_id,
        walletAddress: row.wallet_address,
        amount: row.amount,
        txHash: row.tx_hash,
        explorerUrl:
          row.tx_hash && config.EXPLORER_URL
            ? `${config.EXPLORER_URL.replace(/\/$/, "")}/tx/${row.tx_hash}`
            : null,
        errorCode: row.error_code,
      }
    : null;
}
function response(row: any, reason?: string) {
  return {
    status: reason
      ? reason === "daily_limit_reached" || reason === "wallet_not_ready"
        ? "unavailable"
        : "pending_setup"
      : "available",
    amount: row?.amount ?? testFundingAmount(),
    symbol: config.TOKEN_SYMBOL,
    name: config.TOKEN_NAME,
    onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
    canClaim: !row && !reason,
    claim: publicClaim(row),
    ...(reason ? { reason } : {}),
  };
}
function setupReason() {
  if (!config.TEST_FUNDING_ENABLED) return "test_funding_disabled";
  if (!hasTestFunding) return "test_funding_unconfigured";
}
export async function readTestFunding(accountId: string, cardId?: string) {
  const existing = (
    await pool.query("SELECT * FROM test_funding_claims WHERE account_id=$1", [
      accountId,
    ])
  ).rows[0];
  if (existing) return response(existing, setupReason());
  const card = await resolveCard(accountId, cardId, pool, true);
  const reason = setupReason();
  if (reason) return response(null, reason);
  const wallet = (
    await pool.query(
      "SELECT id FROM wallets WHERE account_id=$1 AND card_id=$2 AND status='ready' AND address IS NOT NULL",
      [accountId, card.id],
    )
  ).rows[0];
  if (!wallet) return response(null, "wallet_not_ready");
  const count = (
    await pool.query(
      "SELECT count(*)::int count FROM test_funding_claims WHERE claim_day=(now() AT TIME ZONE 'UTC')::date",
    )
  ).rows[0].count;
  return response(
    null,
    count >= config.TEST_FUNDING_DAILY_LIMIT
      ? "daily_limit_reached"
      : undefined,
  );
}
export async function requestTestFunding(accountId: string, cardId?: string) {
  return transaction(async (db) => {
    // Serialize all claim budget reservations, then lock the account/card/wallet identity.
    await db.query("SELECT pg_advisory_xact_lock(830146273)");
    const account = (
      await db.query(
        "SELECT role,verified FROM accounts WHERE id=$1 FOR UPDATE",
        [accountId],
      )
    ).rows[0];
    if (!account || account.role !== "customer" || !account.verified)
      throw new AppError(
        "verification_required",
        "Complete World verification first.",
        403,
      );
    const existing = (
      await db.query("SELECT * FROM test_funding_claims WHERE account_id=$1", [
        accountId,
      ])
    ).rows[0];
    if (existing) return response(existing, setupReason());
    const card = await resolveCard(accountId, cardId, db, true);
    const locked = (
      await db.query(
        "SELECT id FROM cards WHERE id=$1 AND account_id=$2 AND active AND removed_at IS NULL FOR UPDATE",
        [card.id, accountId],
      )
    ).rows[0];
    if (!locked)
      throw new AppError(
        "card_unavailable",
        "This card is no longer available.",
        409,
      );
    const reason = setupReason();
    if (reason) return response(null, reason);
    const wallet = (
      await db.query(
        "SELECT * FROM wallets WHERE account_id=$1 AND card_id=$2 FOR UPDATE",
        [accountId, card.id],
      )
    ).rows[0];
    if (!wallet?.address || wallet.status !== "ready")
      return response(null, "wallet_not_ready");
    const count = (
      await db.query(
        "SELECT count(*)::int count FROM test_funding_claims WHERE claim_day=(now() AT TIME ZONE 'UTC')::date",
      )
    ).rows[0].count;
    if (count >= config.TEST_FUNDING_DAILY_LIMIT)
      return response(null, "daily_limit_reached");
    const id = randomUUID();
    const row = (
      await db.query(
        `INSERT INTO test_funding_claims(id,account_id,card_id,wallet_id,wallet_address,chain_id,token_address,token_label,amount,symbol,operator_key_id,operation_id,card_linked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1,$12) RETURNING *`,
        [
          id,
          accountId,
          card.id,
          wallet.id,
          wallet.address,
          config.CHAIN_ID,
          config.TOKEN_ADDRESS,
          config.TOKEN_CONTRACT,
          testFundingAmount(),
          config.TOKEN_SYMBOL,
          config.AWS_KMS_OPERATOR_KEY_ID,
          card.generation,
        ],
      )
    ).rows[0];
    return response(row);
  });
}
export function fundingMintMatches(logs: any[], claim: any): boolean {
  return (
    logs.filter((log) => {
      if (
        log.removed ||
        String(log.address).toLowerCase() !== claim.token_address
      )
        return false;
      try {
        const event = mintEvents.parseLog(log);
        return (
          event?.args.from === "0x" + "00".repeat(20) &&
          String(event.args.to).toLowerCase() === claim.wallet_address &&
          String(event.args.value) === claim.amount
        );
      } catch {
        return false;
      }
    }).length === 1
  );
}
export async function testFundingRoutes(app: FastifyInstance) {
  app.get("/v1/test-funding", async (req) => {
    const account = await authenticate(req);
    customer(account);
    const body = scope.parse(req.query);
    return readTestFunding(account.id, body.cardId);
  });
  app.post("/v1/test-funding", async (req) => {
    const account = await authenticate(req);
    customer(account);
    const body = scope.parse(req.body ?? {});
    return requestTestFunding(account.id, body.cardId);
  });
}
/** Holds the identity locks through KMS signing; no destination is ever reassigned. */
export async function guardTestFundingSignature<T>(
  claim: any,
  sign: () => Promise<T>,
): Promise<T> {
  return transaction(async (db) => {
    const account = (
      await db.query(
        "SELECT verified,role FROM accounts WHERE id=$1 FOR UPDATE",
        [claim.account_id],
      )
    ).rows[0];
    const card = (
      await db.query(
        "SELECT active,removed_at,linked_at=(SELECT card_linked_at FROM test_funding_claims WHERE id=$2) same_generation FROM cards WHERE id=$1 AND account_id=$3 FOR UPDATE",
        [claim.card_id, claim.id, claim.account_id],
      )
    ).rows[0];
    const wallet = (
      await db.query(
        "SELECT address,status,card_id FROM wallets WHERE id=$1 AND account_id=$2 FOR UPDATE",
        [claim.wallet_id, claim.account_id],
      )
    ).rows[0];
    if (
      !account?.verified ||
      account.role !== "customer" ||
      !card?.active ||
      card.removed_at ||
      !card.same_generation ||
      wallet?.status !== "ready" ||
      wallet.address !== claim.wallet_address ||
      wallet.card_id !== claim.card_id
    )
      throw new AppError(
        "funding_destination_unavailable",
        "The original verified card wallet is no longer available. This claim cannot be redirected.",
        409,
      );
    return sign();
  });
}
/** Called under the worker advisory lock. No ambiguous signing/broadcast is retried. */
export async function processTestFunding(
  shouldStop: () => boolean = () => false,
  onProgress: () => Promise<void> = async () => {},
) {
  const rows = (
    await pool.query(`SELECT * FROM test_funding_claims WHERE
    (status='queued' AND (error_code IS NULL OR updated_at<now()-interval '30 seconds')) OR
    (status IN ('submitting','pending','reconciling') AND updated_at<now()-interval '12 seconds') OR
    (status='confirmed' AND updated_at<now()-interval '5 minutes')
    ORDER BY CASE WHEN status='confirmed' THEN 1 ELSE 0 END,created_at LIMIT 2`)
  ).rows;
  for (const row of rows) {
    if (shouldStop()) break;
    await onProgress();
    try {
      if (
        row.chain_id !== config.CHAIN_ID ||
        row.token_address !== config.TOKEN_ADDRESS
      )
        throw new AppError(
          "test_funding_network_changed",
          "Restore the original token network to reconcile this claim.",
          409,
        );
      const previous = (
        await pool.query("SELECT id FROM operator_transactions WHERE id=$1", [
          row.operation_id,
        ])
      ).rows[0];
      if (!previous && row.attempted_at)
        throw new AppError(
          "submission_unknown",
          "This claim needs operator reconciliation before another signature.",
          409,
        );
      let operation;
      if (previous) operation = await reconcileOperator(row.operation_id);
      else {
        if (!hasTestFunding)
          throw new AppError(
            "test_funding_unconfigured",
            "Test funding is not configured.",
            503,
          );
        await guardTestFundingSignature(row, async () => undefined);
        operation = await submitOperator(
          row.operator_key_id,
          row.token_address,
          row.token_label,
          "mint",
          [row.wallet_address, row.amount],
          row.operation_id,
          async () => {
            // The marker commits before KMS signing; an interruption here cannot cause a second mint.
            const marked = await pool.query(
              "UPDATE test_funding_claims SET status='submitting',attempted_at=now(),error_code=NULL,updated_at=now() WHERE id=$1 AND attempted_at IS NULL AND status='queued' RETURNING id",
              [row.id],
            );
            if (!marked.rowCount)
              throw new AppError(
                "submission_unknown",
                "This claim was already attempted.",
                409,
              );
          },
          (sign) => guardTestFundingSignature(row, sign),
          onProgress,
        );
      }
      let status =
        operation.status === "signed" ? "reconciling" : operation.status;
      let errorCode: string | null =
        status === "failed" ? "transaction_reverted" : null;
      if (status === "confirmed") {
        const receipt = (await multibaas.receipt(operation.txHash)).data;
        const accepted = (
          await pool.query(
            "SELECT block_number,block_hash FROM operator_transactions WHERE id=$1",
            [row.operation_id],
          )
        ).rows[0];
        if (
          !receipt ||
          !accepted?.block_number ||
          String(receipt.transactionHash).toLowerCase() !==
            operation.txHash.toLowerCase() ||
          receipt.blockHash !== accepted.block_hash ||
          BigInt(receipt.blockNumber ?? -1) !== BigInt(accepted.block_number) ||
          BigInt(receipt.status ?? 0) !== 1n ||
          !fundingMintMatches(receipt.logs ?? [], row)
        ) {
          status = "reconciling";
          errorCode = "funding_receipt_mismatch";
        }
      }
      await pool.query(
        "UPDATE test_funding_claims SET status=$2,tx_hash=$3,error_code=$4,updated_at=now() WHERE id=$1",
        [row.id, status, operation.txHash, errorCode],
      );
    } catch (error) {
      await pool.query(
        "UPDATE test_funding_claims SET status=CASE WHEN attempted_at IS NOT NULL THEN 'reconciling' WHEN $2='funding_destination_unavailable' THEN 'failed' ELSE status END,error_code=$2,updated_at=now() WHERE id=$1",
        [
          row.id,
          error instanceof AppError ? error.code : "provider_unavailable",
        ],
      );
    }
  }
}
