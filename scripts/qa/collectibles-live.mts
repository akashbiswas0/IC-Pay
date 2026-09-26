/** Infrastructure-wallet-only live QA. Run only after acquiring the distributed operator lease. */
import { readFile, open, rename, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Interface, Transaction, id, parseEther, ZeroAddress } from "ethers";
import { config } from "../../apps/api/src/config.js";
import { MultiBaas } from "../../apps/api/src/multibaas.js";
import { AwsKmsWallets } from "../../apps/api/src/aws-kms.js";

const OPERATOR = "0xd777e6ac65e24f046980d210356df0e6dc2bd64b";
const ROUTER = "0xa857a22c19a217404ac07fa43e53046ca3f5c592";
const TOKEN = "0x9191e7d4aed20411b2b068f43e40bd325e5ede0e";
const ART =
  "https://main.d21bivg674x6ke.amplifyapp.com/nft-art/07da091cde725ea51a19/";
const CHAIN = "11155111";
const FILE = resolve(".build/collectible-live-qa.json");
const LOCK = resolve(".build/collectible-live-qa.lock");
let ownsLock = false;
const SUMMARY = resolve(".build/collectible-live-qa-summary.json");
const LIFE = 30 * 86400;
const amount = (n: string) => parseEther(n).toString();
const merchantHash = createHash("sha1")
  .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
  .update("https://suica-pay.example/infrastructure/collectibles-live-qa-v1")
  .digest();
merchantHash[6] = (merchantHash[6]! & 15) | 80;
merchantHash[8] = (merchantHash[8]! & 63) | 128;
const hex = merchantHash.subarray(0, 16).toString("hex");
const MERCHANT_UUID = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const MERCHANT = id(MERCHANT_UUID);
const tokenABI = new Interface([
  "function mint(address,uint256)",
  "function approve(address,uint256)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const rewardABI = new Interface(
  JSON.parse(
    await readFile(
      new URL("../../contracts/abi/CollectibleRewards.json", import.meta.url),
      "utf8",
    ),
  ),
);
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function same(a: unknown, b: unknown) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function scalar(value: any): any {
  return Array.isArray(value) && value.length === 1 ? scalar(value[0]) : value;
}
function fields(value: any, names: string[]): any[] {
  if (Array.isArray(value)) return value;
  check(value && typeof value === "object", "invalid_getter_output");
  return names.map((name) => value[name]);
}
type Step = {
  name: string;
  address: string;
  label: string;
  method: string;
  args: any[];
  status: string;
  data?: string;
  nonce?: string;
  signedTx?: string;
  hash?: string;
  blockNumber?: string;
  blockHash?: string;
  attemptedAt?: string;
};
type Journal = {
  format: string;
  runId: string;
  chain: string;
  router: string;
  token: string;
  operator: string;
  merchantUuid: string;
  merchantId: string;
  provider: string;
  keyId: string;
  art: string;
  steps: Record<string, Step>;
  voucherId?: string;
  campaignVersion?: string;
  completedAt?: string;
};
async function persist(path: string, value: unknown) {
  await mkdir(resolve(".build"), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`,
    file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  const directory = await open(resolve(".build"), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
class PacedMultiBaas extends MultiBaas {
  private last = 0;
  override async request(path: string, body?: unknown) {
    await delay(Math.max(0, 750 - (Date.now() - this.last)));
    this.last = Date.now();
    return super.request(path, body);
  }
}
function requireLease() {
  let lease;
  try {
    lease = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/cloud/operator-lease.mjs", "status"],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000 },
      ),
    );
  } catch {
    throw new Error("operator_lease_check_failed");
  }
  const marker = lease.markers?.at(-1);
  check(
    lease.held === true && marker?.expiresAt > Date.now() + 120000,
    "operator_lease_missing_or_near_expiry",
  );
}
function events(receipt: any, address: string, abi: Interface, name: string) {
  return (receipt.logs ?? [])
    .filter((log: any) => !log.removed && same(log.address, address))
    .flatMap((log: any) => {
      try {
        const decoded = abi.parseLog(log);
        return decoded?.name === name ? [decoded.args] : [];
      } catch {
        return [];
      }
    });
}
function one(receipt: any, address: string, abi: Interface, name: string) {
  const found = events(receipt, address, abi, name);
  check(found.length === 1, `expected_one_${name}`);
  return found[0]!;
}
async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  check(
    args.every((a) => a === "--execute"),
    "usage_execute_only",
  );
  if (!args.includes("--execute")) {
    console.log(
      JSON.stringify({
        mode: "prepared",
        signing: false,
        chain: CHAIN,
        operator: OPERATOR,
        router: ROUTER,
        token: TOKEN,
        merchantUuid: MERCHANT_UUID,
        merchantId: MERCHANT,
        journal: FILE,
        instruction:
          "Acquire operator lease, then run with --execute. Repeat the same command to reconcile/resume this journal.",
      }),
    );
    return;
  }
  await mkdir(resolve(".build"), { recursive: true, mode: 0o700 });
  const lock = await open(LOCK, "wx", 0o600);
  ownsLock = true;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
  } finally {
    await lock.close();
  }
  check(
    config.CHAIN_ID === CHAIN && config.TOKEN_ADDRESS === TOKEN,
    "network_configuration_mismatch",
  );
  check(
    (
      config.COLLECTIBLE_PAYMENT_ADDRESS ?? process.env.COLLECTIBLE_ADDRESS
    )?.toLowerCase() === ROUTER,
    "collectible_address_mismatch",
  );
  check(
    config.AWS_KMS_OPERATOR_KEY_ID && config.AWS_REGION && config.MULTIBAAS_URL,
    "missing_runtime_configuration",
  );
  const mb = new PacedMultiBaas(),
    label = config.COLLECTIBLE_PAYMENT_CONTRACT;
  const kms = new AwsKmsWallets(config.AWS_REGION);
  check(
    same(await kms.address(config.AWS_KMS_OPERATOR_KEY_ID), OPERATOR),
    "operator_key_mismatch",
  );
  await mb.validateChain();
  check(
    same(scalar((await mb.call(ROUTER, label, "token", [])).output), TOKEN),
    "router_token_mismatch",
  );
  check(
    same(scalar((await mb.call(ROUTER, label, "owner", [])).output), OPERATOR),
    "router_owner_mismatch",
  );
  check(
    scalar((await mb.call(ROUTER, label, "artworkBaseURI", [])).output) === ART,
    "artwork_base_mismatch",
  );
  let journal: Journal;
  try {
    journal = JSON.parse(await readFile(FILE, "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw new Error("invalid_existing_journal");
    journal = {
      format: "suica-collectible-live-qa-v1",
      runId: randomUUID(),
      chain: CHAIN,
      router: ROUTER,
      token: TOKEN,
      operator: OPERATOR,
      merchantUuid: MERCHANT_UUID,
      merchantId: MERCHANT,
      provider: config.MULTIBAAS_URL,
      keyId: config.AWS_KMS_OPERATOR_KEY_ID,
      art: ART,
      steps: {},
    };
    await persist(FILE, journal);
  }
  check(
    journal.format === "suica-collectible-live-qa-v1" &&
      journal.chain === CHAIN &&
      journal.router === ROUTER &&
      journal.token === TOKEN &&
      journal.operator === OPERATOR &&
      journal.merchantId === MERCHANT &&
      journal.provider === config.MULTIBAAS_URL &&
      journal.keyId === config.AWS_KMS_OPERATOR_KEY_ID &&
      journal.art === ART,
    "journal_configuration_mismatch",
  );
  const invoice = (name: string) =>
    id(`collectible-qa:${journal.runId}:${name}`);
  async function recordSummary() {
    await persist(SUMMARY, {
      chain: CHAIN,
      operator: OPERATOR,
      merchantUuid: MERCHANT_UUID,
      merchantId: MERCHANT,
      router: ROUTER,
      token: TOKEN,
      art: ART,
      voucherId: journal.voucherId,
      completedAt: journal.completedAt,
      expectedScenario: {
        purchase: {
          invoiceId: invoice("earn"),
          gross: amount("100"),
          earnedCredit: amount("5"),
        },
        redemptions: [
          {
            invoiceId: invoice("partial"),
            gross: amount("2"),
            discount: amount("2"),
            net: "0",
            remainingCredit: amount("3"),
          },
          {
            invoiceId: invoice("full"),
            gross: amount("10"),
            discount: amount("3"),
            net: amount("7"),
            remainingCredit: "0",
          },
        ],
      },
      steps: Object.values(journal.steps).map(
        ({ name, status, hash, blockNumber, blockHash }) => ({
          name,
          status,
          hash,
          blockNumber,
          blockHash,
        }),
      ),
    });
  }
  async function run(
    name: string,
    address: string,
    contractLabel: string,
    method: string,
    newArgs: () => Promise<any[]> | any[],
    verify: (receipt: any, block: any) => void | Promise<void>,
  ) {
    let step = journal.steps[name];
    if (step?.status === "skipped") return;
    if (!step) {
      requireLease();
      const callArgs = await newArgs();
      const data = (
        address === TOKEN ? tokenABI : rewardABI
      ).encodeFunctionData(method, callArgs);
      const unsigned = await mb.prepareTransaction(
        address,
        contractLabel,
        method,
        callArgs,
        OPERATOR,
        data,
      );
      requireLease();
      step = journal.steps[name] = {
        name,
        address,
        label: contractLabel,
        method,
        args: callArgs,
        data,
        status: "signing",
      };
      await persist(FILE, journal);
      const signed = await kms.signTransaction(
        config.AWS_KMS_OPERATOR_KEY_ID!,
        unsigned,
        OPERATOR,
      );
      const checked = Transaction.from(signed.signedTx);
      check(
        checked.chainId === BigInt(CHAIN) &&
          same(checked.from, OPERATOR) &&
          same(checked.to, address) &&
          checked.value === 0n &&
          checked.data === data &&
          checked.hash === signed.hash &&
          checked.nonce.toString() === signed.nonce &&
          checked.nonce === unsigned.nonce,
        "signed_transaction_mismatch",
      );
      Object.assign(step, {
        signedTx: signed.signedTx,
        hash: signed.hash,
        nonce: signed.nonce,
        status: "signed",
      });
      await persist(FILE, journal);
      step.status = "broadcasting";
      step.attemptedAt = new Date().toISOString();
      await persist(FILE, journal);
      try {
        await mb.broadcast(signed.signedTx, signed.hash);
        step.status = "pending";
      } catch {
        step.status = "reconciling";
      }
      await persist(FILE, journal);
      console.log(
        JSON.stringify({ step: name, hash: step.hash, status: step.status }),
      );
    }
    check(
      step.address === address &&
        step.label === contractLabel &&
        step.method === method &&
        step.signedTx &&
        step.hash &&
        step.nonce,
      "ambiguous_signature_or_step_mismatch",
    );
    const signed = Transaction.from(step.signedTx);
    const expectedData = (
      address === TOKEN ? tokenABI : rewardABI
    ).encodeFunctionData(method, step.args);
    check(
      signed.chainId === BigInt(CHAIN) &&
        same(signed.from, OPERATOR) &&
        same(signed.to, address) &&
        signed.value === 0n &&
        signed.hash === step.hash &&
        signed.nonce.toString() === step.nonce &&
        signed.data === expectedData &&
        step.data === expectedData,
      "signed_journal_mismatch",
    );
    const deadline = Date.now() + 180000;
    do {
      const receipt = (await mb.receipt(step.hash))?.data;
      if (receipt?.blockNumber) {
        check(
          same(receipt.transactionHash, step.hash),
          "receipt_hash_mismatch",
        );
        const block = await mb.block(String(receipt.blockNumber)),
          head = await mb.head();
        if (
          same(block.hash, receipt.blockHash) &&
          BigInt(head.number) - BigInt(receipt.blockNumber) + 1n >= 3n
        ) {
          check(
            BigInt(receipt.status) === 1n,
            "transaction_reverted_stop_and_reconcile",
          );
          const tx = await mb.transaction(step.hash);
          check(
            same(tx.data?.hash, step.hash) &&
              same(tx.from, OPERATOR) &&
              same(tx.data?.to, address) &&
              same(tx.data?.input, expectedData) &&
              BigInt(tx.data?.nonce) === BigInt(step.nonce) &&
              BigInt(tx.data?.value) === 0n &&
              BigInt(tx.data?.chainId) === BigInt(CHAIN),
            "mined_transaction_mismatch",
          );
          await verify(receipt, block);
          Object.assign(step, {
            status: "confirmed",
            blockNumber: BigInt(receipt.blockNumber).toString(),
            blockHash: receipt.blockHash,
          });
          await persist(FILE, journal);
          await recordSummary();
          console.log(
            JSON.stringify({
              step: name,
              status: "confirmed",
              hash: step.hash,
              block: step.blockNumber,
              voucherId: journal.voucherId,
            }),
          );
          return;
        }
      }
      if (Date.now() >= deadline) break;
      await delay(5000);
    } while (Date.now() < deadline);
    step.status = "reconciling";
    await persist(FILE, journal);
    await recordSummary();
    throw new Error("confirmation_timeout_resume_same_journal");
  }
  const merchantArgs = (enabled: boolean) => [MERCHANT, OPERATOR, enabled];
  const campaignArgs = (enabled: boolean) => [
    MERCHANT,
    enabled,
    amount("1"),
    500,
    amount("50"),
    LIFE,
  ];
  const verifyMerchant = (enabled: boolean) => (r: any) => {
    const e = one(r, ROUTER, rewardABI, "MerchantUpdated");
    check(
      e.merchantId === MERCHANT &&
        same(e.recipient, OPERATOR) &&
        e.enabled === enabled,
      "merchant_receipt_mismatch",
    );
  };
  const verifyCampaign = (enabled: boolean) => (r: any) => {
    const e = one(r, ROUTER, rewardABI, "CampaignUpdated");
    check(
      e.merchantId === MERCHANT &&
        e.enabled === enabled &&
        e.minPurchase === parseEther("1") &&
        e.earnBps === 500n &&
        e.maxCredit === parseEther("50") &&
        e.validitySeconds === BigInt(LIFE),
      "campaign_receipt_mismatch",
    );
    if (enabled) journal.campaignVersion = e.version.toString();
  };
  const verifyApproval = (value: string) => (r: any) => {
    const e = one(r, TOKEN, tokenABI, "Approval");
    check(
      same(e.owner, OPERATOR) &&
        same(e.spender, ROUTER) &&
        e.value === BigInt(value),
      "approval_receipt_mismatch",
    );
  };
  function payment(r: any, name: string, net: string) {
    const e = one(r, ROUTER, rewardABI, "PaymentCompleted");
    check(
      e.invoiceId === invoice(name) &&
        e.merchantId === MERCHANT &&
        same(e.payer, OPERATOR) &&
        same(e.recipient, OPERATOR) &&
        same(e.token, TOKEN) &&
        e.amount === BigInt(net),
      "payment_receipt_mismatch",
    );
    const transfers = events(r, TOKEN, tokenABI, "Transfer");
    if (BigInt(net) === 0n)
      check(transfers.length === 0, "zero_net_transferred_tokens");
    else
      check(
        transfers.length === 1 &&
          same(transfers[0]!.from, OPERATOR) &&
          same(transfers[0]!.to, OPERATOR) &&
          transfers[0]!.value === BigInt(net),
        "net_transfer_mismatch",
      );
  }
  async function expiry() {
    return (BigInt((await mb.head()).timestamp) + 3600n).toString();
  }
  await run(
    "register",
    ROUTER,
    label,
    "setMerchant",
    () => merchantArgs(true),
    verifyMerchant(true),
  );
  await run(
    "campaign",
    ROUTER,
    label,
    "setCampaign",
    () => campaignArgs(true),
    verifyCampaign(true),
  );
  if (!journal.steps.mint) {
    const balance = BigInt(await mb.balance(OPERATOR));
    if (balance >= parseEther("100")) {
      journal.steps.mint = {
        name: "mint",
        address: TOKEN,
        label: config.TOKEN_CONTRACT,
        method: "mint",
        args: [OPERATOR, amount("1000")],
        status: "skipped",
      };
      await persist(FILE, journal);
    }
  }
  if (journal.steps.mint?.status !== "skipped")
    await run(
      "mint",
      TOKEN,
      config.TOKEN_CONTRACT,
      "mint",
      () => [OPERATOR, amount("1000")],
      (r) => {
        const e = one(r, TOKEN, tokenABI, "Transfer");
        check(
          same(e.from, ZeroAddress) &&
            same(e.to, OPERATOR) &&
            e.value === parseEther("1000"),
          "mint_receipt_mismatch",
        );
      },
    );
  await run(
    "approve",
    TOKEN,
    config.TOKEN_CONTRACT,
    "approve",
    () => [ROUTER, amount("200")],
    verifyApproval(amount("200")),
  );
  await run(
    "earn",
    ROUTER,
    label,
    "pay",
    async () => [invoice("earn"), MERCHANT, amount("100"), await expiry()],
    (r, b) => {
      payment(r, "earn", amount("100"));
      const e = one(r, ROUTER, rewardABI, "CreditIssued");
      check(
        e.invoiceId === invoice("earn") &&
          e.merchantId === MERCHANT &&
          same(e.payer, OPERATOR) &&
          e.purchaseAmount === parseEther("100") &&
          e.creditAmount === parseEther("5") &&
          e.earnBps === 500n &&
          e.maxCredit === parseEther("50") &&
          e.campaignVersion.toString() === journal.campaignVersion &&
          e.expiresAt === BigInt(b.timestamp) + BigInt(LIFE),
        "credit_issue_mismatch",
      );
      check(
        !journal.voucherId || journal.voucherId === e.voucherId.toString(),
        "voucher_identity_changed",
      );
      journal.voucherId = e.voucherId.toString();
    },
  );
  check(journal.voucherId, "voucher_missing");
  const verifyUse =
    (
      name: string,
      gross: string,
      discount: string,
      net: string,
      remaining: string,
    ) =>
    (r: any) => {
      payment(r, name, amount(net));
      const e = one(r, ROUTER, rewardABI, "CreditRedeemed");
      check(
        e.voucherId.toString() === journal.voucherId &&
          e.invoiceId === invoice(name) &&
          e.merchantId === MERCHANT &&
          same(e.payer, OPERATOR) &&
          e.grossAmount === parseEther(gross) &&
          e.discount === parseEther(discount) &&
          e.netAmount === parseEther(net) &&
          e.remainingCredit === parseEther(remaining),
        "credit_redemption_mismatch",
      );
      check(
        events(r, ROUTER, rewardABI, "CreditIssued").length === 0,
        "recursive_credit_issued",
      );
      check(
        events(r, ROUTER, rewardABI, "Transfer").every(
          (e) => !same(e.to, ZeroAddress),
        ),
        "collectible_burned",
      );
    };
  await run(
    "partial",
    ROUTER,
    label,
    "payWithReward",
    async () => [
      invoice("partial"),
      MERCHANT,
      amount("2"),
      await expiry(),
      journal.voucherId,
    ],
    verifyUse("partial", "2", "2", "0", "3"),
  );
  check(
    same(
      scalar(
        (await mb.call(ROUTER, label, "ownerOf", [journal.voucherId])).output,
      ),
      OPERATOR,
    ),
    "owner_missing_after_partial",
  );
  if (!journal.steps.full) {
    const partialState = fields(
      (await mb.call(ROUTER, label, "vouchers", [journal.voucherId])).output,
      [
        "merchantId",
        "holder",
        "purchaseAmount",
        "creditAmount",
        "remainingCredit",
        "earnBps",
        "maxCredit",
        "campaignVersion",
        "issuedAt",
        "expiresAt",
        "redeemed",
        "redeemedAt",
        "issuedInvoiceId",
        "redeemedInvoiceId",
      ],
    );
    check(
      BigInt(partialState[4]) === parseEther("3") && partialState[10] === false,
      "partial_credit_state_mismatch",
    );
  }
  await run(
    "full",
    ROUTER,
    label,
    "payWithReward",
    async () => [
      invoice("full"),
      MERCHANT,
      amount("10"),
      await expiry(),
      journal.voucherId,
    ],
    verifyUse("full", "10", "3", "7", "0"),
  );
  check(
    same(
      scalar(
        (await mb.call(ROUTER, label, "ownerOf", [journal.voucherId])).output,
      ),
      OPERATOR,
    ),
    "owner_missing_after_full",
  );
  const voucher = fields(
    (await mb.call(ROUTER, label, "vouchers", [journal.voucherId])).output,
    [
      "merchantId",
      "holder",
      "purchaseAmount",
      "creditAmount",
      "remainingCredit",
      "earnBps",
      "maxCredit",
      "campaignVersion",
      "issuedAt",
      "expiresAt",
      "redeemed",
      "redeemedAt",
      "issuedInvoiceId",
      "redeemedInvoiceId",
    ],
  );
  check(
    voucher[0] === MERCHANT &&
      same(voucher[1], OPERATOR) &&
      BigInt(voucher[2]) === parseEther("100") &&
      BigInt(voucher[3]) === parseEther("5") &&
      BigInt(voucher[4]) === 0n &&
      voucher[10] === true &&
      voucher[13] === invoice("full"),
    "final_voucher_state_mismatch",
  );
  const uri = scalar(
    (await mb.call(ROUTER, label, "tokenURI", [journal.voucherId])).output,
  );
  check(
    typeof uri === "string" && uri.startsWith("data:application/json;base64,"),
    "invalid_metadata_uri",
  );
  const metadata = JSON.parse(
    Buffer.from(uri.slice(29), "base64").toString("utf8"),
  );
  check(
    metadata.image === `${ART}${BigInt(journal.voucherId) % 3n}.jpg` &&
      metadata.attributes.some(
        (v: any) => v.trait_type === "Status" && v.value === "redeemed",
      ),
    "metadata_mismatch",
  );
  await run(
    "revoke",
    TOKEN,
    config.TOKEN_CONTRACT,
    "approve",
    () => [ROUTER, "0"],
    verifyApproval("0"),
  );
  await run(
    "pause-campaign",
    ROUTER,
    label,
    "setCampaign",
    () => campaignArgs(false),
    verifyCampaign(false),
  );
  await run(
    "disable-merchant",
    ROUTER,
    label,
    "setMerchant",
    () => merchantArgs(false),
    verifyMerchant(false),
  );
  check(
    BigInt(await mb.allowance(OPERATOR, ROUTER)) === 0n,
    "cleanup_allowance_not_zero",
  );
  const merchantState = fields(
    (await mb.call(ROUTER, label, "merchants", [MERCHANT])).output,
    ["recipient", "enabled"],
  );
  const campaign = fields(
    (await mb.call(ROUTER, label, "campaigns", [MERCHANT])).output,
    [
      "enabled",
      "minPurchase",
      "earnBps",
      "maxCredit",
      "validitySeconds",
      "version",
    ],
  );
  check(
    same(merchantState[0], OPERATOR) &&
      merchantState[1] === false &&
      campaign[0] === false,
    "cleanup_not_disabled",
  );
  journal.completedAt ??= new Date().toISOString();
  await persist(FILE, journal);
  await recordSummary();
  console.log(
    JSON.stringify({
      complete: true,
      operator: OPERATOR,
      voucherId: journal.voucherId,
      nftStillOwned: true,
      remainingCredit: "0",
      allowance: "0",
      qaDisabled: true,
      summary: SUMMARY,
    }),
  );
}
main()
  .catch((error) => {
    const code =
      typeof error?.message === "string" && /^[A-Za-z_]+$/.test(error.message)
        ? error.message
        : typeof error?.code === "string" && /^[a-z_]+$/.test(error.code)
          ? error.code
          : "qa_stopped_inspect_journal";
    console.error(
      JSON.stringify({
        stopped: true,
        code,
        journal: FILE,
        action:
          "Keep journal; do not create a new signature for an ambiguous step.",
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (ownsLock) await unlink(LOCK);
  });
