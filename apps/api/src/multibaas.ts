import { Interface, id } from "ethers";
import { paymentRouter, routerSnapshot } from "./payment-router.js";
import { validateUnsignedTransaction } from "./unsigned-transaction.js";
import { config, hasPayments, hasTokenReads } from "./config.js";
import { assertHistoryReadRequest } from "./funding-history.js";
import { AppError, requireValue } from "./errors.js";
import {
  estimatedNativeCost,
  requireNativeBalance,
  weiQuantity,
} from "./gas.js";
export const approvalABI = new Interface([
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
export const paymentABI = new Interface([
  "event PaymentCompleted(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,address recipient,address token,uint256 amount)",
]);
// The live deployment rejects list/query page sizes above 50.
export const MULTIBAAS_PAGE_SIZE = 50;
export const merchantBytes32 = (uuid: string) => id(uuid.toLowerCase());
export function decodeTokenBalance(output: unknown): string {
  const decimal =
    typeof output === "string"
      ? output
      : typeof output === "number" &&
          Number.isSafeInteger(output) &&
          output >= 0
        ? String(output)
        : "";
  if (!/^[0-9]+$/.test(decimal) || BigInt(decimal) >= 1n << 256n)
    throw new AppError(
      "invalid_balance",
      "MultiBaas did not return a valid token balance.",
      502,
    );
  return BigInt(decimal).toString();
}
/** Receipts use hex quantities, but MultiBaas's block lookup expects decimal. */
export function normalizeBlockNumber(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value))
    throw new AppError(
      "invalid_block_number",
      "Block number must be a nonnegative decimal or hexadecimal quantity.",
      502,
    );
  return BigInt(value).toString(10);
}
/** Event Queries return PostgreSQL timestamps; clients require unambiguous RFC3339. */
export function normalizeEventTimestamp(value: unknown): string {
  if (typeof value !== "string")
    throw new AppError(
      "invalid_event_timestamp",
      "MultiBaas returned an invalid event timestamp.",
      502,
    );
  const iso = value
    .replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T")
    .replace(/([+-]\d{2})$/, "$1:00");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
      iso,
    ) ||
    !Number.isFinite(Date.parse(iso))
  )
    throw new AppError(
      "invalid_event_timestamp",
      "MultiBaas returned an invalid event timestamp.",
      502,
    );
  return new Date(iso).toISOString();
}
/** A missing, well-formed receipt is pending/unknown, never a failed payment. */
export function isUnminedReceiptResponse(
  path: string,
  body: unknown,
  status: number,
): boolean {
  return (
    status === 404 &&
    body === undefined &&
    /^\/chains\/ethereum\/transactions\/receipt\/0x[0-9a-fA-F]{64}$/.test(path)
  );
}
export class MultiBaas {
  constructor(private readonly source: "primary" | "history" = "primary") {}
  private historyValidatedUntil = 0;
  private historyValidation: Promise<void> | undefined;
  private async validateHistoryChain() {
    if (Date.now() < this.historyValidatedUntil) return;
    if (this.historyValidation) return this.historyValidation;
    this.historyValidation = (async () => {
      const chain = await this.request("/chains/ethereum/status");
      if (!config.CHAIN_ID || String(chain.chainID) !== config.CHAIN_ID)
        throw new AppError(
          "history_chain_mismatch",
          "The historical index is on a different chain.",
          503,
        );
      this.historyValidatedUntil = Date.now() + 300000;
    })();
    try {
      await this.historyValidation;
    } finally {
      this.historyValidation = undefined;
    }
  }
  private rateLimitedUntil = 0;
  private rateLimitError() {
    return new AppError(
      "multibaas_rate_limited",
      "Blockchain service is rate-limited. Try again shortly.",
      503,
    );
  }
  async request(path: string, body?: unknown): Promise<any> {
    if (this.source === "history") {
      assertHistoryReadRequest(path, body);
      if (path.startsWith("/queries")) await this.validateHistoryChain();
    }
    const deploymentURL =
      this.source === "history"
        ? config.MULTIBAAS_HISTORY_URL
        : config.MULTIBAAS_URL;
    const apiKey =
      this.source === "history"
        ? config.MULTIBAAS_HISTORY_API_KEY
        : config.MULTIBAAS_API_KEY;
    if (!deploymentURL || !apiKey)
      throw new AppError(
        "multibaas_unconfigured",
        "MultiBaas is not configured.",
        503,
      );
    if (Date.now() < this.rateLimitedUntil) throw this.rateLimitError();
    const base = deploymentURL.replace(/\/$/, "").replace(/\/api\/v0$/, "");
    const response = await fetch(`${base}/api/v0${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 429) {
      const header = response.headers.get("retry-after");
      const retryMs =
        header && /^\d+$/.test(header)
          ? Number(header) * 1000
          : header
            ? Date.parse(header) - Date.now()
            : NaN;
      this.rateLimitedUntil =
        Date.now() +
        (Number.isFinite(retryMs) ? Math.max(1000, retryMs) : 60_000);
      await response.body?.cancel();
      throw this.rateLimitError();
    }
    if (isUnminedReceiptResponse(path, body, response.status)) {
      await response.body?.cancel();
      return { data: null };
    }
    if (!response.ok)
      throw new AppError(
        "multibaas_error",
        `MultiBaas returned HTTP ${response.status}.`,
        502,
      );
    const result = (await response.json()) as { result: unknown };
    return result.result;
  }
  async validateChain() {
    if (!hasPayments)
      throw new AppError(
        "payments_unconfigured",
        "Configure the test network, token and payment contract.",
        503,
      );
    await this.validateTokenReadChain();
  }
  async validateTokenReadChain() {
    if (!hasTokenReads)
      throw new AppError(
        "token_unconfigured",
        "Token balance reads are not configured.",
        503,
      );
    const chain = await this.request("/chains/ethereum/status");
    if (String(chain.chainID) !== config.CHAIN_ID)
      throw new AppError(
        "chain_mismatch",
        "MultiBaas is connected to a different chain.",
        503,
      );
  }
  async call(
    address: string,
    label: string,
    method: string,
    args: unknown[],
    from?: string,
    readOptions?: { blockNumber: string },
  ) {
    return this.request(
      `/chains/ethereum/addresses/${encodeURIComponent(address)}/contracts/${encodeURIComponent(label)}/methods/${encodeURIComponent(method)}`,
      {
        args,
        formatInts: "as_strings",
        ...(from ? { from } : {}),
        signAndSubmit: false,
        ...readOptions,
      },
    );
  }
  async balance(address: string): Promise<string> {
    const result = await this.call(
      requireValue(
        config.TOKEN_ADDRESS,
        "token_unconfigured",
        "Token is not configured.",
      ),
      config.TOKEN_CONTRACT,
      "balanceOf",
      [address],
    );
    return decodeTokenBalance(result.output);
  }
  async allowance(
    address: string,
    spender = config.PAYMENT_ADDRESS,
  ): Promise<string> {
    const result = await this.call(
      config.TOKEN_ADDRESS!,
      config.TOKEN_CONTRACT,
      "allowance",
      [address, spender],
    );
    return String(result.output);
  }
  async prepareTransaction(
    address: string,
    label: string,
    method: string,
    args: unknown[],
    from: string,
    expectedData: string,
  ) {
    await this.validateChain();
    const account = await this.request(
      `/chains/ethereum/addresses/${encodeURIComponent(from)}?include=balance&include=nonce`,
    );
    const balance = weiQuantity(account.balance);
    requireNativeBalance(balance);
    const quote = await this.call(address, label, method, args, from);
    const transaction = validateUnsignedTransaction(quote, {
      chainId: config.CHAIN_ID!,
      from,
      to: address,
      data: expectedData,
      nonce: account.nonce,
    });
    requireNativeBalance(balance, estimatedNativeCost(quote.tx));
    return transaction;
  }
  async preparePayment(
    from: string,
    kind: string,
    amount: string,
    invoice?: {
      id: string;
      merchant_id: string;
      expires_at: Date;
      gross_amount?: string;
      reward_id?: string | null;
      points_redeemed?: string;
    },
    storedRouter?: string | null,
    storedLabel?: string | null,
  ) {
    const abi = new Interface([
      "function approve(address spender,uint256 amount)",
      "function pay(bytes32 invoiceId,bytes32 merchantId,uint256 amount,uint256 expiresAt)",
      "function payWithReward(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt,uint256 voucherId)",
      "function payWithPoints(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt,uint256 pointsToRedeem)",
    ]);
    const router = storedRouter
      ? routerSnapshot(storedRouter, storedLabel)
      : paymentRouter();
    const method =
      kind === "approval"
        ? "approve"
        : BigInt(invoice?.points_redeemed ?? 0) > 0n
          ? "payWithPoints"
          : invoice?.reward_id
            ? "payWithReward"
            : "pay";
    const args =
      kind === "approval"
        ? [router.address, amount]
        : [
            invoice!.id,
            merchantBytes32(invoice!.merchant_id),
            invoice!.gross_amount ?? amount,
            Math.floor(invoice!.expires_at.getTime() / 1000).toString(),
            ...(BigInt(invoice!.points_redeemed ?? 0) > 0n
              ? [invoice!.points_redeemed]
              : invoice!.reward_id
                ? [invoice!.reward_id]
                : []),
          ];
    return this.prepareTransaction(
      kind === "approval" ? config.TOKEN_ADDRESS! : router.address,
      kind === "approval" ? config.TOKEN_CONTRACT : router.label,
      method,
      args,
      from,
      abi.encodeFunctionData(method, args),
    );
  }

  async broadcast(signedTx: string, expectedHash: string) {
    const result = await this.request("/chains/ethereum/transactions/submit", {
      signedTx,
    });
    if (String(result?.tx?.hash).toLowerCase() !== expectedHash.toLowerCase())
      throw new AppError(
        "submission_unknown",
        "MultiBaas did not return the locally signed transaction hash; reconcile before further action.",
        502,
      );
    return result;
  }
  async incomingTransfers(address: string) {
    const query = {
      events: [
        {
          eventName: "Transfer",
          select: [
            { type: "input", inputIndex: 0, alias: "from" },
            { type: "input", inputIndex: 1, alias: "to" },
            { type: "input", inputIndex: 2, alias: "amount" },
            { type: "tx_hash", alias: "txHash" },
            { type: "triggered_at", alias: "createdAt" },
            { type: "block_number", alias: "blockNumber" },
          ],
          filter: {
            rule: "and",
            children: [
              {
                fieldType: "contract_address",
                operator: "equal",
                value: config.TOKEN_ADDRESS,
              },
              {
                fieldType: "input",
                inputIndex: 1,
                operator: "equal",
                value: address,
              },
            ],
          },
        },
      ],
      orderBy: "blockNumber",
      order: "DESC",
    };
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 100; offset += MULTIBAAS_PAGE_SIZE) {
      const page = await this.request(
        `/queries?limit=${MULTIBAAS_PAGE_SIZE}&offset=${offset}`,
        query,
      );
      if (!Array.isArray(page?.rows))
        throw new AppError(
          "invalid_event_query",
          "MultiBaas returned an invalid event query response.",
          502,
        );
      rows.push(...page.rows);
      if (page.rows.length < MULTIBAAS_PAGE_SIZE) break;
    }
    return {
      truncated: rows.length >= 100,
      rows: rows.map((row) => ({
        ...row,
        createdAt: normalizeEventTimestamp(row.createdAt),
      })),
    };
  }
  async transaction(hash: string) {
    return this.request(`/chains/ethereum/transactions/${hash}`);
  }
  async receipt(hash: string) {
    return this.request(`/chains/ethereum/transactions/receipt/${hash}`);
  }
  async head() {
    return this.request("/chains/ethereum/blocks/latest");
  }
  async block(number: string) {
    return this.request(
      `/chains/ethereum/blocks/${normalizeBlockNumber(number)}`,
    );
  }
}
export const multibaas = new MultiBaas();

export const historicalMultibaas = new MultiBaas("history");
