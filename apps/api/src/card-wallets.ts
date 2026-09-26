import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { AppError } from "./errors.js";
import { config, hasTokenReads, hasPayments } from "./config.js";
import { paymentRouter } from "./payment-router.js";
import { multibaas } from "./multibaas.js";
import { readDisplayBalance } from "./display-balance.js";
import { remainingPolicyAllowance } from "./payment-requests.js";

type DB = Pick<PoolClient, "query">;
export async function resolveCard(
  accountId: string,
  cardId?: string,
  db: DB = pool,
  active = false,
) {
  const rows = (
    await db.query(
      "SELECT *,linked_at::text generation FROM cards WHERE account_id=$1 AND removed_at IS NULL AND ($2::uuid IS NULL OR id=$2) ORDER BY linked_at,id",
      [accountId, cardId ?? null],
    )
  ).rows;
  if (rows.length !== 1)
    throw new AppError(
      cardId ? "card_unavailable" : "choose_card",
      cardId ? "This card is no longer linked." : "Choose a linked Suica card.",
      cardId ? 404 : 409,
    );
  if (active && !rows[0].active)
    throw new AppError("card_frozen", "Unfreeze this card first.", 409);
  return rows[0];
}
export function publicPolicy(row: any) {
  return row
    ? {
        enabled: row.enabled,
        perPaymentLimit: row.per_payment_limit,
        totalLimit: row.total_limit,
        spent: row.spent,
        reserved: row.reserved,
        expiresAt: row.expires_at.toISOString(),
        merchantScope: row.merchant_scope ?? "selected",
        merchantIds:
          row.merchant_scope === "all" ? [] : (row.merchant_ids ?? []),
        useRewards: row.use_rewards ?? false,
        maxPointsPerPayment: row.max_points_per_payment ?? null,
        routerAddress: row.router_address ?? config.PAYMENT_ADDRESS ?? null,
        requiresApproval:
          hasPayments &&
          (row.router_address ?? config.PAYMENT_ADDRESS) !==
            paymentRouter().address,
      }
    : null;
}
export async function readWallet(row: any) {
  if (!row?.address || row.status !== "ready") return null;
  let balance: string | null = null;
  let balanceStatus = "pending_setup";
  let balanceSource: "multibaas" | "rpc" | null = null;
  if (hasTokenReads) {
    try {
      const result = await readDisplayBalance(row.address);
      balance = result.balance;
      balanceSource = result.source;
      balanceStatus = "available";
    } catch {
      balanceStatus = "unavailable";
    }
  }
  return {
    address: row.address,
    balance,
    balanceStatus,
    balanceSource,
    symbol: config.TOKEN_SYMBOL,
    name: config.TOKEN_NAME,
    onchainSymbol: config.TOKEN_ONCHAIN_SYMBOL,
    decimals: config.TOKEN_DECIMALS,
    chainId: config.CHAIN_ID ?? "",
  };
}
export async function allowanceSufficient(
  wallet: any,
  policy: any,
): Promise<boolean | null> {
  if (!wallet?.address || wallet.status !== "ready" || !policy || !hasPayments)
    return null;
  try {
    await multibaas.validateChain();
    const active = paymentRouter();
    if ((policy.router_address ?? config.PAYMENT_ADDRESS) !== active.address)
      return false;
    const allowance = await multibaas.allowance(wallet.address, active.address);
    return (
      BigInt(allowance) >=
      remainingPolicyAllowance(policy.total_limit, policy.spent)
    );
  } catch {
    return null;
  }
}
