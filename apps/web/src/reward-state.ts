import type { Reward } from "./api";

export function rewardStatus(
  reward: Reward,
  now = Date.now(),
): Reward["status"] {
  if (reward.status === "available" && Date.parse(reward.expiresAt) < now)
    return "expired";
  return reward.status;
}
export function collectibleKey(reward: Reward) {
  return (
    reward.collectionKey ??
    `${reward.contractAddress ?? "legacy"}:${reward.tokenId ?? reward.id}`
  );
}
export function rewardCredit(reward: Reward): string | null {
  if (
    reward.rewardType !== "credit" ||
    !/^\d+$/.test(reward.remainingCredit ?? "")
  )
    return null;
  return reward.remainingCredit!;
}
export function collectibleImage(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.hostname === "main.d21bivg674x6ke.amplifyapp.com" &&
      /^\/nft-art\/[0-9a-f]{20}\/[0-2]\.jpg$/.test(url.pathname) &&
      !url.search &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function rewardActivity(rewards: Reward[]) {
  return rewards
    .flatMap((reward) => {
      const key = collectibleKey(reward);
      if (Array.isArray(reward.events)) {
        return reward.events
          .filter(
            (event) =>
              event.txHash && Number.isFinite(Date.parse(event.createdAt)),
          )
          .map((event) => ({
            id: `${key}:${event.id}`,
            label:
              event.kind === "earned"
                ? reward.rewardType === "credit"
                  ? "Credit earned"
                  : "Reward earned"
                : reward.rewardType === "credit"
                  ? "Credit redeemed"
                  : "Reward redeemed",
            merchant: reward.merchantName,
            date: event.createdAt,
            url: event.explorerUrl,
            amount:
              event.kind === "redeemed"
                ? event.discountAmount
                : (reward.creditAmount ?? undefined),
          }));
      }
      const entries: {
        id: string;
        label: string;
        merchant: string;
        date: string;
        url: string | null;
        amount?: string;
      }[] = [];
      if (
        reward.earnedTxHash &&
        reward.earnedAt &&
        Number.isFinite(Date.parse(reward.earnedAt))
      )
        entries.push({
          id: `${key}:earned`,
          label: "Reward earned",
          merchant: reward.merchantName,
          date: reward.earnedAt,
          url: reward.earnedExplorerUrl,
        });
      if (
        reward.status === "used" &&
        reward.redeemedTxHash &&
        reward.redeemedAt &&
        Number.isFinite(Date.parse(reward.redeemedAt))
      )
        entries.push({
          id: `${key}:redeemed`,
          label: "Reward redeemed",
          merchant: reward.merchantName,
          date: reward.redeemedAt,
          url: reward.redeemedExplorerUrl,
        });
      return entries;
    })
    .sort(
      (a, b) =>
        Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id),
    );
}
