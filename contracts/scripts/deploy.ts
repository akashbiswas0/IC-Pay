import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { network } from "hardhat";
import {
  getAddress,
  getCreateAddress,
  NonceManager,
  type Signer,
} from "ethers";
import { AwsKmsWallets } from "../../apps/api/src/aws-kms.js";
import { AwsKmsSigner } from "./aws-kms-signer.js";

// Validate the selected chain and administrator before any signing or transaction submission.
const expectedChain = process.env.TESTNET_CHAIN_ID;
if (expectedChain !== "6497" && expectedChain !== "11155111") {
  throw new Error(
    "TESTNET_CHAIN_ID must explicitly select 6497 (Awaji) or 11155111 (Sepolia).",
  );
}
const administrator = process.env.CONTRACT_ADMIN_ADDRESS;
if (!administrator) throw new Error("CONTRACT_ADMIN_ADDRESS is required.");
const owner = getAddress(administrator);
if (owner === "0x0000000000000000000000000000000000000000")
  throw new Error("Administrator cannot be the zero address.");
const operatorKey = process.env.AWS_KMS_OPERATOR_KEY_ID;
if (operatorKey && !process.env.AWS_REGION)
  throw new Error("AWS_REGION is required for AWS KMS deployment.");
if (!operatorKey && !process.env.DEPLOYER_PRIVATE_KEY)
  throw new Error(
    "Configure AWS_KMS_OPERATOR_KEY_ID and AWS_REGION, or explicitly supply DEPLOYER_PRIVATE_KEY.",
  );
const { ethers } = await network.create();
const actualChain = (await ethers.provider.getNetwork()).chainId.toString();
if (actualChain !== expectedChain)
  throw new Error(
    `RPC chain ${actualChain} differs from configured testnet ${expectedChain}.`,
  );

type Stage = {
  address: string;
  transactionHash: string;
  nonce: string;
  status: "signed" | "submitted" | "confirmed";
  blockNumber?: number;
};
const output = new URL(
  `../deployments/${actualChain}-${Date.now()}-${randomUUID()}.json`,
  import.meta.url,
);
const deployment = {
  chainId: actualChain,
  administrator: owner,
  deployer: "",
  signing: operatorKey ? "aws-kms" : "explicit-private-key",
  token: null as (Stage & { symbol: string; decimals: number }) | null,
  payments: null as Stage | null,
};
await mkdir(new URL("../deployments/", import.meta.url), { recursive: true });
async function persist() {
  const temporary = new URL(`${output.href}.tmp`);
  await writeFile(temporary, `${JSON.stringify(deployment, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, output);
}
let stage: "token" | "payments" = "token";
let rawSigner: Signer;
if (operatorKey) {
  const wallets = new AwsKmsWallets(process.env.AWS_REGION!);
  rawSigner = new AwsKmsSigner(
    wallets,
    operatorKey,
    BigInt(expectedChain),
    ethers.provider,
    async (signed) => {
      const record: Stage = {
        address: getCreateAddress({
          from: deployment.deployer,
          nonce: signed.nonce,
        }),
        transactionHash: signed.hash,
        nonce: signed.nonce,
        status: "signed",
      };
      if (stage === "token")
        deployment.token = { ...record, symbol: "MJPY", decimals: 18 };
      else deployment.payments = record;
      await persist();
    },
  );
} else {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("A funded DEPLOYER_PRIVATE_KEY is required.");
  rawSigner = signer;
}
const deployer = new NonceManager(rawSigner);
deployment.deployer = await deployer.getAddress();
await persist();
console.log(
  `Deployment journal: ${output.pathname}. Signing with ${deployment.signing} wallet ${deployment.deployer}.`,
);

const tokenFactory = await ethers.getContractFactory(
  "MatsuriStablecoin",
  deployer,
);
const token = await tokenFactory.deploy("Matsuri Yen", "MJPY", owner);
const tokenTx = token.deploymentTransaction()!;
deployment.token = {
  address: await token.getAddress(),
  transactionHash: tokenTx.hash,
  nonce: tokenTx.nonce.toString(),
  status: "submitted",
  symbol: "MJPY",
  decimals: 18,
};
await persist();
await token.waitForDeployment();
const tokenReceipt = await tokenTx.wait();
if (!tokenReceipt || tokenReceipt.status !== 1)
  throw new Error(
    "MJPY deployment did not succeed; inspect the deployment journal.",
  );
deployment.token.status = "confirmed";
deployment.token.blockNumber = tokenReceipt.blockNumber;
await persist();
console.log(`MJPY deployed: ${deployment.token.address}.`);

stage = "payments";
const paymentFactory = await ethers.getContractFactory(
  "DemoPayments",
  deployer,
);
const payments = await paymentFactory.deploy(deployment.token.address, owner);
const paymentTx = payments.deploymentTransaction()!;
deployment.payments = {
  address: await payments.getAddress(),
  transactionHash: paymentTx.hash,
  nonce: paymentTx.nonce.toString(),
  status: "submitted",
};
await persist();
await payments.waitForDeployment();
const paymentReceipt = await paymentTx.wait();
if (!paymentReceipt || paymentReceipt.status !== 1)
  throw new Error(
    "DemoPayments deployment did not succeed; inspect the deployment journal.",
  );
deployment.payments.status = "confirmed";
deployment.payments.blockNumber = paymentReceipt.blockNumber;
await persist();
console.log(
  `DemoPayments deployed: ${deployment.payments.address}. No merchants, balances, or allowances have been configured.`,
);
