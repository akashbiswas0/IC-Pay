import { formatAmount } from "./money";

export type LoyaltyProgram = {
  enabled: boolean;
  earnBps: number;
  minPurchase: string;
  maxPointsPerPurchase: string;
  validitySeconds: number;
  version: number;
};
export type LoyaltyBalance = {
  id: string;
  cardId: string | null;
  walletAddress: string;
  merchantId: string;
  merchantName: string;
  merchantEnabled: boolean;
  availablePoints: string;
  reservedPoints: string;
  spendablePoints: string;
  fractionNumerator: string;
  fractionDenominator: string;
  debtUnits?: string;
  expiresAt: string | null;
  program: LoyaltyProgram | null;
};
export type LoyaltyEvent = {
  id: string;
  cardId: string | null;
  walletAddress: string;
  merchantId: string;
  merchantName: string;
  kind: "earned" | "redeemed" | "expired" | "refunded" | "reversed";
  points: string;
  pointsUnits?: string;
  debtRepaidUnits?: string;
  tokenAmount: string | null;
  invoiceId: string | null;
  createdAt: string;
  txHash: string;
  explorerUrl: string | null;
};
export type LoyaltyResponse = {
  status: "available" | "pending_setup" | "unavailable";
  routerAddress: string | null;
  token: { address: string; symbol: string; decimals: number };
  pointValue: string;
  balances: LoyaltyBalance[] | null;
  history: LoyaltyEvent[] | null;
};
export type LoyaltyProgramResponse = {
  status: LoyaltyResponse["status"];
  program: LoyaltyProgram | null;
  operation: {
    id: string;
    status: string;
    txHash: string | null;
    errorCode: string | null;
  } | null;
  summary: {
    outstandingPoints: string;
    outstandingUnits?: string;
    earnedPoints: string;
    redeemedPoints: string;
    refundedPoints: string;
    customerWallets: number;
    expiredPoints?: string;
    reversedPoints?: string;
    earnedUnits?: string;
    expiredUnits?: string;
    refundedUnits?: string;
    reversedUnits?: string;
  } | null;
};

export const formatPoints = (value: string) => formatAmount(value, 0);

/** Progress is display-only; all spendable amounts remain exact integer strings. */
export function pointProgress(
  numerator: string,
  denominator: string,
): { percent: number; label: string } | null {
  if (!/^\d+$/.test(numerator) || !/^\d+$/.test(denominator)) return null;
  const n = BigInt(numerator),
    d = BigInt(denominator);
  if (d === 0n || n >= d) return null;
  const hundredths = (n * 10000n) / d;
  return {
    percent: Number(hundredths) / 100,
    label: `${Number(hundredths) / 100}% toward your next point`,
  };
}

export function loyaltyEventLabel(kind: LoyaltyEvent["kind"]): string {
  return (
    {
      earned: "Points earned",
      redeemed: "Points used",
      expired: "Points expired",
      refunded: "Points restored",
      reversed: "Earnings reversed",
    }[kind] ?? "Points activity"
  );
}
