import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  ContractFactory,
  Transaction,
  getAddress,
  getCreateAddress,
  keccak256,
  type TransactionLike,
} from "ethers";
import { KMSClient } from "@aws-sdk/client-kms";
import dotenv from "dotenv";
import { AwsKmsWallets } from "../../apps/api/src/aws-kms.js";

const format = "suica-multibaas-deployment-v1";
const allowedChains = new Set(["6497", "11155111"]);
const stages = ["token", "payments"] as const;
type StageName = (typeof stages)[number];
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
export type DeploymentJournal = {
  format: typeof format;
  chainId: string;
  multibaasUrl: string;
  keyId: string;
  deployer: string;
  administrator: string;
  createdAt: string;
  tokenLabel: string;
  paymentsLabel: string;
  libraryVersion: string;
  token: Stage | null;
  payments: Stage | null;
};
type Artifact = { abi: any[]; bytecode: string };
const address = (value: unknown) => {
  if (typeof value !== "string") throw new Error("Invalid journal address.");
  return getAddress(value).toLowerCase();
};
const quantity = (value: unknown) => {
  if (typeof value !== "string" || !/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value))
    throw new Error("Invalid transaction quantity from MultiBaas.");
  return BigInt(value);
};
const digest = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

// The live MultiBaas version omits optional Address.nonce, including for a registered
// address. Its required TransactionToSignTx.nonce is the authoritative prepared
// nonce; compare the independent address value whenever supplied, never assume zero.
export function validateDeploymentQuote(
  quote: any,
  expected: {
    chainId: string;
    deployer: string;
    nonce?: number;
    calldata: string;
  },
): TransactionLike {
  const tx = quote?.tx;
  if (
    !allowedChains.has(expected.chainId) ||
    quote?.submitted !== false ||
    !tx ||
    address(tx.from) !== address(expected.deployer) ||
    // MultiBaas omits `to` for creation; both undefined and null mean no recipient.
    (tx.to !== undefined && tx.to !== null) ||
    String(tx.data).toLowerCase() !== expected.calldata.toLowerCase() ||
    quantity(tx.value) !== 0n ||
    !Number.isSafeInteger(tx.nonce) ||
    tx.nonce < 0 ||
    (expected.nonce !== undefined &&
      (!Number.isSafeInteger(expected.nonce) || tx.nonce !== expected.nonce)) ||
    !Number.isSafeInteger(tx.gas) ||
    tx.gas <= 0 ||
    ![0, 2].includes(tx.type) ||
    tx.accessList?.length ||
    tx.authorizationList?.length
  )
    throw new Error(
      "Unsigned deployment does not match the exact compiled constructor transaction.",
    );
  if (
    tx.chainId !== undefined &&
    BigInt(tx.chainId) !== BigInt(expected.chainId)
  )
    throw new Error("Unsigned deployment has the wrong chain ID.");
  const predicted = getCreateAddress({
    from: expected.deployer,
    nonce: tx.nonce,
  }).toLowerCase();
  if (quote.deployAt !== undefined && address(quote.deployAt) !== predicted)
    throw new Error("MultiBaas predicted a different contract address.");
  const common = {
    chainId: BigInt(expected.chainId),
    type: tx.type,
    nonce: tx.nonce,
    to: null,
    data: expected.calldata,
    value: 0n,
    gasLimit: BigInt(tx.gas),
  };
  if (tx.type === 0) return { ...common, gasPrice: quantity(tx.gasPrice) };
  const maxFeePerGas = quantity(tx.gasFeeCap),
    maxPriorityFeePerGas = quantity(tx.gasTipCap);
  if (maxPriorityFeePerGas > maxFeePerGas)
    throw new Error("Priority fee exceeds the fee cap.");
  return { ...common, maxFeePerGas, maxPriorityFeePerGas };
}

export function parseDeploymentJournal(value: unknown): DeploymentJournal {
  const j = value as DeploymentJournal;
  if (
    !j ||
    j.format !== format ||
    !allowedChains.has(j.chainId) ||
    typeof j.multibaasUrl !== "string" ||
    typeof j.keyId !== "string" ||
    !j.keyId ||
    !Number.isFinite(Date.parse(j.createdAt)) ||
    !j.tokenLabel ||
    !j.paymentsLabel ||
    !j.libraryVersion
  )
    throw new Error("Unsupported or incomplete deployment journal.");
  address(j.deployer);
  address(j.administrator);
  if (j.payments && !j.token)
    throw new Error("Router journal has no token deployment.");
  for (const name of stages) {
    const stage = j[name];
    if (stage === null) continue;
    if (
      !stage ||
      ![
        "signed",
        "broadcasting",
        "submitted",
        "reconciling",
        "confirmed",
        "failed",
      ].includes(stage.status) ||
      !digest(stage.transactionHash) ||
      !digest(stage.calldataHash) ||
      typeof stage.nonce !== "string" ||
      !/^\d+$/.test(stage.nonce) ||
      !Number.isFinite(Date.parse(stage.signedAt))
    )
      throw new Error(`Invalid ${name} journal record.`);
    const tx = Transaction.from(stage.signedTx);
    if (
      !tx.signature ||
      tx.to !== null ||
      tx.value !== 0n ||
      tx.chainId !== BigInt(j.chainId) ||
      address(tx.from) !== address(j.deployer) ||
      tx.nonce.toString() !== stage.nonce ||
      tx.hash !== stage.transactionHash ||
      keccak256(tx.data) !== stage.calldataHash ||
      address(stage.address) !==
        getCreateAddress({ from: j.deployer, nonce: stage.nonce }).toLowerCase()
    )
      throw new Error(`Signed ${name} transaction does not match its journal.`);
    if (
      stage.status === "confirmed" &&
      (!stage.blockNumber ||
        !/^\d+$/.test(stage.blockNumber) ||
        !digest(stage.blockHash))
    )
      throw new Error(
        "Confirmed journal record is missing its accepted block.",
      );
  }
  return j;
}

async function atomicPersist(path: string, journal: DeploymentJournal) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
class MultiBaasClient {
  constructor(
    readonly base: string,
    private key: string,
  ) {}
  async request(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.base}/api/v0${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (response.status === 404 && path.includes("/transactions/receipt/"))
      return null;
    if (!response.ok)
      throw new Error(
        `MultiBaas ${body === undefined ? "read" : "request"} failed with HTTP ${response.status}; no API credentials or response payload logged.`,
      );
    const payload = (await response.json()) as { result?: unknown };
    if (!("result" in payload))
      throw new Error("MultiBaas returned no result.");
    return payload.result;
  }
}
async function acquireLock(path: string) {
  try {
    const lock = await open(path, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, kind: format }));
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(path, "utf8")) as {
      pid: number;
      kind: string;
    };
    if (
      previous.kind !== format ||
      !Number.isSafeInteger(previous.pid) ||
      previous.pid <= 0
    )
      throw new Error(
        "Deployment lock exists with unknown ownership; inspect it before proceeding.",
      );
    try {
      process.kill(previous.pid, 0);
      throw new Error(
        `Another deployment process owns the wallet lock (PID ${previous.pid}).`,
      );
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check;
    }
    await unlink(path);
    return acquireLock(path);
  }
  return () => unlink(path);
}

async function artifact(name: string): Promise<Artifact> {
  return JSON.parse(
    await readFile(
      new URL(`../artifacts/src/${name}.sol/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}
async function constructorData(name: StageName, j: DeploymentJournal) {
  const compiled = await artifact(
    name === "token" ? "MatsuriStablecoin" : "DemoPayments",
  );
  const args =
    name === "token"
      ? ["Matsuri Yen", "MJPY", j.administrator]
      : [j.token!.address, j.administrator];
  const tx = await new ContractFactory(
    compiled.abi,
    compiled.bytecode,
  ).getDeployTransaction(...args);
  if (typeof tx.data !== "string")
    throw new Error("Compiled artifact contains no constructor calldata.");
  return { args, data: tx.data };
}

async function main() {
  dotenv.config({
    path: fileURLToPath(new URL("../../.env", import.meta.url)),
    quiet: true,
  });
  const args = process.argv.slice(2);
  let resume: string | undefined;
  let execute = false;
  let preflight = false;
  let waitSeconds = 180;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute") execute = true;
    else if (args[i] === "--preflight") preflight = true;
    else if (args[i] === "--resume") {
      resume = args[++i];
      if (!resume)
        throw new Error("--resume requires the existing journal path.");
    } else if (args[i] === "--wait-seconds") {
      waitSeconds = Number(args[++i]);
      if (
        !Number.isSafeInteger(waitSeconds) ||
        waitSeconds < 0 ||
        waitSeconds > 900
      )
        throw new Error("--wait-seconds must be 0–900.");
    } else
      throw new Error(
        "Usage: --preflight | --execute [--wait-seconds 180] | --resume JOURNAL [--execute] [--wait-seconds 180]",
      );
  }
  if (preflight && (execute || resume))
    throw new Error("--preflight cannot sign or resume a journal.");
  const chainId = process.env.CHAIN_ID || process.env.TESTNET_CHAIN_ID || "";
  if (
    !allowedChains.has(chainId) ||
    (process.env.CHAIN_ID &&
      process.env.TESTNET_CHAIN_ID &&
      process.env.CHAIN_ID !== process.env.TESTNET_CHAIN_ID)
  )
    throw new Error(
      "Explicitly select the same supported testnet in CHAIN_ID/TESTNET_CHAIN_ID: 6497 or 11155111.",
    );
  const keyId = process.env.AWS_KMS_OPERATOR_KEY_ID;
  const apiKey = process.env.MULTIBAAS_API_KEY;
  if (
    !keyId ||
    !apiKey ||
    !process.env.MULTIBAAS_URL ||
    !process.env.CONTRACT_ADMIN_ADDRESS
  )
    throw new Error(
      "AWS_KMS_OPERATOR_KEY_ID, MULTIBAAS_URL, MULTIBAAS_API_KEY and CONTRACT_ADMIN_ADDRESS are required.",
    );
  const url = new URL(process.env.MULTIBAAS_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("MULTIBAAS_URL must be a clean HTTPS deployment URL.");
  const base = url
    .toString()
    .replace(/\/$/, "")
    .replace(/\/api\/v0$/, "");
  const administrator = address(process.env.CONTRACT_ADMIN_ADDRESS);
  if (administrator === "0x" + "00".repeat(20))
    throw new Error("Administrator must not be zero.");
  const regionClient = new KMSClient({});
  const region = process.env.AWS_REGION ?? (await regionClient.config.region());
  regionClient.destroy();
  const kms = new AwsKmsWallets(region);
  const deployer = address(await kms.address(keyId));
  const mb = new MultiBaasClient(base, apiKey);
  const live = await mb.request("/chains/ethereum/status");
  if (String(live.chainID) !== chainId)
    throw new Error("Configured and live MultiBaas chain IDs differ.");
  const confirmations = Number(process.env.CONFIRMATIONS ?? "3");
  if (!Number.isSafeInteger(confirmations) || confirmations < 1)
    throw new Error("CONFIRMATIONS must be a positive integer.");
  const directory = fileURLToPath(new URL("../deployments/", import.meta.url));
  let journal: DeploymentJournal;
  if (resume) {
    journal = parseDeploymentJournal(
      JSON.parse(await readFile(resolve(resume), "utf8")),
    );
    if (
      journal.chainId !== chainId ||
      journal.multibaasUrl !== base ||
      journal.keyId !== keyId ||
      address(journal.deployer) !== deployer ||
      address(journal.administrator) !== administrator
    )
      throw new Error(
        "Current configuration differs from the deployment journal; restore its original configuration.",
      );
  } else
    journal = {
      format,
      chainId,
      multibaasUrl: base,
      keyId,
      deployer,
      administrator,
      createdAt: new Date().toISOString(),
      tokenLabel: process.env.TOKEN_CONTRACT || "matsuristablecoin",
      paymentsLabel: process.env.PAYMENT_CONTRACT || "demopayments",
      libraryVersion: process.env.MULTIBAAS_CONTRACT_VERSION || "1.0.0",
      token: null,
      payments: null,
    };
  // Public-key lookup and chain reads above never sign. Default mode stops at preflight.
  if (!resume && !execute) {
    const account = await mb.request(
      `/chains/ethereum/addresses/${deployer}?include=balance&include=nonce`,
    );
    const balance = quantity(account.balance);
    if (balance === 0n)
      throw new Error(
        `Insufficient native gas: ${deployer} has zero testnet balance. No signature, deployment or journal was created.`,
      );
    const { args: constructorArgs, data } = await constructorData(
      "token",
      journal,
    );
    const quote = await mb.request(
      `/contracts/${encodeURIComponent(journal.tokenLabel)}/${encodeURIComponent(journal.libraryVersion)}/deploy`,
      {
        args: constructorArgs,
        from: deployer,
        value: "0",
        signAndSubmit: false,
        nonceManagement: false,
      },
    );
    const tx = validateDeploymentQuote(quote, {
      chainId,
      deployer,
      nonce: account.nonce,
      calldata: data,
    });
    const required =
      BigInt(tx.gasLimit!) * BigInt(tx.maxFeePerGas ?? tx.gasPrice!);
    if (balance < required)
      throw new Error(
        `Insufficient native gas for the current token deployment quote: ${required} wei required, ${balance} available. No signature created.`,
      );
    console.log(
      JSON.stringify({
        mode: "preflight",
        chainId,
        deployer,
        administrator,
        balanceWei: balance.toString(),
        tokenEstimatedMaximumGasWei: required.toString(),
        signing: false,
      }),
    );
    return;
  }
  await mkdir(directory, { recursive: true });
  const journalPath = resume
    ? resolve(resume)
    : resolve(
        directory,
        `${chainId}-multibaas-${Date.now()}-${randomUUID()}.json`,
      );
  const release = await acquireLock(
    resolve(directory, `.multibaas-${chainId}-${deployer}.lock`),
  );
  try {
    if (!resume) {
      for (const filename of (await readdir(directory)).filter((n) =>
        n.endsWith(".json"),
      )) {
        let previous: any;
        try {
          previous = JSON.parse(
            await readFile(resolve(directory, filename), "utf8"),
          );
        } catch {
          continue;
        }
        if (
          previous.format === format &&
          previous.chainId === chainId &&
          previous.deployer === deployer &&
          ((previous.token && previous.token.status !== "confirmed") ||
            (previous.token && !previous.payments) ||
            (previous.payments && previous.payments.status !== "confirmed"))
        )
          throw new Error(
            `An unfinished deployment already exists. Resume ${resolve(directory, filename)}; do not create another transaction.`,
          );
      }
      await atomicPersist(journalPath, journal);
    }
    console.log(`Deployment journal: ${journalPath}`);
    async function inspect(name: StageName): Promise<boolean> {
      const stage = journal[name]!;
      const expected = await constructorData(name, journal);
      if (keccak256(expected.data) !== stage.calldataHash)
        throw new Error(
          `Compiled ${name} constructor differs from the signed journal; refusing to continue.`,
        );
      const receipt = await mb.request(
        `/chains/ethereum/transactions/receipt/${stage.transactionHash}`,
      );
      const data = receipt?.data;
      if (!data?.blockNumber) {
        stage.status = "reconciling";
        await atomicPersist(journalPath, journal);
        return false;
      }
      if (
        String(data.transactionHash).toLowerCase() !==
        stage.transactionHash.toLowerCase()
      )
        throw new Error("Receipt transaction hash mismatch.");
      const block = await mb.request(
        `/chains/ethereum/blocks/${BigInt(data.blockNumber).toString()}`,
      );
      const head = await mb.request("/chains/ethereum/blocks/latest");
      if (
        block.hash !== data.blockHash ||
        BigInt(head.number) - BigInt(data.blockNumber) + 1n <
          BigInt(confirmations)
      ) {
        stage.status = "reconciling";
        await atomicPersist(journalPath, journal);
        return false;
      }
      if (quantity(data.status) !== 1n) {
        stage.status = "failed";
        await atomicPersist(journalPath, journal);
        throw new Error(
          `${name} deployment reverted. Its journal is retained; no retry or replacement was submitted.`,
        );
      }
      if (address(data.contractAddress) !== address(stage.address))
        throw new Error(
          "Confirmed creation address differs from the predicted journal address.",
        );
      const deployed = await mb.request(
        `/chains/ethereum/addresses/${stage.address}?include=code`,
      );
      if (
        typeof deployed.codeAt !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(deployed.codeAt) ||
        deployed.codeAt === "0x0"
      )
        throw new Error("Confirmed deployment has no contract bytecode.");
      stage.status = "confirmed";
      stage.blockNumber = BigInt(data.blockNumber).toString();
      stage.blockHash = data.blockHash;
      await atomicPersist(journalPath, journal);
      return true;
    }
    for (const name of stages) {
      if (!journal[name]) {
        if (!execute) {
          console.log(
            `${name} has not been signed. Resume with --execute only when ready to start this next stage.`,
          );
          return;
        }
        const account = await mb.request(
          `/chains/ethereum/addresses/${deployer}?include=balance&include=nonce`,
        );
        const balance = quantity(account.balance);
        if (balance === 0n)
          throw new Error(
            "Insufficient native gas. No signature was requested for this stage.",
          );
        const constructor = await constructorData(name, journal);
        const label =
          name === "token" ? journal.tokenLabel : journal.paymentsLabel;
        const quote = await mb.request(
          `/contracts/${encodeURIComponent(label)}/${encodeURIComponent(journal.libraryVersion)}/deploy`,
          {
            args: constructor.args,
            from: deployer,
            value: "0",
            signAndSubmit: false,
            nonceManagement: false,
          },
        );
        const tx = validateDeploymentQuote(quote, {
          chainId,
          deployer,
          nonce: account.nonce,
          calldata: constructor.data,
        });
        if (
          balance <
          BigInt(tx.gasLimit!) * BigInt(tx.maxFeePerGas ?? tx.gasPrice!)
        )
          throw new Error(
            "Insufficient native gas for the actual unsigned quote. No signature was requested.",
          );
        const signed = await kms.signTransaction(keyId, tx, deployer);
        journal[name] = {
          address: getCreateAddress({
            from: deployer,
            nonce: signed.nonce,
          }).toLowerCase(),
          transactionHash: signed.hash,
          nonce: signed.nonce,
          signedTx: signed.signedTx,
          calldataHash: keccak256(constructor.data),
          status: "signed",
          signedAt: new Date().toISOString(),
        };
        await atomicPersist(journalPath, journal);
        journal[name]!.status = "broadcasting";
        journal[name]!.broadcastAttemptedAt = new Date().toISOString();
        await atomicPersist(journalPath, journal);
        try {
          const result = await mb.request(
            "/chains/ethereum/transactions/submit",
            { signedTx: signed.signedTx },
          );
          if (
            String(result?.tx?.hash).toLowerCase() !== signed.hash.toLowerCase()
          )
            throw new Error(
              "Broadcast did not return the locally computed hash.",
            );
          journal[name]!.status = "submitted";
          await atomicPersist(journalPath, journal);
        } catch {
          journal[name]!.status = "reconciling";
          await atomicPersist(journalPath, journal);
          console.log(
            `Submission outcome unknown for ${name}; inspecting existing hash ${signed.hash}, never rebroadcasting.`,
          );
        }
      }
      const deadline = Date.now() + waitSeconds * 1000;
      let confirmed = false;
      do {
        try {
          confirmed = await inspect(name);
        } catch (error) {
          if (journal[name]!.status === "failed") throw error;
          journal[name]!.status = "reconciling";
          await atomicPersist(journalPath, journal);
          if (Date.now() >= deadline) throw error;
        }
        if (confirmed) break;
        if (Date.now() >= deadline) break;
        await delay(Math.min(5000, deadline - Date.now()));
      } while (Date.now() <= deadline);
      if (!confirmed) {
        console.log(
          `${name} remains unresolved. Resume ${journalPath} to inspect its existing receipt. No further transaction was signed.`,
        );
        return;
      }
      console.log(
        `${name} confirmed: ${journal[name]!.address} (${journal[name]!.transactionHash})`,
      );
    }
    console.log(
      JSON.stringify({
        journal: journalPath,
        chainId,
        tokenAddress: journal.token!.address,
        paymentAddress: journal.payments!.address,
        administrator,
        deployer,
      }),
    );
  } finally {
    await release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Deployment failed.",
    );
    process.exitCode = 1;
  });
}
