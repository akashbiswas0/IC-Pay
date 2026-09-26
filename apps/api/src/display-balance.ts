import { Interface, isAddress } from "ethers";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { multibaas } from "./multibaas.js";

const tokenABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
]);
type DisplayBalance = { balance: string; source: "multibaas" | "rpc" };
const inFlight = new Map<string, Promise<DisplayBalance>>();

/** Fresh read-only RPC lookup; verifies the network before reading the configured token. */
export async function readRpcTokenBalance(
  url: string,
  chainId: string,
  token: string,
  wallet: string,
): Promise<string> {
  if (
    new URL(url).protocol !== "https:" ||
    !isAddress(token) ||
    !isAddress(wallet)
  )
    throw new AppError(
      "invalid_balance_source",
      "Balance source is not configured correctly.",
      503,
    );
  async function rpc(id: number, method: string, params: unknown[]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new AppError(
        "balance_rpc_unavailable",
        "Balance source is unavailable.",
        503,
      );
    const body = (await response.json()) as {
      jsonrpc?: unknown;
      id?: unknown;
      error?: unknown;
      result?: unknown;
    };
    if (
      body.jsonrpc !== "2.0" ||
      body.id !== id ||
      body.error ||
      typeof body.result !== "string"
    )
      throw new AppError(
        "invalid_balance_response",
        "Balance source returned an invalid response.",
        502,
      );
    return body.result;
  }
  const chain = await rpc(1, "eth_chainId", []);
  if (!/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(chainId))
    throw new AppError(
      "chain_mismatch",
      "Balance source is connected to a different chain.",
      503,
    );
  const result = await rpc(2, "eth_call", [
    { to: token, data: tokenABI.encodeFunctionData("balanceOf", [wallet]) },
    "latest",
  ]);
  if (!/^0x[0-9a-f]{64}$/i.test(result))
    throw new AppError(
      "invalid_balance",
      "Balance source returned an invalid token balance.",
      502,
    );
  return (
    tokenABI.decodeFunctionResult("balanceOf", result)[0] as bigint
  ).toString();
}

/** Dashboard-only fallback. No cached amounts and no fallback for configuration/chain errors. */
export async function readDisplayBalance(
  address: string,
): Promise<DisplayBalance> {
  const key = `${config.CHAIN_ID}:${config.TOKEN_ADDRESS}:${address.toLowerCase()}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = (async (): Promise<DisplayBalance> => {
    try {
      await multibaas.validateTokenReadChain();
      return { balance: await multibaas.balance(address), source: "multibaas" };
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== "multibaas_rate_limited" ||
        !config.BALANCE_RPC_URL
      )
        throw error;
      return {
        balance: await readRpcTokenBalance(
          config.BALANCE_RPC_URL,
          config.CHAIN_ID!,
          config.TOKEN_ADDRESS!,
          address,
        ),
        source: "rpc",
      };
    }
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}
