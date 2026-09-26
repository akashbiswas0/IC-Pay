import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ContractFactory,
  Transaction,
  getAddress,
  getCreateAddress,
  keccak256,
} from "ethers";
import dotenv from "dotenv";
import { KMSClient } from "@aws-sdk/client-kms";
import { AwsKmsWallets } from "../../apps/api/src/aws-kms.js";
import { validateDeploymentQuote } from "./deploy-multibaas.js";

const FORMAT = "suica-loyalty-deployment-v1";
const CHAIN = "11155111"; // LoyaltyPoints targets Cancun; other networks have not been verified.
type Stage = {
  address: string;
  transactionHash: string;
  nonce: string;
  signedTx: string;
  calldataHash: string;
  status:
    | "signed"
    | "broadcasting"
    | "submitted"
    | "reconciling"
    | "confirmed"
    | "failed";
  signedAt: string;
  broadcastAttemptedAt?: string;
  blockNumber?: string;
  blockHash?: string;
};
export type LoyaltyDeploymentJournal = {
  format: typeof FORMAT;
  chainId: string;
  multibaasUrl: string;
  keyId: string;
  deployer: string;
  administrator: string;
  tokenAddress: string;
  label: string;
  version: string;
  createdAt: string;
  loyalty: Stage | null;
};
const lowerAddress = (value: string) => getAddress(value).toLowerCase();
const isHash = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

export function parseLoyaltyDeploymentJournal(
  value: unknown,
): LoyaltyDeploymentJournal {
  const j = value as LoyaltyDeploymentJournal;
  if (
    !j ||
    j.format !== FORMAT ||
    j.chainId !== CHAIN ||
    typeof j.multibaasUrl !== "string" ||
    typeof j.keyId !== "string" ||
    !j.keyId ||
    !j.label ||
    !j.version ||
    !Number.isFinite(Date.parse(j.createdAt))
  )
    throw new Error("Invalid loyalty deployment journal.");
  for (const address of [j.deployer, j.administrator, j.tokenAddress]) {
    if (lowerAddress(address) === "0x" + "00".repeat(20))
      throw new Error("Zero address in loyalty deployment journal.");
  }
  const s = j.loyalty;
  if (s !== null) {
    if (
      !s ||
      ![
        "signed",
        "broadcasting",
        "submitted",
        "reconciling",
        "confirmed",
        "failed",
      ].includes(s.status) ||
      !isHash(s.transactionHash) ||
      !isHash(s.calldataHash) ||
      !/^\d+$/.test(s.nonce) ||
      !Number.isFinite(Date.parse(s.signedAt))
    )
      throw new Error("Invalid loyalty deployment stage.");
    const tx = Transaction.from(s.signedTx);
    if (
      !tx.signature ||
      tx.chainId !== BigInt(CHAIN) ||
      tx.to !== null ||
      tx.value !== 0n ||
      lowerAddress(tx.from!) !== lowerAddress(j.deployer) ||
      tx.hash !== s.transactionHash ||
      tx.nonce.toString() !== s.nonce ||
      keccak256(tx.data) !== s.calldataHash ||
      lowerAddress(s.address) !==
        getCreateAddress({ from: j.deployer, nonce: s.nonce }).toLowerCase()
    )
      throw new Error(
        "Loyalty signature does not match its deployment journal.",
      );
    if (
      s.status === "confirmed" &&
      (!s.blockNumber || !/^\d+$/.test(s.blockNumber) || !isHash(s.blockHash))
    )
      throw new Error(
        "Confirmed loyalty deployment lacks its canonical block.",
      );
  }
  return j;
}

async function persist(path: string, value: LoyaltyDeploymentJournal) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function lockWallet(path: string): Promise<() => Promise<void>> {
  try {
    const lock = await open(path, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, kind: FORMAT }));
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lock = JSON.parse(await readFile(path, "utf8"));
    if (
      ![
        FORMAT,
        "suica-reward-deployment-v1",
        "suica-collectible-deployment-v1",
        "suica-multibaas-deployment-v1",
      ].includes(lock.kind) ||
      !Number.isSafeInteger(lock.pid) ||
      lock.pid <= 0
    )
      throw new Error(
        "Unknown operator deployment lock; inspect before proceeding.",
      );
    try {
      process.kill(lock.pid, 0);
      throw new Error(
        `Operator deployment is already running (PID ${lock.pid}).`,
      );
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check;
    }
    await unlink(path);
    return lockWallet(path);
  }
  return () => unlink(path);
}
function singleOutput(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) return singleOutput(value[0]);
  if (value && typeof value === "object" && Object.keys(value).length === 1)
    return singleOutput(Object.values(value)[0]);
  return value;
}

async function main() {
  dotenv.config({
    path: fileURLToPath(new URL("../../.env", import.meta.url)),
    quiet: true,
  });
  let execute = false,
    preflight = false,
    resume: string | undefined,
    expectedNonce: number | undefined,
    waitSeconds = 180;
  const arguments_ = process.argv.slice(2);
  for (let i = 0; i < arguments_.length; i++) {
    const flag = arguments_[i];
    if (flag === "--execute") execute = true;
    else if (flag === "--preflight") preflight = true;
    else if (flag === "--resume") {
      resume = arguments_[++i];
      if (!resume) throw new Error("--resume requires a journal path.");
    } else if (flag === "--expected-nonce") {
      expectedNonce = Number(arguments_[++i]);
      if (!Number.isSafeInteger(expectedNonce) || expectedNonce < 0)
        throw new Error("--expected-nonce requires a nonnegative integer.");
    } else if (flag === "--wait-seconds") {
      waitSeconds = Number(arguments_[++i]);
      if (
        !Number.isSafeInteger(waitSeconds) ||
        waitSeconds < 0 ||
        waitSeconds > 900
      )
        throw new Error("--wait-seconds must be 0–900.");
    } else
      throw new Error(
        "Usage: --preflight | --execute --expected-nonce N | --resume JOURNAL [--execute --expected-nonce N] [--wait-seconds 180]",
      );
  }
  if (preflight && (execute || resume))
    throw new Error("Preflight cannot execute or resume.");
  if (
    (process.env.CHAIN_ID || process.env.TESTNET_CHAIN_ID) !== CHAIN ||
    (process.env.TESTNET_CHAIN_ID && process.env.TESTNET_CHAIN_ID !== CHAIN)
  )
    throw new Error("Loyalty deployment requires Sepolia chain 11155111.");
  for (const name of [
    "MULTIBAAS_URL",
    "MULTIBAAS_API_KEY",
    "AWS_KMS_OPERATOR_KEY_ID",
    "CONTRACT_ADMIN_ADDRESS",
    "TOKEN_ADDRESS",
  ])
    if (!process.env[name]) throw new Error(`${name} is required.`);
  if (!resume && execute && process.env.LOYALTY_PAYMENT_ADDRESS)
    throw new Error(
      "A loyalty contract is already configured; inspect its deployment journal instead of redeploying.",
    );
  const url = new URL(process.env.MULTIBAAS_URL!);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("MultiBaas requires a clean HTTPS URL.");
  const base = url
    .toString()
    .replace(/\/$/, "")
    .replace(/\/api\/v0$/, "");
  const keyId = process.env.AWS_KMS_OPERATOR_KEY_ID!;
  const tokenAddress = lowerAddress(process.env.TOKEN_ADDRESS!);
  const administrator = lowerAddress(process.env.CONTRACT_ADMIN_ADDRESS!);
  if ([tokenAddress, administrator].includes("0x" + "00".repeat(20)))
    throw new Error(
      "Token and administrator must be nonzero existing addresses.",
    );
  const confirmations = Number(process.env.CONFIRMATIONS ?? 3);
  if (!Number.isSafeInteger(confirmations) || confirmations < 1)
    throw new Error("CONFIRMATIONS must be positive.");
  let lastRequestAt = 0;
  async function request(path: string, body?: unknown): Promise<any> {
    const readOnly =
      body === undefined ||
      (body as { signAndSubmit?: boolean }).signAndSubmit === false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(Math.max(0, 1000 - (Date.now() - lastRequestAt)));
      lastRequestAt = Date.now();
      const response = await fetch(`${base}/api/v0${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${process.env.MULTIBAAS_API_KEY!}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      });
      // Only reads and unsigned preparation may retry. Signed transaction submission is never retried.
      if (response.status === 429 && readOnly && attempt < 2) {
        const seconds = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        await delay(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, 30000)
            : 5000,
        );
        continue;
      }
      if (response.status === 404 && path.includes("/transactions/receipt/"))
        return null;
      if (!response.ok)
        throw new Error(
          `MultiBaas request failed with HTTP ${response.status}; no response payload logged.`,
        );
      const envelope = (await response.json()) as { result?: unknown };
      if (!("result" in envelope))
        throw new Error("MultiBaas returned no result.");
      return envelope.result;
    }
    throw new Error(
      "MultiBaas read rate limit did not recover; no additional signature requested.",
    );
  }
  const chain = await request("/chains/ethereum/status");
  if (String(chain.chainID) !== CHAIN)
    throw new Error("Actual MultiBaas chain is not Sepolia.");
  const token = await request(
    `/chains/ethereum/addresses/${tokenAddress}?include=code`,
  );
  if (
    typeof token.codeAt !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(token.codeAt) ||
    token.codeAt === "0x0"
  )
    throw new Error(
      "Configured MJPY token has no deployed bytecode. No token will be created by this script.",
    );
  const tokenLabel = encodeURIComponent(
    process.env.TOKEN_CONTRACT || "matsuristablecoin",
  );
  const symbol = await request(
    `/chains/ethereum/addresses/${tokenAddress}/contracts/${tokenLabel}/methods/symbol`,
    { args: [], formatInts: "as_strings", signAndSubmit: false },
  );
  const decimals = await request(
    `/chains/ethereum/addresses/${tokenAddress}/contracts/${tokenLabel}/methods/decimals`,
    { args: [], formatInts: "as_strings", signAndSubmit: false },
  );
  if (
    singleOutput(symbol.output) !== "MJPY" ||
    String(singleOutput(decimals.output)) !== "18"
  )
    throw new Error("Configured token is not the expected 18-decimal MJPY.");
  const regionClient = new KMSClient({});
  const region = process.env.AWS_REGION ?? (await regionClient.config.region());
  regionClient.destroy();
  const kms = new AwsKmsWallets(region);
  const deployer = lowerAddress(await kms.address(keyId));
  const compiled = JSON.parse(
    await readFile(
      new URL(
        "../artifacts/src/LoyaltyPoints.sol/LoyaltyPoints.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const data = (
    await new ContractFactory(
      compiled.abi,
      compiled.bytecode,
    ).getDeployTransaction(tokenAddress, administrator)
  ).data!;
  const journal: LoyaltyDeploymentJournal = resume
    ? parseLoyaltyDeploymentJournal(
        JSON.parse(await readFile(resolve(resume), "utf8")),
      )
    : {
        format: FORMAT,
        chainId: CHAIN,
        multibaasUrl: base,
        keyId,
        deployer,
        administrator,
        tokenAddress,
        label: process.env.LOYALTY_PAYMENT_CONTRACT || "loyaltypoints",
        version: process.env.MULTIBAAS_LOYALTY_CONTRACT_VERSION || "1.0.0",
        createdAt: new Date().toISOString(),
        loyalty: null,
      };
  if (
    journal.multibaasUrl !== base ||
    journal.keyId !== keyId ||
    lowerAddress(journal.deployer) !== deployer ||
    lowerAddress(journal.administrator) !== administrator ||
    lowerAddress(journal.tokenAddress) !== tokenAddress
  )
    throw new Error(
      "Configuration differs from the original loyalty deployment journal.",
    );
  if (journal.loyalty && journal.loyalty.calldataHash !== keccak256(data))
    throw new Error(
      "Compiled constructor differs from the existing signed loyalty deployment.",
    );
  async function prepare() {
    const account = await request(
      `/chains/ethereum/addresses/${deployer}?include=balance&include=nonce`,
    );
    const balance = BigInt(account.balance);
    if (balance <= 0n)
      throw new Error(
        "Operator requires Sepolia ETH before loyalty deployment.",
      );
    const quote = await request(
      `/contracts/${encodeURIComponent(journal.label)}/${encodeURIComponent(journal.version)}/deploy`,
      {
        args: [tokenAddress, administrator],
        from: deployer,
        value: "0",
        signAndSubmit: false,
        nonceManagement: false,
      },
    );
    const tx = validateDeploymentQuote(quote, {
      chainId: CHAIN,
      deployer,
      nonce: expectedNonce ?? account.nonce,
      calldata: data,
    });
    const maxGas =
      BigInt(tx.gasLimit!) * BigInt(tx.maxFeePerGas ?? tx.gasPrice!);
    if (balance < maxGas)
      throw new Error(
        `Insufficient Sepolia gas; ${maxGas} wei required, ${balance} available. No signature created.`,
      );
    return { tx, balance, maxGas };
  }
  if (!resume && !execute) {
    const { tx, balance, maxGas } = await prepare();
    console.log(
      JSON.stringify({
        mode: "preflight",
        chainId: CHAIN,
        existingToken: tokenAddress,
        deployer,
        administrator,
        quoteNonce: tx.nonce,
        loyaltyAddress: getCreateAddress({
          from: deployer,
          nonce: tx.nonce!,
        }).toLowerCase(),
        balanceWei: balance.toString(),
        estimatedMaximumGasWei: maxGas.toString(),
        signing: false,
      }),
    );
    return;
  }
  if (!journal.loyalty && execute && expectedNonce === undefined)
    throw new Error(
      "Fresh signing requires --expected-nonce from the reviewed preflight. Recheck unresolved operator jobs before proceeding.",
    );
  const directory = fileURLToPath(new URL("../deployments/", import.meta.url));
  await mkdir(directory, { recursive: true });
  const path = resume
    ? resolve(resume)
    : resolve(directory, `${CHAIN}-loyalty-${Date.now()}-${randomUUID()}.json`);
  const release = await lockWallet(
    resolve(directory, `.multibaas-${CHAIN}-${deployer}.lock`),
  );
  try {
    if (!resume) {
      for (const file of (await readdir(directory)).filter((f) =>
        f.endsWith(".json"),
      )) {
        let old: any;
        try {
          old = JSON.parse(await readFile(resolve(directory, file), "utf8"));
        } catch {
          continue;
        }
        if (
          old.chainId !== CHAIN ||
          String(old.deployer).toLowerCase() !== deployer
        )
          continue;
        if (old.format === FORMAT && old.tokenAddress === tokenAddress)
          throw new Error(
            `A loyalty deployment journal already exists; resume ${resolve(directory, file)}.`,
          );
        if (
          [
            "suica-reward-deployment-v1",
            "suica-collectible-deployment-v1",
          ].includes(old.format) &&
          old.reward?.status !== "confirmed"
        )
          throw new Error(
            `An earlier router deployment is unresolved: ${resolve(directory, file)}.`,
          );
        if (
          old.format === "suica-multibaas-deployment-v1" &&
          ((old.token && old.token.status !== "confirmed") ||
            (old.token && !old.payments) ||
            (old.payments && old.payments.status !== "confirmed"))
        )
          throw new Error(
            `An operator deployment is unresolved: ${resolve(directory, file)}.`,
          );
      }
      await persist(path, journal);
    }
    console.log(`Loyalty deployment journal: ${path}`);
    if (!journal.loyalty) {
      if (!execute) {
        console.log(
          "Loyalty contract has not been signed. No transaction submitted.",
        );
        return;
      }
      const { tx } = await prepare();
      const signed = await kms.signTransaction(keyId, tx, deployer);
      journal.loyalty = {
        address: getCreateAddress({
          from: deployer,
          nonce: signed.nonce,
        }).toLowerCase(),
        transactionHash: signed.hash,
        nonce: signed.nonce,
        signedTx: signed.signedTx,
        calldataHash: keccak256(data),
        status: "signed",
        signedAt: new Date().toISOString(),
      };
      await persist(path, journal);
      journal.loyalty.status = "broadcasting";
      journal.loyalty.broadcastAttemptedAt = new Date().toISOString();
      await persist(path, journal);
      try {
        const result = await request("/chains/ethereum/transactions/submit", {
          signedTx: signed.signedTx,
        });
        if (
          String(result?.tx?.hash).toLowerCase() !== signed.hash.toLowerCase()
        )
          throw new Error("Submission hash mismatch.");
        journal.loyalty.status = "submitted";
      } catch {
        journal.loyalty.status = "reconciling";
        console.log(
          `Submission outcome unknown. Inspecting existing hash ${signed.hash}; no automatic rebroadcast.`,
        );
      }
      await persist(path, journal);
    }
    const deadline = Date.now() + waitSeconds * 1000;
    do {
      try {
        const stage = journal.loyalty!;
        const receipt = await request(
          `/chains/ethereum/transactions/receipt/${stage.transactionHash}`,
        );
        const receiptData = receipt?.data;
        if (receiptData?.blockNumber) {
          if (
            String(receiptData.transactionHash).toLowerCase() !==
            stage.transactionHash.toLowerCase()
          )
            throw new Error("Receipt hash mismatch.");
          const blockNumber = BigInt(receiptData.blockNumber).toString();
          const block = await request(`/chains/ethereum/blocks/${blockNumber}`);
          const head = await request("/chains/ethereum/blocks/latest");
          if (
            block.hash === receiptData.blockHash &&
            BigInt(head.number) - BigInt(blockNumber) + 1n >=
              BigInt(confirmations)
          ) {
            if (BigInt(receiptData.status) !== 1n) {
              stage.status = "failed";
              await persist(path, journal);
              throw new Error(
                "Loyalty deployment reverted; no retry was signed.",
              );
            }
            if (lowerAddress(receiptData.contractAddress) !== stage.address)
              throw new Error(
                "Receipt creation address differs from the signed journal.",
              );
            const deployed = await request(
              `/chains/ethereum/addresses/${stage.address}?include=code`,
            );
            if (
              typeof deployed.codeAt !== "string" ||
              !/^0x[0-9a-fA-F]+$/.test(deployed.codeAt) ||
              deployed.codeAt === "0x0"
            )
              throw new Error("Loyalty deployment has no contract bytecode.");
            stage.status = "confirmed";
            stage.blockNumber = blockNumber;
            stage.blockHash = block.hash;
            await persist(path, journal);
            console.log(
              JSON.stringify({
                journal: path,
                chainId: CHAIN,
                tokenAddress,
                loyaltyPaymentAddress: stage.address,
                transactionHash: stage.transactionHash,
                blockNumber,
                administrator,
                deployer,
              }),
            );
            return;
          }
        }
        stage.status = "reconciling";
        await persist(path, journal);
      } catch (error) {
        if (journal.loyalty!.status === "failed" || Date.now() >= deadline)
          throw error;
        journal.loyalty!.status = "reconciling";
        await persist(path, journal);
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(5000, deadline - Date.now()));
    } while (Date.now() <= deadline);
    console.log(
      `Loyalty deployment remains unresolved. Resume ${path}; no further signature or broadcast was attempted.`,
    );
  } finally {
    await release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Loyalty deployment failed.",
    );
    process.exitCode = 1;
  });
