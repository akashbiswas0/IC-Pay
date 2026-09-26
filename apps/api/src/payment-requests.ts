import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { transaction } from "./db.js";
import { AppError } from "./errors.js";
import { paymentRouter, type RouterKind } from "./payment-router.js";
import { requireAwsWallet } from "./wallets.js";

export function remainingPolicyAllowance(total: string, spent: string): bigint {
  const remaining = BigInt(total) - BigInt(spent);
  return remaining > 0n ? remaining : 0n;
}

export async function requestAllowance(
  accountId: string,
  amount: string,
  requestId?: string,
  cardId?: string,
  routerKind?: RouterKind,
) {
  const router = paymentRouter(routerKind);
  return transaction(async (db) => {
    await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    let card: any = null;
    if (cardId) {
      card = (
        await db.query(
          "SELECT *,linked_at::text generation FROM cards WHERE id=$1 AND account_id=$2 AND active AND removed_at IS NULL FOR UPDATE",
          [cardId, accountId],
        )
      ).rows[0];
      if (!card)
        throw new AppError(
          "card_unavailable",
          "Choose an active linked card.",
          409,
        );
    }
    const wallet = (
      await db.query(
        "SELECT * FROM wallets WHERE account_id=$1 AND card_id IS NOT DISTINCT FROM $2::uuid AND status='ready' FOR UPDATE",
        [accountId, cardId ?? null],
      )
    ).rows[0];
    if (!wallet)
      throw new AppError("wallet_required", "Create a wallet first.", 409);
    requireAwsWallet(wallet);
    if (requestId) {
      const previous = (
        await db.query(
          "SELECT * FROM payment_jobs WHERE account_id=$1 AND client_request_id=$2",
          [accountId, requestId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.kind !== "approval" ||
          previous.wallet_id !== wallet.id ||
          previous.amount !== amount ||
          previous.expected_chain !== config.CHAIN_ID ||
          previous.expected_token !== config.TOKEN_ADDRESS ||
          (routerKind !== undefined &&
            previous.expected_router !== router.address)
        )
          throw new AppError(
            "request_conflict",
            "This allowance request already has different terms.",
            409,
          );
        return {
          id: previous.id,
          status: previous.status,
          routerAddress: previous.expected_router,
        };
      }
    }
    const active = (
      await db.query(
        "SELECT * FROM payment_jobs WHERE wallet_id=$1 AND kind='approval' AND status IN ('queued','submitting','pending','reconciling')",
        [wallet.id],
      )
    ).rows[0];
    if (active)
      throw new AppError(
        "approval_pending",
        "An allowance request is already being confirmed. Check its progress before starting another.",
        409,
      );
    const id = randomUUID();
    await db.query(
      "INSERT INTO payment_jobs(id,account_id,kind,amount,expected_chain,expected_token,expected_router,client_request_id,wallet_id,card_id,card_hash,card_linked_at,expected_router_label) VALUES($1,$2,'approval',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        id,
        accountId,
        amount,
        config.CHAIN_ID,
        config.TOKEN_ADDRESS,
        router.address,
        requestId ?? null,
        wallet.id,
        cardId ?? null,
        card?.card_hash ?? null,
        card?.generation ?? null,
        router.label,
      ],
    );
    return { id, status: "queued", routerAddress: router.address };
  });
}

export async function requestInvoice(
  merchantId: string,
  amount: string,
  description: string,
  requestId?: string,
  useReward = false,
  routerKind?: RouterKind,
  maxPoints: string | null = null,
) {
  const router = paymentRouter(routerKind);
  if (routerKind && routerKind !== "loyalty" && !useReward)
    throw new AppError(
      "voucher_redemption_required",
      "Earlier routers can only redeem an existing voucher.",
      400,
    );
  if (router.kind !== "loyalty" && maxPoints !== null)
    throw new AppError(
      "invalid_points_limit",
      "Point limits apply only to the loyalty router.",
      400,
    );
  if (useReward && router.kind === "legacy")
    throw new AppError(
      "rewards_unconfigured",
      "Reward payments are not configured.",
      503,
    );
  return transaction(async (db) => {
    const merchant = (
      await db.query(
        "SELECT * FROM merchants WHERE id=$1 AND enabled FOR UPDATE",
        [merchantId],
      )
    ).rows[0];
    if (!merchant)
      throw new AppError(
        "merchant_disabled",
        "This merchant is disabled.",
        403,
      );
    if (requestId) {
      const previous = (
        await db.query(
          "SELECT i.*,j.tx_hash,j.error_code FROM invoices i LEFT JOIN payment_jobs j ON j.invoice_id=i.id WHERE i.merchant_id=$1 AND i.client_request_id=$2",
          [merchantId, requestId],
        )
      ).rows[0];
      if (previous) {
        if (
          (previous.gross_amount ?? previous.amount) !== amount ||
          (previous.use_reward ?? false) !== useReward ||
          previous.description !== description ||
          previous.chain_id !== config.CHAIN_ID ||
          previous.token !== config.TOKEN_ADDRESS ||
          (previous.max_points ?? null) !== maxPoints ||
          (routerKind !== undefined &&
            previous.router_address !== router.address)
        )
          throw new AppError(
            "request_conflict",
            "This payment request already has different terms.",
            409,
          );
        return previous;
      }
    }
    const id = `0x${randomBytes(32).toString("hex")}`;
    const expires = new Date(Math.floor(Date.now() / 1000) * 1000 + 180000);
    return (
      await db.query(
        "INSERT INTO invoices(id,merchant_id,recipient,amount,token,chain_id,description,expires_at,client_request_id,router_address,router_label,gross_amount,use_reward,scan_version,reward_model,max_points) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$4,$12,$13,$14,$15) RETURNING *",
        [
          id,
          merchantId,
          merchant.recipient,
          amount,
          config.TOKEN_ADDRESS,
          config.CHAIN_ID,
          description,
          expires,
          requestId ?? null,
          router.address,
          router.label,
          useReward,
          router.kind === "loyalty" ? 3 : router.kind === "legacy" ? 1 : 2,
          router.kind === "loyalty"
            ? "points"
            : router.kind === "collectibles"
              ? "credit"
              : "percentage",
          maxPoints,
        ],
      )
    ).rows[0];
  });
}
