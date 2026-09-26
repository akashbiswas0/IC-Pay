import { AppError } from "./errors.js";

export function weiQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value))
    throw new AppError(
      "invalid_gas_quote",
      "MultiBaas returned an invalid wei quantity.",
      502,
    );
  return BigInt(value);
}

/** Maximum native cost from MultiBaas's current unsigned transaction quote. */
export function estimatedNativeCost(tx: {
  gas?: unknown;
  gasFeeCap?: unknown;
  gasPrice?: unknown;
  value?: unknown;
}): bigint {
  if (
    typeof tx.gas !== "number" ||
    !Number.isSafeInteger(tx.gas) ||
    tx.gas <= 0
  )
    throw new AppError(
      "invalid_gas_quote",
      "MultiBaas returned an invalid gas limit.",
      502,
    );
  const fee = weiQuantity(tx.gasFeeCap ?? tx.gasPrice);
  return BigInt(tx.gas) * fee + weiQuantity(tx.value);
}

export function requireNativeBalance(
  balance: bigint,
  estimatedCost?: bigint,
): void {
  if (
    balance === 0n ||
    (estimatedCost !== undefined && balance < estimatedCost)
  )
    throw new AppError(
      "insufficient_gas",
      "Fund the wallet with native testnet gas before submitting this operation.",
    );
}
