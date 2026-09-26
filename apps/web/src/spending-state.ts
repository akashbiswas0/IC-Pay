import type { Policy } from "./api";
import { formatAmount, parseAmount } from "./money";
export type SpendingDraft = {
  maxPointsPerPayment: string;
  merchantScope: "selected" | "all";
  useRewards: boolean;
  perPayment: string;
  total: string;
  expiry: string;
  selected: string[];
};
export const spendingDraftKey = (base: string, account: string) =>
  `suica.spending-draft:${base}:${account}`;
export function draftMatchesPolicy(
  draft: SpendingDraft,
  policy: Policy | null,
  decimals: number,
): boolean {
  if (!policy) return false;
  try {
    return (
      parseAmount(draft.perPayment, decimals) === policy.perPaymentLimit &&
      parseAmount(draft.total, decimals) === policy.totalLimit &&
      draft.useRewards === (policy.useRewards ?? false) &&
      parsePointsLimit(draft.maxPointsPerPayment) ===
        (policy.maxPointsPerPayment ?? null) &&
      draft.merchantScope === (policy.merchantScope ?? "selected") &&
      Math.floor(Date.parse(draft.expiry) / 60000) ===
        Math.floor(Date.parse(policy.expiresAt) / 60000) &&
      JSON.stringify([...new Set(draft.selected)].sort()) ===
        JSON.stringify([...new Set(policy.merchantIds ?? [])].sort())
    );
  } catch {
    return false;
  }
}
export function decodeSpendingDraft(text: string | null): SpendingDraft | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      (value.merchantScope !== undefined &&
        value.merchantScope !== "selected" &&
        value.merchantScope !== "all") ||
      (value.useRewards !== undefined &&
        typeof value.useRewards !== "boolean") ||
      (value.maxPointsPerPayment !== undefined &&
        (typeof value.maxPointsPerPayment !== "string" ||
          value.maxPointsPerPayment.length > 78)) ||
      ![value.perPayment, value.total, value.expiry].every(
        (v) => typeof v === "string" && v.length <= 100,
      ) ||
      !Array.isArray(value.selected) ||
      value.selected.length > 100 ||
      (value.merchantScope === "all" && value.selected.length !== 0) ||
      !value.selected.every(
        (id: unknown) => typeof id === "string" && id.length <= 100,
      )
    )
      return null;
    return {
      maxPointsPerPayment: value.maxPointsPerPayment ?? "",
      merchantScope: value.merchantScope ?? "selected",
      useRewards: value.useRewards ?? false,
      perPayment: value.perPayment,
      total: value.total,
      expiry: value.expiry,
      selected: value.selected,
    };
  } catch {
    return null;
  }
}
export function formFromPolicy(
  policy: Policy | null,
  decimals: number,
): SpendingDraft {
  return {
    maxPointsPerPayment: policy?.maxPointsPerPayment ?? "",
    merchantScope: policy?.merchantScope ?? "selected",
    useRewards: policy?.useRewards ?? false,
    perPayment: policy
      ? formatAmount(policy.perPaymentLimit, decimals).replaceAll(",", "")
      : "",
    total: policy
      ? formatAmount(policy.totalLimit, decimals).replaceAll(",", "")
      : "",
    expiry: policy
      ? new Date(
          new Date(policy.expiresAt).getTime() -
            new Date(policy.expiresAt).getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16)
      : "",
    selected: policy?.merchantIds ?? [],
  };
}

/** A blank cap explicitly allows automatic use; zero explicitly preserves points. */
export function parsePointsLimit(value: string): string | null {
  const cleaned = value.trim();
  if (cleaned === "") return null;
  if (!/^\d{1,78}$/.test(cleaned) || BigInt(cleaned) >= 1n << 256n)
    throw new Error(
      "Enter a whole number of points, or leave blank to use available points.",
    );
  return BigInt(cleaned).toString();
}

/** A new edit requires fresh consent for all current and future participating shops. */
export function newSpendingDraft(
  policy: Policy | null,
  decimals: number,
): SpendingDraft {
  return {
    ...formFromPolicy(policy, decimals),
    merchantScope: "all",
    selected: [],
  };
}
