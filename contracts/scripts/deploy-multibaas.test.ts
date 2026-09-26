import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ContractFactory,
  Transaction,
  Wallet,
  getCreateAddress,
  keccak256,
} from "ethers";
import {
  parseDeploymentJournal,
  validateDeploymentQuote,
  type DeploymentJournal,
} from "./deploy-multibaas.js";
const signer = Wallet.createRandom();
const artifact = JSON.parse(
  await readFile(
    new URL(
      "../artifacts/src/MatsuriStablecoin.sol/MatsuriStablecoin.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const compiled = await new ContractFactory(
  artifact.abi,
  artifact.bytecode,
).getDeployTransaction("Matsuri Yen", "MJPY", signer.address);
const data = String(compiled.data);
const expected = {
  chainId: "11155111",
  deployer: signer.address,
  nonce: 7,
  calldata: data,
};
const quote = {
  submitted: false,
  deployAt: getCreateAddress({ from: signer.address, nonce: 7 }),
  tx: {
    from: signer.address,
    to: null,
    data,
    value: "0",
    type: 2,
    nonce: 7,
    gas: 2000000,
    gasFeeCap: "100",
    gasTipCap: "2",
  },
};
test("MultiBaas deployment quote binds exact compiled token constructor and CREATE address", () => {
  const parsed = Transaction.from(validateDeploymentQuote(quote, expected));
  assert.equal(parsed.to, null);
  assert.equal(parsed.data, data);
  assert.equal(parsed.chainId, 11155111n);
  assert.equal(parsed.nonce, 7);
  assert.equal(parsed.gasLimit, 2000000n);
});
test("deployment quote rejects changed constructor owner, sender, recipient, nonce, value and chain", async () => {
  const wrongOwner = String(
    (
      await new ContractFactory(
        artifact.abi,
        artifact.bytecode,
      ).getDeployTransaction(
        "Matsuri Yen",
        "MJPY",
        Wallet.createRandom().address,
      )
    ).data,
  );
  for (const changed of [
    { data: wrongOwner },
    { from: Wallet.createRandom().address },
    { to: signer.address },
    { nonce: 8 },
    { value: "1" },
    { chainId: "1" },
    { gas: 1.1 },
    { gasFeeCap: "1", gasTipCap: "2" },
  ])
    assert.throws(() =>
      validateDeploymentQuote(
        { ...quote, tx: { ...quote.tx, ...changed } },
        expected,
      ),
    );
  assert.throws(() =>
    validateDeploymentQuote({ ...quote, submitted: true }, expected),
  );
  assert.throws(() =>
    validateDeploymentQuote(
      { ...quote, deployAt: Wallet.createRandom().address },
      expected,
    ),
  );
  assert.throws(() =>
    validateDeploymentQuote(quote, { ...expected, chainId: "1" }),
  );
});
test("resume journal verifies actual EVM signature, local hash and predicted address before use", async () => {
  const signedTx = await signer.signTransaction(
    validateDeploymentQuote(quote, expected),
  );
  const tx = Transaction.from(signedTx);
  const journal: DeploymentJournal = {
    format: "suica-multibaas-deployment-v1",
    chainId: "11155111",
    multibaasUrl: "https://deployment.multibaas.com",
    keyId: "test-key-reference",
    deployer: signer.address.toLowerCase(),
    administrator: signer.address.toLowerCase(),
    createdAt: new Date().toISOString(),
    tokenLabel: "matsuristablecoin",
    paymentsLabel: "demopayments",
    libraryVersion: "1.0.0",
    token: {
      address: quote.deployAt.toLowerCase(),
      transactionHash: tx.hash!,
      nonce: "7",
      signedTx,
      calldataHash: keccak256(data),
      status: "reconciling",
      signedAt: new Date().toISOString(),
    },
    payments: null,
  };
  assert.equal(
    parseDeploymentJournal(JSON.parse(JSON.stringify(journal))).token!
      .transactionHash,
    tx.hash,
  );
  for (const changed of [
    { nonce: "8" },
    { transactionHash: "0x" + "aa".repeat(32) },
    { address: Wallet.createRandom().address },
    { calldataHash: "0x" + "bb".repeat(32) },
    { signedTx: signedTx.slice(0, -2) },
    { status: "confirmed" },
  ])
    assert.throws(() =>
      parseDeploymentJournal({
        ...journal,
        token: { ...journal.token, ...changed },
      }),
    );
  assert.throws(() =>
    parseDeploymentJournal({
      ...journal,
      deployer: Wallet.createRandom().address,
    }),
  );
  assert.throws(() => parseDeploymentJournal({ ...journal, chainId: "6497" }));
});

test("deployment uses required quote nonce when optional address nonce is absent", () => {
  const tx = Transaction.from(
    validateDeploymentQuote(quote, { ...expected, nonce: undefined }),
  );
  assert.equal(tx.nonce, 7);
  for (const nonce of [undefined, null, "7", -1, 0.5])
    assert.throws(() =>
      validateDeploymentQuote(
        { ...quote, tx: { ...quote.tx, nonce } },
        { ...expected, nonce: undefined },
      ),
    );
});
