import { config, hasRewards, hasCollectibles, hasLoyalty } from "./config.js";
import { AppError } from "./errors.js";
export type RouterKind = "legacy" | "rewards" | "collectibles" | "loyalty";
export function paymentRouter(
  kind: RouterKind = hasLoyalty
    ? "loyalty"
    : hasCollectibles
      ? "collectibles"
      : hasRewards
        ? "rewards"
        : "legacy",
) {
  const address =
    kind === "loyalty"
      ? config.LOYALTY_PAYMENT_ADDRESS
      : kind === "collectibles"
        ? config.COLLECTIBLE_PAYMENT_ADDRESS
        : kind === "rewards"
          ? config.REWARD_PAYMENT_ADDRESS
          : config.PAYMENT_ADDRESS;
  if (
    !address ||
    (kind === "loyalty" && !hasLoyalty) ||
    (kind === "rewards" && !hasRewards) ||
    (kind === "collectibles" && !hasCollectibles)
  )
    throw new AppError(
      "payments_unconfigured",
      "This payment router is not configured.",
      503,
    );
  return {
    kind,
    address,
    label:
      kind === "loyalty"
        ? config.LOYALTY_PAYMENT_CONTRACT
        : kind === "collectibles"
          ? config.COLLECTIBLE_PAYMENT_CONTRACT
          : kind === "rewards"
            ? config.REWARD_PAYMENT_CONTRACT
            : config.PAYMENT_CONTRACT,
  };
}
export function routerSnapshot(
  address: string | null | undefined,
  label?: string | null,
) {
  const resolved = address ?? config.PAYMENT_ADDRESS;
  if (resolved === config.PAYMENT_ADDRESS && resolved)
    return {
      kind: "legacy" as const,
      address: resolved,
      label: label ?? config.PAYMENT_CONTRACT,
    };
  if (resolved === config.REWARD_PAYMENT_ADDRESS && resolved)
    return {
      kind: "rewards" as const,
      address: resolved,
      label: label ?? config.REWARD_PAYMENT_CONTRACT,
    };
  if (resolved === config.COLLECTIBLE_PAYMENT_ADDRESS && resolved)
    return {
      kind: "collectibles" as const,
      address: resolved,
      label: label ?? config.COLLECTIBLE_PAYMENT_CONTRACT,
    };
  if (resolved === config.LOYALTY_PAYMENT_ADDRESS && resolved)
    return {
      kind: "loyalty" as const,
      address: resolved,
      label: label ?? config.LOYALTY_PAYMENT_CONTRACT,
    };
  throw new AppError(
    "job_network_mismatch",
    "The stored payment router is not configured. Restore its original deployment.",
    503,
  );
}

/** A zero token transfer is valid only for a fully credit-covered V2 purchase. */
export function assertPaymentModel(job: any) {
  if (job.kind !== "payment") return;
  const amount = BigInt(job.amount);
  if (amount > 0n) return;
  const router = routerSnapshot(job.expected_router, job.expected_router_label);
  if (
    amount < 0n ||
    (amount === 0n &&
      (!(
        (router.kind === "collectibles" &&
          job.reward_model === "credit" &&
          job.reward_id) ||
        (router.kind === "loyalty" &&
          job.reward_model === "points" &&
          BigInt(job.points_redeemed ?? 0) > 0n)
      ) ||
        BigInt(job.gross_amount ?? 0) <= 0n ||
        BigInt(job.discount_amount ?? 0) !== BigInt(job.gross_amount)))
  )
    throw new AppError(
      "invalid_payment_amount",
      "Only an eligible credit purchase may have a zero token charge.",
      409,
    );
}
