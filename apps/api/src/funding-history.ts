import { AppError } from "./errors.js";
export type FundingRow = Record<string, unknown>;
export type FundingPage = { rows: FundingRow[]; truncated?: boolean };
/** Old-provider credentials are limited to these read-only protocol operations. */
export function assertHistoryReadRequest(path: string, body?: unknown): void {
  if (path === "/chains/ethereum/status" && body === undefined) return;
  const query = /^\/queries\?limit=(\d+)&offset=(\d+)$/.exec(path);
  if (
    query &&
    body !== undefined &&
    Number(query[1]) >= 1 &&
    Number(query[1]) <= 50 &&
    Number.isSafeInteger(Number(query[2]))
  )
    return;
  throw new AppError(
    "history_read_only",
    "The historical provider may only supply chain identity and indexed event queries.",
    403,
  );
}
/** Primary results win duplicate hashes; receipts will supply authoritative log-level transfers. */
export function mergeFundingSources(
  primary: PromiseSettledResult<FundingPage>,
  history?: PromiseSettledResult<FundingPage>,
) {
  const results = history ? [primary, history] : [primary];
  const successful = results.filter(
    (r): r is PromiseFulfilledResult<FundingPage> => r.status === "fulfilled",
  );
  if (!successful.length)
    throw new AppError(
      "funding_sources_unavailable",
      "Funding history sources are unavailable.",
      503,
    );
  const rows = new Map<string, FundingRow>();
  for (const result of successful) {
    for (const row of result.value.rows) {
      if (
        typeof row.txHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(row.txHash) ||
        typeof row.createdAt !== "string" ||
        !Number.isFinite(Date.parse(row.createdAt))
      )
        throw new AppError(
          "invalid_funding_history",
          "A funding query returned invalid transaction metadata.",
          502,
        );
      const key = row.txHash.toLowerCase();
      if (!rows.has(key)) rows.set(key, { ...row, txHash: key });
    }
  }
  const sorted = [...rows.values()].sort(
    (a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)),
  );
  const historyComplete =
    successful.length === results.length &&
    !successful.some((r) => r.value.truncated) &&
    sorted.length <= 100;
  return {
    rows: sorted.slice(0, 100),
    historyComplete,
    historyStatus: historyComplete
      ? ("complete" as const)
      : ("partial" as const),
  };
}
export function validMultiBaasURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
