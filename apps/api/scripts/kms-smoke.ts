import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ContractFactory,
  JsonRpcProvider,
  Transaction,
  parseEther,
  id,
} from "ethers";
import { AwsKmsWallets } from "../src/aws-kms.js";

// Explicit integration command, never part of the offline unit-test suite.
// Uses one existing real AWS key and real contracts on a loopback Hardhat chain.
process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const keyId = process.env.AWS_KMS_OPERATOR_KEY_ID;
if (!keyId || !process.env.AWS_REGION)
  throw new Error("Configure AWS_REGION and AWS_KMS_OPERATOR_KEY_ID first.");
const rpc = process.env.KMS_TEST_RPC_URL ?? "http://127.0.0.1:18545";
const url = new URL(rpc);
if (
  url.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
)
  throw new Error("This test only permits a local HTTP EVM endpoint.");
const provider = new JsonRpcProvider(rpc);
try {
  const network = await provider.getNetwork();
  assert.equal(
    network.chainId,
    31337n,
    "This test only funds and transacts on local chain 31337.",
  );
  const kms = new AwsKmsWallets(process.env.AWS_REGION);
  const address = await kms.address(keyId);
  const recovered = await kms.recoverWallet("operator");
  assert.equal(
    recovered.address,
    address,
    "Tagged operator-key recovery must return the same wallet.",
  );
  const deployer = await provider.getSigner(0);
  const recipient = await (await provider.getSigner(1)).getAddress();
  await (
    await deployer.sendTransaction({ to: address, value: parseEther("1") })
  ).wait();
  const artifact = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(
          `../../../contracts/artifacts/src/${name}.sol/${name}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const tokenArtifact = await artifact("MatsuriStablecoin");
  const paymentArtifact = await artifact("DemoPayments");
  const token = await new ContractFactory(
    tokenArtifact.abi,
    tokenArtifact.bytecode,
    deployer,
  ).deploy("Matsuri JPY", "MJPY", await deployer.getAddress());
  await token.waitForDeployment();
  const router = await new ContractFactory(
    paymentArtifact.abi,
    paymentArtifact.bytecode,
    deployer,
  ).deploy(await token.getAddress(), await deployer.getAddress());
  await router.waitForDeployment();
  const merchantId = id("local-kms-integration-merchant");
  await (
    await router.getFunction("setMerchant")(merchantId, recipient, true)
  ).wait();
  await (await token.getFunction("mint")(address, parseEther("100"))).wait();
  async function send(to: string, data: string, legacy: boolean) {
    const fee = await provider.getFeeData();
    const transaction = {
      chainId: network.chainId,
      nonce: await provider.getTransactionCount(address, "pending"),
      to,
      data,
      value: 0n,
      gasLimit: 300000n,
      ...(legacy
        ? { type: 0, gasPrice: fee.gasPrice! }
        : {
            type: 2,
            maxFeePerGas: fee.maxFeePerGas!,
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas!,
          }),
    };
    const signed = await kms.signTransaction(keyId!, transaction, address);
    assert.equal(
      Transaction.from(signed.signedTx).from?.toLowerCase(),
      address,
    );
    const sent = await provider.broadcastTransaction(signed.signedTx);
    assert.equal(sent.hash, signed.hash);
    const receipt = await sent.wait();
    assert.equal(receipt?.status, 1);
    return receipt!;
  }
  await send(
    await token.getAddress(),
    token.interface.encodeFunctionData("approve", [
      await router.getAddress(),
      parseEther("25"),
    ]),
    true,
  );
  const invoiceId = id(`kms-live-${Date.now()}`);
  const block = await provider.getBlock("latest");
  const receipt = await send(
    await router.getAddress(),
    router.interface.encodeFunctionData("pay", [
      invoiceId,
      merchantId,
      parseEther("25"),
      block!.timestamp + 300,
    ]),
    false,
  );
  assert.equal(await token.getFunction("balanceOf")(address), parseEther("75"));
  assert.equal(
    await token.getFunction("balanceOf")(recipient),
    parseEther("25"),
  );
  assert.equal(await router.getFunction("settled")(address, invoiceId), true);
  const completed = receipt.logs
    .map((log) => {
      try {
        return router.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((log) => log?.name === "PaymentCompleted");
  assert.equal(completed?.args.payer.toLowerCase(), address);
  assert.equal(completed?.args.amount, parseEther("25"));
  console.log(
    JSON.stringify(
      {
        result: "passed",
        signing: "real AWS KMS",
        chain: "local EVM 31337",
        wallet: address,
        checks: [
          "existing tagged key recovery",
          "legacy approval signed by KMS",
          "EIP-1559 payment signed by KMS",
          "receipt and exact balances",
        ],
        paymentHash: receipt.hash,
      },
      null,
      2,
    ),
  );
} finally {
  provider.destroy();
}
