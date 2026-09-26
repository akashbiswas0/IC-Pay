import { loyaltyABI } from "./loyalty-protocol.js";
import { Interface, getAddress, toQuantity } from "ethers";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { multibaas } from "./multibaas.js";
import { routerSnapshot } from "./payment-router.js";
export type ConfirmedRewardAnchor = { number: string; hash: string };
export type RewardGetter =
  | "campaigns"
  | "vouchers"
  | "issuedVoucherIds"
  | "merchants"
  | "nextVoucherId"
  | "tokenURI"
  | "pointUnit"
  | "pointsBalance"
  | "pointsSummary"
  | "walletMerchantIds"
  | "merchantWallets"
  | "payments";
export type ReadRPC = (method: string, params: unknown[]) => Promise<unknown>;
const getters = new Set([
  "campaigns",
  "vouchers",
  "issuedVoucherIds",
  "merchants",
  "nextVoucherId",
  "tokenURI",
  "pointUnit",
  "pointsBalance",
  "pointsSummary",
  "walletMerchantIds",
  "merchantWallets",
  "payments",
]);
const abi = new Interface([
  "function campaigns(bytes32) view returns(bool enabled,uint256 minPurchase,uint16 discountBps,uint256 maxDiscount,uint64 validitySeconds,uint64 version)",
  "function vouchers(uint256) view returns(bytes32 merchantId,address holder,uint256 minPurchase,uint16 discountBps,uint256 maxDiscount,uint64 campaignVersion,uint64 issuedAt,uint64 expiresAt,bool redeemed,uint64 redeemedAt,bytes32 issuedInvoiceId,bytes32 redeemedInvoiceId)",
  "function issuedVoucherIds(address,uint256,uint256) view returns(uint256[] voucherIds,uint256 total)",
  "function merchants(bytes32) view returns(address recipient,bool enabled)",
  "function nextVoucherId() view returns(uint256)",
  "function tokenURI(uint256) view returns(string)",
]);
const creditABI = new Interface([
  "function campaigns(bytes32) view returns(bool enabled,uint256 minPurchase,uint16 earnBps,uint256 maxCredit,uint64 validitySeconds,uint64 version)",
  "function vouchers(uint256) view returns(bytes32 merchantId,address holder,uint256 purchaseAmount,uint256 creditAmount,uint256 remainingCredit,uint16 earnBps,uint256 maxCredit,uint64 campaignVersion,uint64 issuedAt,uint64 expiresAt,bool redeemed,uint64 redeemedAt,bytes32 issuedInvoiceId,bytes32 redeemedInvoiceId)",
  "function issuedVoucherIds(address,uint256,uint256) view returns(uint256[] voucherIds,uint256 total)",
  "function merchants(bytes32) view returns(address recipient,bool enabled)",
  "function nextVoucherId() view returns(uint256)",
  "function tokenURI(uint256) view returns(string)",
]);
function normalized(value: any): any {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return Array.from(value, normalized);
  return value;
}
/** This reader cannot submit transactions. Every result is pinned to the confirmed MultiBaas block hash. */
export class CanonicalRewardReader {
  private readonly address: string;
  constructor(
    private readonly rpc: ReadRPC,
    private readonly chainId: string,
    address: string,
    private readonly model: "rewards" | "collectibles" | "loyalty" = "rewards",
  ) {
    this.address = getAddress(address);
  }
  private async checkBlock(anchor: ConfirmedRewardAnchor) {
    if (
      !/^[0-9]+$/.test(anchor.number) ||
      !/^0x[0-9a-fA-F]{64}$/.test(anchor.hash)
    )
      throw new AppError(
        "invalid_reward_anchor",
        "Invalid confirmed reward block.",
        502,
      );
    const block = (await this.rpc("eth_getBlockByNumber", [
      toQuantity(BigInt(anchor.number)),
      false,
    ])) as { hash?: string; number?: string } | null;
    if (
      !block?.hash ||
      String(block.hash).toLowerCase() !== anchor.hash.toLowerCase() ||
      block.number === undefined ||
      BigInt(block.number) !== BigInt(anchor.number)
    )
      throw new AppError(
        "reward_chain_disagreement",
        "The reward RPC does not agree with the confirmed MultiBaas block.",
        503,
      );
  }
  async read(
    method: RewardGetter,
    args: unknown[],
    anchor: ConfirmedRewardAnchor,
  ): Promise<any> {
    if (!getters.has(method))
      throw new AppError(
        "reward_read_only",
        "This method is not a supported reward-state getter.",
        403,
      );
    const chain = await this.rpc("eth_chainId", []);
    if (
      typeof chain !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(chain) ||
      BigInt(chain) !== BigInt(this.chainId)
    )
      throw new AppError(
        "reward_chain_mismatch",
        "Reward RPC is connected to another chain.",
        503,
      );
    await this.checkBlock(anchor);
    const contractABI =
      this.model === "loyalty"
        ? loyaltyABI
        : this.model === "collectibles"
          ? creditABI
          : abi;
    const data = contractABI.encodeFunctionData(method, args);
    // EIP-1898 is mandatory. An unsupported/noncanonical request fails closed; never retry at latest.
    const result = await this.rpc("eth_call", [
      { to: this.address, data },
      { blockHash: anchor.hash, requireCanonical: true },
    ]);
    if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(result))
      throw new AppError(
        "invalid_reward_read",
        "Reward RPC returned invalid contract data.",
        502,
      );
    const output = normalized(contractABI.decodeFunctionResult(method, result));
    await this.checkBlock(anchor);
    return output;
  }
}
let rpcSequence = 0;
let rateLimitedUntil = 0;
function httpReadRPC(url: string): ReadRPC {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new AppError(
      "reward_read_unconfigured",
      "Reward state reads require a configured HTTPS endpoint.",
      503,
    );
  return async (method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(method))
      throw new AppError(
        "reward_read_only",
        "Reward RPC cannot send transactions.",
        403,
      );
    if (Date.now() < rateLimitedUntil)
      throw new AppError(
        "reward_read_rate_limited",
        "Reward state reads are rate-limited. Try again shortly.",
        503,
      );
    const id = ++rpcSequence;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      rateLimitedUntil =
        Date.now() +
        (retry && /^\d+$/.test(retry)
          ? Math.max(1000, Number(retry) * 1000)
          : 60000);
      await response.body?.cancel();
      throw new AppError(
        "reward_read_rate_limited",
        "Reward state reads are rate-limited. Try again shortly.",
        503,
      );
    }
    if (!response.ok)
      throw new AppError(
        "reward_read_unavailable",
        "Confirmed reward state is temporarily unavailable.",
        503,
      );
    const payload = (await response.json()) as {
      jsonrpc?: string;
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (
      payload.jsonrpc !== "2.0" ||
      payload.id !== id ||
      payload.error ||
      !Object.hasOwn(payload, "result")
    )
      throw new AppError(
        "reward_read_unavailable",
        "The reward RPC could not serve the required canonical block.",
        503,
      );
    return payload.result;
  };
}
const readers = new Map<string, CanonicalRewardReader>();
export async function readRewardAtBlock(
  address: string,
  label: string,
  method: RewardGetter,
  args: unknown[],
  anchor: ConfirmedRewardAnchor,
) {
  const kind = routerSnapshot(address, label).kind;
  if (kind === "legacy")
    throw new AppError(
      "reward_read_unconfigured",
      "The requested reward router is not configured.",
      503,
    );
  if (config.REWARD_READ_MODE === "multibaas")
    return multibaas.call(address, label, method, args, undefined, {
      blockNumber: anchor.number,
    });
  const url = config.REWARD_READ_RPC_URL ?? config.BALANCE_RPC_URL;
  if (!url || !config.CHAIN_ID)
    throw new AppError(
      "reward_read_unconfigured",
      "Configure a canonical reward-state read RPC.",
      503,
    );
  const key = `${url}|${config.CHAIN_ID}|${address}`;
  let reader = readers.get(key);
  if (!reader) {
    reader = new CanonicalRewardReader(
      httpReadRPC(url),
      config.CHAIN_ID,
      address,
      kind,
    );
    readers.set(key, reader);
  }
  return { output: await reader.read(method, args, anchor) };
}
