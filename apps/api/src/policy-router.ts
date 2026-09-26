import type { PoolClient } from "pg";
import { config } from "./config.js";
import { multibaas } from "./multibaas.js";
import { routerSnapshot } from "./payment-router.js";
/** Prior consent is usable only for a real earlier voucher redemption, never new rewards issuance. */
export async function allowsPolicyRouter(
  db: Pick<PoolClient, "query">,
  policy: any,
  routerAddress: string,
  voucherRedemption: boolean,
) {
  if ((policy.router_address ?? config.PAYMENT_ADDRESS) === routerAddress)
    return true;
  if (
    !voucherRedemption ||
    !policy.use_rewards ||
    !["rewards", "collectibles"].includes(routerSnapshot(routerAddress).kind)
  )
    return false;
  return Boolean(
    (
      await db.query(
        "SELECT 1 FROM policy_router_consents WHERE policy_id=$1 AND router_address=$2",
        [policy.id, routerAddress],
      )
    ).rowCount,
  );
}
export async function validateRetainedAllowance(
  policy: any,
  walletAddress: string,
  routerAddress: string,
  amount: string,
) {
  if ((policy.router_address ?? config.PAYMENT_ADDRESS) === routerAddress)
    return true;
  const allowance = BigInt(
    await multibaas.allowance(walletAddress, routerAddress),
  );
  return allowance > 0n && allowance >= BigInt(amount);
}
