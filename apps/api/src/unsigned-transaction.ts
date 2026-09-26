import { type TransactionLike } from "ethers";
import { AppError } from "./errors.js";
import { weiQuantity } from "./gas.js";
export interface ExpectedTransaction {
  chainId: string;
  from: string;
  to: string;
  data: string;
  nonce?: number;
}
/** MultiBaas omits chainId in its documented unsigned shape; bind the configured chain after checking the live chain endpoint.
 * Address.nonce is optional and is omitted by the live deployment even with include=nonce.
 * TransactionToSignTx.nonce is required provider-built data: validate it always, and
 * independently compare Address.nonce when present. Never substitute an assumed zero.
 */
export function validateUnsignedTransaction(
  quote: any,
  expected: ExpectedTransaction,
): TransactionLike {
  const bad = () =>
    new AppError(
      "invalid_unsigned_transaction",
      "MultiBaas's unsigned transaction does not match the requested operation.",
      502,
    );
  const tx = quote?.tx;
  if (
    quote?.submitted !== false ||
    !tx ||
    String(tx.from).toLowerCase() !== expected.from.toLowerCase() ||
    String(tx.to).toLowerCase() !== expected.to.toLowerCase() ||
    String(tx.data).toLowerCase() !== expected.data.toLowerCase() ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data) ||
    !Number.isSafeInteger(tx.nonce) ||
    tx.nonce < 0 ||
    (expected.nonce !== undefined &&
      (!Number.isSafeInteger(expected.nonce) || tx.nonce !== expected.nonce)) ||
    !Number.isSafeInteger(tx.gas) ||
    tx.gas <= 0 ||
    ![0, 2].includes(tx.type)
  )
    throw bad();
  if (
    tx.chainId !== undefined &&
    BigInt(tx.chainId) !== BigInt(expected.chainId)
  )
    throw bad();
  if (
    weiQuantity(tx.value) !== 0n ||
    tx.authorizationList?.length ||
    tx.accessList?.length
  )
    throw bad();
  const common = {
    chainId: BigInt(expected.chainId),
    nonce: tx.nonce,
    to: expected.to,
    data: expected.data,
    value: 0n,
    gasLimit: BigInt(tx.gas),
    type: tx.type,
  };
  if (tx.type === 0) return { ...common, gasPrice: weiQuantity(tx.gasPrice) };
  const maxFeePerGas = weiQuantity(tx.gasFeeCap);
  const maxPriorityFeePerGas = weiQuantity(tx.gasTipCap);
  if (maxPriorityFeePerGas > maxFeePerGas) throw bad();
  return { ...common, maxFeePerGas, maxPriorityFeePerGas };
}
