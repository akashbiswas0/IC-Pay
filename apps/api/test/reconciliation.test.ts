import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface, Transaction, Wallet } from "ethers";
import {
  matchingReplacementHashes,
  matchesJobTransaction,
  type ReconciliationJob,
} from "../src/reconciliation.js";
import { merchantBytes32 } from "../src/multibaas.js";

const calls = new Interface([
  "function approve(address spender,uint256 amount)",
  "function pay(bytes32 invoiceId,bytes32 merchantId,uint256 amount,uint256 expiresAt)",
]);
// Real locally generated EVM signatures; no provider stub or simulated HTTP response.
const signer = Wallet.createRandom();
const base: ReconciliationJob = {
  kind: "payment",
  address: signer.address.toLowerCase(),
  nonce: "7",
  expected_chain: "11155111",
  expected_token: "0x" + "11".repeat(20),
  expected_router: "0x" + "22".repeat(20),
  amount: "500",
  invoice_id: "0x" + "33".repeat(32),
  merchant_key: merchantBytes32("12345678-1234-4234-8234-123456789012"),
  expires_at: new Date("2026-09-26T04:00:00.000Z"),
};
async function signedOperation(
  job: ReconciliationJob,
  fee: bigint,
  override: Record<string, unknown> = {},
) {
  const data =
    job.kind === "approval"
      ? calls.encodeFunctionData("approve", [job.expected_router, job.amount])
      : calls.encodeFunctionData("pay", [
          job.invoice_id,
          job.merchant_key,
          job.amount,
          job.expires_at!.getTime() / 1000,
        ]);
  const raw = await signer.signTransaction({
    type: 2,
    chainId: BigInt(job.expected_chain),
    nonce: 7,
    to: job.kind === "approval" ? job.expected_token : job.expected_router,
    value: 0n,
    data,
    gasLimit: 200000n,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: 1n,
    ...override,
  });
  const tx = Transaction.from(raw);
  return {
    from: tx.from!,
    tx: {
      hash: tx.hash!,
      chainId: tx.chainId.toString(),
      nonce: String(tx.nonce),
      to: tx.to!,
      input: tx.data,
      value: tx.value.toString(),
    },
  };
}
test("known-hash payment accepts an exactly matching fee replacement at the same nonce", async () => {
  const original = await signedOperation(base, 100n);
  const replacement = await signedOperation(base, 200n);
  assert.notEqual(original.tx.hash, replacement.tx.hash);
  const pendingJob = { ...base, tx_hash: original.tx.hash };
  assert.deepEqual(matchingReplacementHashes(pendingJob, [replacement]), [
    replacement.tx.hash,
  ]);
  assert(matchesJobTransaction(pendingJob, replacement.tx, replacement.from));
});
test("replacement discovery rejects a cancellation, different nonce, chain, recipient or amount", async () => {
  const variants = await Promise.all([
    signedOperation(base, 200n, { to: signer.address, data: "0x" }),
    signedOperation(base, 200n, { nonce: 8 }),
    signedOperation(base, 200n, { chainId: 1n }),
    signedOperation(base, 200n, { to: base.expected_token }),
    signedOperation({ ...base, amount: "501" }, 200n),
  ]);
  assert.deepEqual(matchingReplacementHashes(base, variants), []);
});
test("pending approval replacement requires exact token owner spender and amount", async () => {
  const approval = { ...base, kind: "approval" };
  const original = await signedOperation(approval, 100n);
  const replacement = await signedOperation(approval, 200n);
  assert.deepEqual(matchingReplacementHashes(approval, [replacement]), [
    replacement.tx.hash,
  ]);
  assert(
    !matchesJobTransaction(approval, replacement.tx, "0x" + "ff".repeat(20)),
  );
  assert(
    !matchesJobTransaction(
      { ...approval, expected_router: base.expected_token },
      replacement.tx,
      replacement.from,
    ),
  );
  assert(
    !matchesJobTransaction(
      { ...approval, amount: "501" },
      replacement.tx,
      replacement.from,
    ),
  );
});
