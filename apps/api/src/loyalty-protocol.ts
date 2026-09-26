import { Interface } from "ethers";
import { z } from "zod";
export const wholePointsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => {
    try {
      return BigInt(v) < 1n << 256n;
    } catch {
      return false;
    }
  }, "Point quantity exceeds uint256");
export const loyaltyABI = new Interface([
  "function campaigns(bytes32) view returns(bool enabled,uint256 minPurchase,uint16 earnBps,uint256 maxEarnPoints,uint64 validitySeconds,uint64 version)",
  "function pointUnit() view returns(uint256)",
  "function pointsBalance(address,bytes32) view returns(uint256 availablePoints,uint256 fractionalUnits,uint256 debtUnits,uint64 nextExpiryAt)",
  "function pointsSummary(address,bytes32) view returns(uint256 earnedUnits,uint256 redeemedPoints,uint256 expiredUnits,uint256 restoredUnits,uint256 reversedUnits,uint256 debtUnits,uint256 activeUnits)",
  "function walletMerchantIds(address,uint256,uint256) view returns(bytes32[] merchantIds,uint256 total)",
  "function merchantWallets(bytes32,uint256,uint256) view returns(address[] wallets,uint256 total)",
  "function merchants(bytes32) view returns(address recipient,bool enabled)",
  "function payments(address,bytes32) view returns(bytes32 merchantId,address recipient,uint256 grossAmount,uint256 netAmount,uint256 redeemedPoints,uint256 earnedUnits,uint256 debtRepaid,uint64 earnedExpiresAt,uint64 campaignVersion,uint16 earnBps,uint256 maxEarnPoints,uint64 createdAt,bool refunded)",
  "function pay(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt)",
  "function payWithPoints(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt,uint256 pointsToRedeem)",
  "function refund(bytes32 invoiceId,address payer)",
  "event PointsEarned(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,uint256 tokenAmount,uint256 earnedUnits,uint256 debtRepaid,uint64 expiresAt,uint64 campaignVersion)",
  "event PointsRedeemed(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,uint256 points,uint256 discount)",
  "event PointsExpired(bytes32 indexed merchantId,address indexed payer,uint256 expiredUnits)",
  "event PaymentRefunded(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,address recipient,address token,uint256 amount,uint256 pointsRestoredUnits,uint256 earnedReversedUnits,uint256 debtUnits)",
]);
export function pointUnit(decimals: number) {
  return 10n ** BigInt(decimals);
}
export function limitedPoints(
  available: string,
  gross: string,
  unit: bigint,
  ...limits: (string | null | undefined)[]
) {
  let chosen = BigInt(available),
    affordable = BigInt(gross) / unit;
  if (chosen > affordable) chosen = affordable;
  for (const limit of limits)
    if (limit != null && BigInt(limit) < chosen) chosen = BigInt(limit);
  return chosen;
}
