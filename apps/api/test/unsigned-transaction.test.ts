import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface, Transaction } from "ethers";
import { validateUnsignedTransaction } from "../src/unsigned-transaction.js";
const data = new Interface([
  "function approve(address,uint256)",
]).encodeFunctionData("approve", ["0x" + "22".repeat(20), 500n]);
const expected = {
  chainId: "11155111",
  nonce: 7,
  from: "0x" + "33".repeat(20),
  to: "0x" + "11".repeat(20),
  data,
};
const quote = {
  submitted: false,
  tx: {
    from: expected.from,
    to: expected.to,
    data,
    value: "0",
    type: 2,
    nonce: 7,
    gas: 50000,
    gasFeeCap: "30",
    gasTipCap: "2",
  },
};
test("unsigned MultiBaas quote is bound to intended chain, account, contract and calldata", () => {
  const tx = Transaction.from(validateUnsignedTransaction(quote, expected));
  assert.equal(tx.chainId, 11155111n);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.to!.toLowerCase(), expected.to);
  assert.equal(tx.data, data);
  assert.equal(tx.maxFeePerGas, 30n);
  assert.equal(tx.maxPriorityFeePerGas, 2n);
});
test("unsigned quote rejects changed economic terms and unsafe numeric values before KMS", () => {
  for (const changed of [
    { from: expected.to },
    { to: expected.from },
    { data: "0x" },
    { value: "1" },
    { chainId: "1" },
    { nonce: 8 },
    { nonce: -1 },
    { nonce: 0.5 },
    { nonce: Number.MAX_SAFE_INTEGER + 1 },
    { gas: 0 },
    { gas: NaN },
    { gasFeeCap: "1", gasTipCap: "2" },
    { type: 4 },
    { authorizationList: [{}] },
    { accessList: [{}] },
  ])
    assert.throws(() =>
      validateUnsignedTransaction(
        { ...quote, tx: { ...quote.tx, ...changed } },
        expected,
      ),
    );
  assert.throws(() =>
    validateUnsignedTransaction({ ...quote, submitted: true }, expected),
  );
  assert.throws(() => validateUnsignedTransaction({ tx: quote.tx }, expected));
});
test("legacy quote uses actual quoted gas price without inventing a fee", () => {
  const tx = Transaction.from(
    validateUnsignedTransaction(
      { ...quote, tx: { ...quote.tx, type: 0, gasPrice: "9" } },
      expected,
    ),
  );
  assert.equal(tx.gasPrice, 9n);
  assert.equal(tx.type, 0);
  assert.throws(() =>
    validateUnsignedTransaction(
      { ...quote, tx: { ...quote.tx, type: 0 } },
      expected,
    ),
  );
});

test("missing optional address nonce uses the validated nonzero node-built quote, never assumed zero", () => {
  const tx = Transaction.from(
    validateUnsignedTransaction(quote, { ...expected, nonce: undefined }),
  );
  assert.equal(tx.nonce, 7);
  for (const nonce of [
    undefined,
    null,
    "7",
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() =>
      validateUnsignedTransaction(
        { ...quote, tx: { ...quote.tx, nonce } },
        { ...expected, nonce: undefined },
      ),
    );
});
