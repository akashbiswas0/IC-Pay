import { transaction } from "./db.js";
import { config } from "./config.js";
import { routerSnapshot } from "./payment-router.js";
import { multibaas } from "./multibaas.js";
/** Demote a previously accepted receipt once, retaining its wallet's nonce reservation. */
export async function markSettlementUncertain(
  job: {
    id: string;
    kind: string;
    account_id: string;
    invoice_id: string | null;
    policy_id?: string | null;
    amount: string;
  },
  code: string,
): Promise<boolean> {
  return transaction(async (db) => {
    const current = (
      await db.query("SELECT status FROM payment_jobs WHERE id=$1 FOR UPDATE", [
        job.id,
      ])
    ).rows[0];
    if (current?.status !== "confirmed") return false;
    if (job.kind === "payment") {
      await db.query(
        "UPDATE policies SET spent=spent-$2,reserved=reserved+$2 WHERE account_id=$1 AND (id=$3 OR ($3::uuid IS NULL AND card_id IS NULL))",
        [job.account_id, job.amount, job.policy_id ?? null],
      );
      await db.query("DELETE FROM loyalty_receipt_events WHERE invoice_id=$1", [
        job.invoice_id,
      ]);
      await db.query(
        "UPDATE loyalty_reservations SET consumed_at=NULL WHERE job_id=$1",
        [job.id],
      );
      await db.query("DELETE FROM reward_receipt_events WHERE invoice_id=$1", [
        job.invoice_id,
      ]);
      await db.query(
        "UPDATE reward_reservations SET consumed_at=NULL WHERE job_id=$1 AND released_at IS NULL",
        [job.id],
      );
      await db.query("DELETE FROM receipts WHERE invoice_id=$1", [
        job.invoice_id,
      ]);
      await db.query("UPDATE invoices SET status='reconciling' WHERE id=$1", [
        job.invoice_id,
      ]);
    }
    await db.query(
      "UPDATE payment_jobs SET status='reconciling',error_code=$2,updated_at=now() WHERE id=$1",
      [job.id, code],
    );
    return true;
  });
}

export async function validateAcceptedSettlement(job: any): Promise<boolean> {
  let block, receipt, head;
  try {
    routerSnapshot(job.expected_router, job.expected_router_label);
    if (
      job.expected_chain !== config.CHAIN_ID ||
      job.expected_token !== config.TOKEN_ADDRESS
    )
      throw new Error("Deployment changed");
    await multibaas.validateChain();
    if (!job.block_number || !job.block_hash || !job.tx_hash)
      throw new Error("Accepted receipt metadata missing");
    block = await multibaas.block(String(job.block_number));
    receipt = await multibaas.receipt(job.tx_hash);
    head = await multibaas.head();
    if (!receipt?.data?.blockNumber)
      throw new Error("Accepted receipt unavailable");
  } catch {
    await markSettlementUncertain(job, "canonical_receipt_unavailable");
    return false;
  }
  if (
    block.hash !== job.block_hash ||
    receipt.data.blockHash !== job.block_hash ||
    BigInt(receipt.data.blockNumber) !== BigInt(job.block_number) ||
    String(receipt.data.transactionHash).toLowerCase() !==
      job.tx_hash.toLowerCase() ||
    BigInt(receipt.data.status) !== 1n ||
    BigInt(head.number) - BigInt(job.block_number) + 1n <
      BigInt(config.CONFIRMATIONS)
  ) {
    await markSettlementUncertain(job, "chain_reorganization");
    return false;
  }
  return true;
}
