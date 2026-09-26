import { processLoyaltyRefunds } from "./loyalty-refunds.js";
import {
  allowsPolicyRouter,
  validateRetainedAllowance,
} from "./policy-router.js";
import {
  consumePoints,
  loyaltyPaymentState,
  validateLoyaltyReceipt,
} from "./loyalty.js";
import { processTestFunding } from "./test-funding.js";
import { pathToFileURL } from "node:url";
import { recordWorkerProgress, clearWorkerProgress } from "./worker-health.js";
import { setTimeout as delay } from "node:timers/promises";
import { provisionCardWallets } from "./card-wallet-provisioning.js";
import { provisionMerchants } from "./merchant-provisioning.js";
import { config, hasPayments } from "./config.js";
import { pool, transaction, withWalletLock } from "./db.js";
import type { PoolClient } from "pg";
import type { TransactionLike } from "ethers";
import { kmsWallets, requireAwsWallet } from "./wallets.js";
import {
  markSettlementUncertain,
  validateAcceptedSettlement,
} from "./settlement.js";
import { reconcileOperator } from "./operator.js";
import { AppError } from "./errors.js";
import { routerSnapshot, assertPaymentModel } from "./payment-router.js";
import {
  validateRewardReceipt,
  tuple,
  consumeRewardReservation,
} from "./rewards.js";
import { processRewardCampaigns } from "./reward-campaign-worker.js";
import { matchesJobTransaction } from "./reconciliation.js";
import {
  merchantBytes32,
  MULTIBAAS_PAGE_SIZE,
  multibaas,
  paymentABI,
  approvalABI,
} from "./multibaas.js";
export async function failJob(job: any, code: string) {
  await transaction(async (db) => {
    const row = (
      await db.query("SELECT status FROM payment_jobs WHERE id=$1 FOR UPDATE", [
        job.id,
      ])
    ).rows[0];
    if (row.status === "failed") return;
    if (job.kind === "payment") {
      await db.query(
        "UPDATE policies SET reserved=reserved-$2 WHERE account_id=$1 AND (id=$3 OR ($3::uuid IS NULL AND card_id IS NULL))",
        [job.account_id, job.amount, job.policy_id ?? null],
      );
      await db.query(`UPDATE invoices SET status='failed' WHERE id=$1`, [
        job.invoice_id,
      ]);
    }
    await db.query(
      "UPDATE loyalty_reservations SET released_at=now() WHERE job_id=$1 AND released_at IS NULL",
      [job.id],
    );
    await db.query(
      "UPDATE reward_reservations SET released_at=now() WHERE job_id=$1 AND released_at IS NULL",
      [job.id],
    );
    await db.query(
      `UPDATE payment_jobs SET status='failed',error_code=$2,signed_tx=CASE WHEN broadcast_attempted_at IS NULL THEN NULL ELSE signed_tx END,updated_at=now() WHERE id=$1`,
      [job.id, code],
    );
  });
}
export async function authorizeForSigning(db: PoolClient, job: any) {
  assertPaymentModel(job);
  await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
    job.account_id,
  ]);
  const current = (
    await db.query(
      "SELECT * FROM wallets WHERE account_id=$1 AND (id=$2 OR ($2::uuid IS NULL AND card_id IS NULL)) FOR UPDATE",
      [job.account_id, job.wallet_id ?? null],
    )
  ).rows[0];
  if (
    !current ||
    current.status !== "ready" ||
    current.address !== job.address ||
    requireAwsWallet(current) !== job.key_id
  )
    throw new AppError("wallet_changed", "The signing wallet changed.", 409);
  if (!current.card_id || current.card_id !== job.card_id)
    throw new AppError(
      "wallet_card_changed",
      "The payment wallet is not linked to this card.",
      409,
    );
  const eligibleCard = (
    await db.query(
      "SELECT 1 FROM cards c JOIN payment_jobs j ON j.card_hash=c.card_hash AND j.card_linked_at=c.linked_at WHERE j.id=$1 AND c.id=$2 AND c.account_id=$3 AND c.active AND c.removed_at IS NULL FOR UPDATE OF c",
      [job.id, current.card_id, job.account_id],
    )
  ).rowCount;
  if (!eligibleCard)
    throw new AppError(
      "spending_disabled_before_signing",
      "Card authorization changed before signing.",
      409,
    );
  if (job.kind === "payment") {
    await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      job.account_id,
    ]);
    const p = (
      await db.query(
        "SELECT * FROM policies WHERE account_id=$1 AND id=$2 AND card_id=$3 FOR UPDATE",
        [job.account_id, job.policy_id, current.card_id],
      )
    ).rows[0];
    const terminal = (
      await db.query(
        "SELECT id FROM terminals WHERE id=$1 AND merchant_id=$2 AND revoked_at IS NULL FOR UPDATE",
        [job.terminal_id, job.merchant_id],
      )
    ).rowCount;
    const card = (
      await db.query(
        "SELECT c.card_hash FROM cards c JOIN payment_jobs j ON j.card_hash=c.card_hash AND j.card_linked_at=c.linked_at WHERE c.card_hash=$1 AND c.account_id=$2 AND c.active AND j.id=$3 FOR UPDATE OF c",
        [job.card_hash, job.account_id, job.id],
      )
    ).rowCount;
    const allowed =
      p?.merchant_scope === "all" ||
      Boolean(
        (
          await db.query(
            "SELECT 1 FROM policy_merchants WHERE policy_id=$1 AND merchant_id=$2",
            [job.policy_id, job.merchant_id],
          )
        ).rowCount,
      );
    const merchant = (
      await db.query("SELECT enabled,recipient FROM merchants WHERE id=$1", [
        job.merchant_id,
      ])
    ).rows[0];
    if (
      job.expires_at.getTime() <= Date.now() ||
      !terminal ||
      !card ||
      !p?.enabled ||
      !(await allowsPolicyRouter(
        db,
        p,
        job.expected_router,
        Boolean(job.reward_id),
      )) ||
      BigInt(job.gross_amount ?? job.amount) > BigInt(p.per_payment_limit) ||
      ((job.reward_id || BigInt(job.points_redeemed ?? 0) > 0n) &&
        !p.use_rewards) ||
      (p.max_points_per_payment != null &&
        BigInt(job.points_redeemed ?? 0) > BigInt(p.max_points_per_payment)) ||
      (job.max_points != null &&
        BigInt(job.points_redeemed ?? 0) > BigInt(job.max_points)) ||
      p.expires_at.getTime() <= Date.now() ||
      !allowed ||
      !merchant?.enabled ||
      merchant.recipient !== job.recipient
    )
      throw new AppError(
        "spending_disabled_before_signing",
        "Automatic payment was disabled before signing.",
      );
    if (
      !(await validateRetainedAllowance(
        p,
        job.address,
        job.expected_router,
        job.amount,
      ))
    )
      throw new AppError(
        "router_approval_required",
        "Earlier voucher spending allowance is unavailable.",
        409,
      );
    if (BigInt(job.points_redeemed ?? 0) > 0n) {
      const reservation = await db.query(
        "SELECT id FROM loyalty_reservations WHERE job_id=$1 AND wallet_id=$2 AND merchant_id=$3 AND chain_id=$4 AND router_address=$5 AND points=$6 AND released_at IS NULL FOR UPDATE",
        [
          job.id,
          job.wallet_id,
          job.merchant_id,
          job.expected_chain,
          job.expected_router,
          job.points_redeemed,
        ],
      );
      if (!reservation.rowCount)
        throw new AppError(
          "points_reserved",
          "The point reservation is unavailable.",
          409,
        );
    }
    if (job.reward_id) {
      const reservation = (
        await db.query(
          "SELECT id FROM reward_reservations WHERE job_id=$1 AND chain_id=$2 AND router_address=$3 AND reward_id=$4 AND released_at IS NULL FOR UPDATE",
          [job.id, job.expected_chain, job.expected_router, job.reward_id],
        )
      ).rowCount;
      if (!reservation)
        throw new AppError(
          "reward_reserved",
          "The reward reservation is unavailable.",
          409,
        );
    }
  }
}
async function submit(job: any) {
  // Recheck accepted nonce-consuming transactions before any later signature, even
  // if this queued row was ordered before an older confirmed row in this cycle.
  const accepted = (
    await pool.query(
      "SELECT * FROM payment_jobs WHERE wallet_id=$1 AND status='confirmed'",
      [job.wallet_id],
    )
  ).rows;
  for (const prior of accepted) {
    try {
      verifyNetwork(prior);
      await validateAcceptedSettlement(prior);
    } catch {
      await markSettlementUncertain(prior, "canonical_receipt_unavailable");
    }
  }
  const operatorAccepted = (
    await pool.query(
      "SELECT id FROM operator_transactions WHERE address=$1 AND status IN ('confirmed','failed')",
      [job.address],
    )
  ).rows;
  for (const prior of operatorAccepted) await reconcileOperator(prior.id);
  // An unresolved previous nonce must not be reused by another direct KMS operation.
  const blocked = await pool.query(
    "SELECT 1 FROM payment_jobs WHERE wallet_id=$1 AND id<>$2 AND status IN ('submitting','pending','reconciling') UNION ALL SELECT 1 FROM operator_transactions WHERE address=$3 AND status IN ('signed','pending','reconciling') LIMIT 1",
    [job.wallet_id, job.id, job.address],
  );
  if (blocked.rowCount) {
    await pool.query(
      "UPDATE payment_jobs SET error_code='wallet_operation_pending' WHERE id=$1",
      [job.id],
    );
    return;
  }
  let unsigned: TransactionLike;
  try {
    requireAwsWallet(job);
    await multibaas.validateChain();
    verifyNetwork(job);
    const router = routerSnapshot(
      job.expected_router,
      job.expected_router_label,
    );
    if (job.kind === "payment") {
      if (
        job.chain_id !== config.CHAIN_ID ||
        job.token !== config.TOKEN_ADDRESS
      )
        throw new AppError(
          "invoice_network_mismatch",
          "Invoice network configuration has changed.",
        );
      if (job.expires_at.getTime() <= Date.now())
        throw new AppError("invoice_expired", "Invoice expired.");
      if (BigInt(await multibaas.balance(job.address)) < BigInt(job.amount))
        throw new AppError(
          "insufficient_tokens",
          "Insufficient token balance.",
        );
      if (
        BigInt(await multibaas.allowance(job.address, job.expected_router)) <
        BigInt(job.amount)
      )
        throw new AppError(
          "insufficient_allowance",
          "Insufficient token allowance.",
        );
      const token = await multibaas.call(
        router.address,
        router.label,
        "token",
        [],
      );
      const merchant = await multibaas.call(
        router.address,
        router.label,
        "merchants",
        [merchantBytes32(job.merchant_id)],
      );
      const recipient = merchant.output?.[0];
      const enabled = merchant.output?.[1];
      if (
        String(token.output).toLowerCase() !== config.TOKEN_ADDRESS ||
        String(recipient).toLowerCase() !== job.recipient ||
        enabled !== true
      )
        throw new AppError(
          "merchant_contract_mismatch",
          "On-chain merchant terms do not match the invoice.",
        );
    }
    if (BigInt(job.points_redeemed ?? 0) > 0n) {
      const quote = await multibaas.call(
        router.address,
        router.label,
        "quotePoints",
        [
          job.address,
          merchantBytes32(job.merchant_id),
          job.gross_amount,
          job.points_redeemed,
        ],
      );
      const [points, discount, net] = tuple(quote.output, [
        "pointsUsed",
        "discount",
        "netAmount",
      ]);
      if (
        String(points) !== job.points_redeemed ||
        String(discount) !== job.discount_amount ||
        String(net) !== job.amount
      )
        throw new AppError(
          "points_quote_changed",
          "The exact point quote is no longer available.",
          409,
        );
    }
    if (job.reward_id) {
      const quote = await multibaas.call(
        router.address,
        router.label,
        "quoteReward",
        [
          job.reward_id,
          job.address,
          merchantBytes32(job.merchant_id),
          job.gross_amount,
        ],
      );
      const [discount, net] = tuple(quote.output, ["discount", "netAmount"]);
      if (
        String(discount) !== job.discount_amount ||
        String(net) !== job.amount
      )
        throw new AppError(
          "reward_quote_changed",
          "The reward is no longer available for the authorized amount.",
          409,
        );
    }
    unsigned = await multibaas.preparePayment(
      job.address,
      job.kind,
      job.amount,
      job.kind === "payment"
        ? {
            id: job.invoice_id,
            merchant_id: job.merchant_id,
            expires_at: job.expires_at,
            gross_amount: job.gross_amount ?? job.amount,
            reward_id: job.reward_id,
            points_redeemed: job.points_redeemed,
          }
        : undefined,
      job.expected_router,
      job.expected_router_label,
    );
  } catch (err) {
    await failJob(job, err instanceof AppError ? err.code : "preflight_failed");
    return;
  }
  // Claim durably. A crash before signed bytes are committed is visible and blocks the wallet.
  await transaction(async (db) => {
    await db.query(
      "UPDATE payment_jobs SET status='submitting',error_code=NULL,updated_at=now() WHERE id=$1",
      [job.id],
    );
    if (job.invoice_id)
      await db.query("UPDATE invoices SET status='submitting' WHERE id=$1", [
        job.invoice_id,
      ]);
  });
  let signed: { signedTx: string; hash: string; nonce: string };
  try {
    signed = await transaction(async (db) => {
      await authorizeForSigning(db, job);
      const result = await (
        await kmsWallets()
      ).signTransaction(job.key_id, unsigned, job.address);
      await db.query(
        "UPDATE payment_jobs SET signed_tx=$2,tx_hash=$3,nonce=$4,updated_at=now() WHERE id=$1",
        [job.id, result.signedTx, result.hash, result.nonce],
      );
      return result;
    });
  } catch (error) {
    // KMS signs only; no broadcast has happened anywhere in this path.
    await failJob(
      job,
      error instanceof AppError ? error.code : "kms_signing_failed",
    );
    return;
  }
  try {
    await transaction(async (db) => {
      // Freeze/revocation can happen between signature commit and first broadcast.
      await authorizeForSigning(db, job);
      await db.query(
        "UPDATE payment_jobs SET broadcast_attempted_at=now() WHERE id=$1 AND broadcast_attempted_at IS NULL",
        [job.id],
      );
    });
  } catch (error) {
    await failJob(
      job,
      error instanceof AppError ? error.code : "broadcast_authorization_failed",
    );
    return;
  }
  try {
    // Signed bytes, local hash, nonce and attempted marker are already committed.
    // This is the only broadcast call. Restart reconciliation never rebroadcasts stored bytes.
    await multibaas.broadcast(signed.signedTx, signed.hash);
    await transaction(async (db) => {
      await db.query(
        "UPDATE payment_jobs SET status='pending',updated_at=now() WHERE id=$1",
        [job.id],
      );
      if (job.invoice_id)
        await db.query("UPDATE invoices SET status='pending' WHERE id=$1", [
          job.invoice_id,
        ]);
    });
  } catch {
    await transaction(async (db) => {
      await db.query(
        "UPDATE payment_jobs SET status='reconciling',error_code='submission_unknown',updated_at=now() WHERE id=$1",
        [job.id],
      );
      if (job.invoice_id)
        await db.query("UPDATE invoices SET status='reconciling' WHERE id=$1", [
          job.invoice_id,
        ]);
    });
  }
}

async function locatePayment(job: any): Promise<string | null> {
  // Real indexed events are discovery hints; receipt validation below remains the source of truth.
  for (let offset = 0; offset < 10000; offset += MULTIBAAS_PAGE_SIZE) {
    const events = await multibaas.request(
      `/events?contract_address=${job.expected_router}&event_signature=${encodeURIComponent("PaymentCompleted(bytes32,bytes32,address,address,address,uint256)")}&limit=${MULTIBAAS_PAGE_SIZE}&offset=${offset}`,
    );
    if (!Array.isArray(events))
      throw new Error("Invalid MultiBaas event response");
    for (const event of events) {
      const fields = Object.fromEntries(
        event.event.inputs.map((v: any) => [v.name, v.value]),
      );
      if (
        fields.invoiceId === job.invoice_id &&
        String(fields.payer).toLowerCase() === job.address
      )
        return event.transaction.txHash;
    }
    if (events.length < MULTIBAAS_PAGE_SIZE) break;
  }
  return null;
}
export function matchingPaymentLog(
  logs: any[],
  job: {
    invoice_id: string;
    merchant_id: string;
    address: string;
    recipient: string;
    amount: string;
  },
  paymentAddress: string,
  tokenAddress: string,
) {
  for (const log of logs) {
    if (log.removed || String(log.address).toLowerCase() !== paymentAddress)
      continue;
    let parsed;
    try {
      parsed = paymentABI.parseLog(log);
    } catch {
      continue;
    }
    if (
      parsed &&
      parsed.args.invoiceId === job.invoice_id &&
      parsed.args.merchantId === merchantBytes32(job.merchant_id) &&
      String(parsed.args.payer).toLowerCase() === job.address &&
      String(parsed.args.recipient).toLowerCase() === job.recipient &&
      String(parsed.args.token).toLowerCase() === tokenAddress &&
      parsed.args.amount === BigInt(job.amount)
    )
      return log;
  }
  return null;
}
function verifyNetwork(job: any) {
  assertPaymentModel(job);
  routerSnapshot(job.expected_router, job.expected_router_label);
  if (
    job.expected_chain !== config.CHAIN_ID ||
    job.expected_token !== config.TOKEN_ADDRESS
  )
    throw new AppError(
      "job_network_mismatch",
      "Job belongs to a different deployment.",
    );
}
async function findReceipt(
  job: any,
): Promise<{ txHash: string; receipt: any } | null> {
  let originalError: unknown;
  if (job.tx_hash) {
    try {
      const receipt = await multibaas.receipt(job.tx_hash);
      if (receipt?.data?.blockNumber) return { txHash: job.tx_hash, receipt };
    } catch (error) {
      originalError = error;
    }
  }
  // Direct AWS signing preserves the original hash before broadcast. Indexed
  // invoice events can also discover an independently replaced payment transaction.
  const candidates: string[] = [];
  if (job.kind === "payment") {
    try {
      const indexed = await locatePayment(job);
      if (indexed) candidates.push(indexed);
    } catch (error) {
      originalError ??= error;
    }
  }
  for (const txHash of new Set(candidates)) {
    if (txHash === job.tx_hash) continue;
    try {
      const receipt = await multibaas.receipt(txHash);
      if (receipt?.data?.blockNumber) return { txHash, receipt };
    } catch (error) {
      originalError ??= error;
    }
  }
  if (originalError) throw originalError;
  return null;
}
async function reconcile(job: any) {
  verifyNetwork(job);
  await multibaas.validateChain();
  if (job.status === "confirmed") {
    await validateAcceptedSettlement(job);
    return;
  }
  const found = await findReceipt(job);
  if (!found) return;
  const { txHash, receipt } = found;
  const data = receipt.data;
  const chainTransaction = await multibaas.transaction(txHash);
  if (
    String(chainTransaction.data?.hash).toLowerCase() !==
      txHash.toLowerCase() ||
    !matchesJobTransaction(
      {
        ...job,
        merchant_key: job.merchant_id
          ? merchantBytes32(job.merchant_id)
          : undefined,
      },
      chainTransaction.data,
      chainTransaction.from,
    )
  )
    throw new AppError(
      "transaction_mismatch",
      "Transaction does not match the original signed operation.",
      502,
    );
  if (String(data.transactionHash).toLowerCase() !== txHash.toLowerCase())
    throw new Error("Receipt transaction mismatch");
  const block = await multibaas.block(data.blockNumber);
  if (block.hash !== data.blockHash) return;
  if (Number(block.timestamp) * 1000 < job.created_at.getTime() - 1000)
    throw new AppError(
      "transaction_predates_job",
      "Transaction predates this operation.",
      502,
    );
  const head = await multibaas.head();
  if (
    BigInt(head.number) - BigInt(data.blockNumber) + 1n <
    BigInt(config.CONFIRMATIONS)
  )
    return;
  if (BigInt(data.status) !== 1n) {
    if (job.status !== "confirmed") await failJob(job, "transaction_reverted");
    return;
  }
  let log: any = null;
  if (job.kind === "approval") {
    const matched = data.logs.some((entry: any) => {
      if (
        entry.removed ||
        String(entry.address).toLowerCase() !== job.expected_token
      )
        return false;
      try {
        const parsed = approvalABI.parseLog(entry);
        return (
          parsed &&
          String(parsed.args.owner).toLowerCase() === job.address &&
          String(parsed.args.spender).toLowerCase() === job.expected_router &&
          parsed.args.value === BigInt(job.amount)
        );
      } catch {
        return false;
      }
    });
    if (!matched)
      throw new AppError(
        "approval_receipt_mismatch",
        "Receipt does not contain the exact requested allowance.",
        502,
      );
  }
  if (job.kind === "payment") {
    log = matchingPaymentLog(
      data.logs,
      job,
      job.expected_router,
      job.expected_token,
    );
    if (!log)
      throw new AppError(
        "receipt_mismatch",
        "The receipt does not contain the expected payment.",
        502,
      );
  }
  const isLoyalty =
    job.kind === "payment" &&
    routerSnapshot(job.expected_router, job.expected_router_label).kind ===
      "loyalty";
  const loyaltyEvents = isLoyalty
    ? validateLoyaltyReceipt(
        data.logs,
        job,
        await loyaltyPaymentState(
          job.address,
          job.invoice_id,
          { number: BigInt(data.blockNumber).toString(), hash: data.blockHash },
          job.expected_router,
          job.expected_router_label,
        ),
      )
    : [];
  const rewardEvents =
    job.kind === "payment" && !isLoyalty
      ? validateRewardReceipt(data.logs, job)
      : [];
  await transaction(async (db) => {
    const current = (
      await db.query("SELECT status FROM payment_jobs WHERE id=$1 FOR UPDATE", [
        job.id,
      ])
    ).rows[0];
    if (current.status === "confirmed") return;
    if (job.kind === "payment") {
      await db.query(
        `INSERT INTO receipts(invoice_id,tx_hash,log_index,block_number,block_hash,payer,recipient,amount,reward_model,gross_amount,discount_amount,reward_id,points_redeemed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(invoice_id) DO NOTHING`,
        [
          job.invoice_id,
          txHash,
          BigInt(log.logIndex).toString(),
          BigInt(data.blockNumber).toString(),
          data.blockHash,
          job.address,
          job.recipient,
          job.amount,
          job.reward_model ?? "percentage",
          job.gross_amount ?? job.amount,
          job.discount_amount ?? "0",
          job.reward_id ?? null,
          job.points_redeemed ?? "0",
        ],
      );
      await db.query(
        "UPDATE policies SET reserved=reserved-$2,spent=spent+$2 WHERE account_id=$1 AND (id=$3 OR ($3::uuid IS NULL AND card_id IS NULL))",
        [job.account_id, job.amount, job.policy_id ?? null],
      );
      await db.query(`UPDATE invoices SET status='confirmed' WHERE id=$1`, [
        job.invoice_id,
      ]);
    }
    for (const event of rewardEvents)
      await db.query(
        "INSERT INTO reward_receipt_events(chain_id,tx_hash,log_index,router_address,reward_id,kind,invoice_id,block_number,block_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
        [
          job.expected_chain,
          txHash,
          event.logIndex,
          job.expected_router,
          event.rewardId,
          event.kind,
          job.invoice_id,
          BigInt(data.blockNumber).toString(),
          data.blockHash,
        ],
      );
    for (const event of loyaltyEvents)
      await db.query(
        "INSERT INTO loyalty_receipt_events(chain_id,router_address,tx_hash,log_index,invoice_id,wallet_id,merchant_id,kind,block_number,block_hash)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
        [
          job.expected_chain,
          job.expected_router,
          txHash,
          event.logIndex,
          job.invoice_id,
          job.wallet_id,
          job.merchant_id,
          event.kind,
          BigInt(data.blockNumber).toString(),
          data.blockHash,
        ],
      );
    await consumePoints(db, job);
    await consumeRewardReservation(db, job);
    await db.query(
      `UPDATE payment_jobs SET status='confirmed',tx_hash=$2,block_hash=$3,block_number=$4,error_code=NULL,updated_at=now() WHERE id=$1`,
      [job.id, txHash, data.blockHash, BigInt(data.blockNumber).toString()],
    );
  });
}
/** Background pacing only; submit() still revalidates every accepted wallet nonce immediately before a new signature. */
export async function loadDuePaymentJobs() {
  return (
    await pool.query(`SELECT j.*,w.address,w.key_id,w.provider,i.merchant_id,i.recipient,i.expires_at,i.chain_id,i.token
    FROM payment_jobs j JOIN wallets w ON w.account_id=j.account_id AND (w.id=j.wallet_id OR (j.wallet_id IS NULL AND w.card_id IS NULL))
    LEFT JOIN invoices i ON i.id=j.invoice_id
    WHERE (j.status='queued' AND (j.error_code IS NULL OR j.updated_at<=now()-interval '30 seconds'))
      OR (j.status IN ('submitting','pending','reconciling') AND j.updated_at<=now()-interval '12 seconds')
      OR (j.status='confirmed' AND j.updated_at<=now()-interval '5 minutes')
    ORDER BY CASE WHEN j.status='queued' THEN 0 WHEN j.status='confirmed' THEN 2 ELSE 1 END,j.updated_at LIMIT 100`)
  ).rows;
}
export async function tick(
  shouldStop: () => boolean = () => false,
  onProgress: () => Promise<void> = async () => {},
) {
  if (shouldStop()) return;
  // A session advisory lock ensures only one worker signs/reconciles, including across server processes.
  const lock = await pool.connect();
  let ownsLock = false;
  try {
    const obtained = await lock.query(
      "SELECT pg_try_advisory_lock(830146271) AS locked",
    );
    ownsLock = obtained.rows[0].locked;
    await onProgress();
    if (!ownsLock || shouldStop()) return;
    await provisionCardWallets(undefined, shouldStop);
    if (shouldStop()) return;
    await processTestFunding(shouldStop, onProgress);
    if (shouldStop()) return;
    await processLoyaltyRefunds(shouldStop, onProgress);
    if (!hasPayments || shouldStop()) return;
    await onProgress();
    await provisionMerchants(shouldStop);
    if (shouldStop()) return;
    await onProgress();
    await processRewardCampaigns(shouldStop);
    if (shouldStop()) return;
    const rows = await loadDuePaymentJobs();
    for (const job of rows) {
      if (shouldStop()) break;
      await onProgress();
      try {
        if (job.status === "queued")
          await withWalletLock(job.address, () => submit(job));
        else await reconcile(job);
      } catch (err) {
        await pool.query("UPDATE payment_jobs SET error_code=$2 WHERE id=$1", [
          job.id,
          err instanceof AppError ? err.code : "reconciliation_unavailable",
        ]);
      }
      await pool.query("UPDATE payment_jobs SET updated_at=now() WHERE id=$1", [
        job.id,
      ]);
    }
  } finally {
    try {
      if (ownsLock) await lock.query("SELECT pg_advisory_unlock(830146271)");
    } finally {
      lock.release();
    }
  }
}
export async function runWorker() {
  let stopping = false;
  const controller = new AbortController();
  const stop = () => {
    stopping = true;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await pool.query("SELECT 1");
    await recordWorkerProgress();
    while (!stopping) {
      try {
        await tick(() => stopping, recordWorkerProgress);
      } catch (error) {
        console.error(
          "Payment worker cycle failed:",
          error instanceof Error ? error.name : "unknown",
        );
      }
      if (!stopping)
        try {
          await delay(3000, undefined, { signal: controller.signal });
        } catch (error) {
          if (!stopping) throw error;
        }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await pool.end();
    } finally {
      await clearWorkerProgress();
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runWorker();
