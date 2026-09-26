import { Interface } from "ethers";

const calls = new Interface([
  "function approve(address spender,uint256 amount)",
  "function payWithPoints(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt,uint256 pointsToRedeem)",
  "function pay(bytes32 invoiceId,bytes32 merchantId,uint256 amount,uint256 expiresAt)",
  "function payWithReward(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt,uint256 voucherId)",
]);
export interface ReconciliationJob {
  kind: string;
  address: string;
  nonce: string | null;
  expected_chain: string;
  expected_token: string;
  expected_router: string;
  amount: string;
  gross_amount?: string;
  reward_id?: string | null;
  points_redeemed?: string;
  invoice_id?: string;
  merchant_key?: string;
  expires_at?: Date;
}

/** Accept only the original operation, regardless of its fee-replacement hash. */
export function matchesJobTransaction(
  job: ReconciliationJob,
  tx: {
    chainId?: string;
    nonce?: string;
    to?: string;
    input?: string;
    value?: string;
  },
  from: string,
): boolean {
  try {
    if (
      from.toLowerCase() !== job.address ||
      BigInt(tx.chainId!) !== BigInt(job.expected_chain) ||
      BigInt(tx.value!) !== 0n ||
      (job.nonce !== null && BigInt(tx.nonce!) !== BigInt(job.nonce))
    )
      return false;
    const to =
      job.kind === "approval" ? job.expected_token : job.expected_router;
    if (tx.to?.toLowerCase() !== to) return false;
    const expected =
      job.kind === "approval"
        ? calls.encodeFunctionData("approve", [job.expected_router, job.amount])
        : calls.encodeFunctionData(
            BigInt(job.points_redeemed ?? 0) > 0n
              ? "payWithPoints"
              : job.reward_id
                ? "payWithReward"
                : "pay",
            [
              job.invoice_id,
              job.merchant_key,
              job.gross_amount ?? job.amount,
              Math.floor(job.expires_at!.getTime() / 1000),
              ...(BigInt(job.points_redeemed ?? 0) > 0n
                ? [job.points_redeemed]
                : job.reward_id
                  ? [job.reward_id]
                  : []),
            ],
          );
    return tx.input?.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

export function matchingReplacementHashes(
  job: ReconciliationJob,
  transactions: {
    tx: {
      hash: string;
      chainId?: string;
      nonce?: string;
      to?: string;
      input?: string;
      value?: string;
    };
    from: string;
  }[],
): string[] {
  return [
    ...new Set(
      transactions
        .filter(
          (item) =>
            /^0x[0-9a-fA-F]{64}$/.test(item.tx.hash) &&
            matchesJobTransaction(job, item.tx, item.from),
        )
        .map((item) => item.tx.hash),
    ),
  ];
}
