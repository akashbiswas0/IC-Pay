import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import { config } from "./config.js";
import { pool, withWalletLock } from "./db.js";
import { AppError } from "./errors.js";
import { kmsWallets } from "./wallets.js";
import { multibaas } from "./multibaas.js";
import { validateAcceptedSettlement } from "./settlement.js";

export function acceptedOperatorReceiptMatches(
  row: any,
  receipt: any,
  block: any,
  head: any,
  confirmations: number,
): boolean {
  try {
    return (
      ["confirmed", "failed"].includes(row.status) &&
      Boolean(row.block_number) &&
      block?.hash === row.block_hash &&
      receipt?.blockHash === row.block_hash &&
      BigInt(receipt.blockNumber) === BigInt(row.block_number) &&
      String(receipt.transactionHash).toLowerCase() ===
        row.tx_hash.toLowerCase() &&
      BigInt(receipt.status) === (row.status === "confirmed" ? 1n : 0n) &&
      BigInt(head.number) - BigInt(row.block_number) + 1n >=
        BigInt(confirmations)
    );
  } catch {
    return false;
  }
}
export async function reconcileOperator(id: string) {
  const row = (
    await pool.query("SELECT * FROM operator_transactions WHERE id=$1", [id])
  ).rows[0];
  if (!row)
    throw new AppError("not_found", "Operator transaction not found.", 404);
  if (row.chain_id !== config.CHAIN_ID)
    throw new AppError(
      "chain_mismatch",
      "Restore the original deployment to reconcile this transaction.",
      409,
    );
  await multibaas.validateChain();
  // Accepted operator transactions also consume a nonce. Recheck them before a later command.
  if (row.status === "confirmed" || row.status === "failed") {
    try {
      const accepted = await multibaas.block(String(row.block_number));
      const existing = await multibaas.receipt(row.tx_hash);
      const acceptedHead = await multibaas.head();
      if (
        !acceptedOperatorReceiptMatches(
          row,
          existing?.data,
          accepted,
          acceptedHead,
          config.CONFIRMATIONS,
        )
      )
        throw new Error("Accepted receipt changed");
      return { id, txHash: row.tx_hash, status: row.status };
    } catch {
      await pool.query(
        "UPDATE operator_transactions SET status='reconciling' WHERE id=$1",
        [id],
      );
      return { id, txHash: row.tx_hash, status: "reconciling" };
    }
  }
  const receipt = await multibaas.receipt(row.tx_hash);
  const data = receipt?.data;
  if (!data?.blockNumber)
    return { id, txHash: row.tx_hash, status: row.status };
  if (String(data.transactionHash).toLowerCase() !== row.tx_hash.toLowerCase())
    throw new AppError("receipt_mismatch", "Receipt hash mismatch.", 502);
  const block = await multibaas.block(data.blockNumber);
  const head = await multibaas.head();
  if (
    block.hash !== data.blockHash ||
    BigInt(head.number) - BigInt(data.blockNumber) + 1n <
      BigInt(config.CONFIRMATIONS)
  )
    return { id, txHash: row.tx_hash, status: row.status };
  const status = BigInt(data.status) === 1n ? "confirmed" : "failed";
  await pool.query(
    "UPDATE operator_transactions SET status=$2,block_number=$3,block_hash=$4 WHERE id=$1",
    [id, status, BigInt(data.blockNumber).toString(), data.blockHash],
  );
  return { id, txHash: row.tx_hash, status };
}

export async function submitOperator(
  keyId: string,
  address: string,
  label: string,
  method: "mint" | "setMerchant" | "setCampaign" | "approve" | "refund",
  args: unknown[],
  operationId?: string,
  beforeSigning?: () => Promise<void>,
  signingGuard?: (
    sign: () => Promise<{ signedTx: string; hash: string; nonce: string }>,
  ) => Promise<{ signedTx: string; hash: string; nonce: string }>,
  onProgress: () => Promise<void> = async () => {},
) {
  const kms = await kmsWallets();
  const from = (await kms.address(keyId)).toLowerCase();
  return withWalletLock(from, async () => {
    const prior = (
      await pool.query(
        "SELECT id FROM operator_transactions WHERE address=$1 AND status IN ('signed','pending','reconciling','confirmed','failed')",
        [from],
      )
    ).rows;
    for (const operation of prior) {
      await reconcileOperator(operation.id);
      await onProgress();
    }
    const acceptedPayments = (
      await pool.query(
        "SELECT j.* FROM payment_jobs j JOIN wallets w ON w.account_id=j.account_id AND (w.id=j.wallet_id OR (j.wallet_id IS NULL AND w.card_id IS NULL)) WHERE w.address=$1 AND j.status='confirmed'",
        [from],
      )
    ).rows;
    for (const job of acceptedPayments) {
      await validateAcceptedSettlement(job);
      await onProgress();
    }
    const active = await pool.query(
      "SELECT 1 FROM operator_transactions WHERE address=$1 AND status IN ('signed','pending','reconciling') UNION ALL SELECT 1 FROM payment_jobs j JOIN wallets w ON w.account_id=j.account_id AND (w.id=j.wallet_id OR (j.wallet_id IS NULL AND w.card_id IS NULL)) WHERE w.address=$1 AND j.status IN ('submitting','pending','reconciling') LIMIT 1",
      [from],
    );
    if (active.rowCount)
      throw new AppError(
        "wallet_operation_pending",
        "An earlier transaction must be reconciled before signing another.",
        409,
      );
    const abi = new Interface([
      "function mint(address recipient,uint256 amount)",
      "function approve(address spender,uint256 amount)",
      "function refund(bytes32 invoiceId,address payer)",
      "function setMerchant(bytes32 merchantId,address recipient,bool enabled)",
      "function setCampaign(bytes32 merchantId,bool enabled,uint256 minPurchase,uint16 discountBps,uint256 maxDiscount,uint64 validitySeconds)",
    ]);
    const unsigned = await multibaas.prepareTransaction(
      address,
      label,
      method,
      args,
      from,
      abi.encodeFunctionData(method, args),
    );
    await onProgress();
    const sign = async () => {
      if (beforeSigning) await beforeSigning();
      return kms.signTransaction(keyId, unsigned, from);
    };
    const signed = signingGuard ? await signingGuard(sign) : await sign();
    const id = operationId ?? randomUUID();
    // Commit the known local hash and bytes before the single broadcast attempt.
    await pool.query(
      "INSERT INTO operator_transactions(id,key_id,address,chain_id,tx_hash,nonce,signed_tx,status,broadcast_attempted_at) VALUES($1,$2,$3,$4,$5,$6,$7,'signed',now())",
      [
        id,
        keyId,
        from,
        config.CHAIN_ID,
        signed.hash,
        signed.nonce,
        signed.signedTx,
      ],
    );
    try {
      await multibaas.broadcast(signed.signedTx, signed.hash);
      await pool.query(
        "UPDATE operator_transactions SET status='pending' WHERE id=$1",
        [id],
      );
      return { id, txHash: signed.hash, status: "pending" };
    } catch {
      await pool.query(
        "UPDATE operator_transactions SET status='reconciling' WHERE id=$1",
        [id],
      );
      return { id, txHash: signed.hash, status: "reconciling" };
    }
  });
}
