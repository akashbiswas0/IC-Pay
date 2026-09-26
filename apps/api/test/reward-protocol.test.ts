import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { Interface } from "ethers";
import { scanSchema, canonicalScan, verifyScan } from "../src/protocol.js";
import { matchesJobTransaction } from "../src/reconciliation.js";
process.env.REWARD_PAYMENT_ADDRESS = "0x" + "55".repeat(20);
const { rewardABI, validateRewardReceipt, discountFor } =
  await import("../src/rewards.js");
const { merchantBytes32 } = await import("../src/multibaas.js");
const { campaignReceiptMatches } =
  await import("../src/reward-campaign-worker.js");
const router = process.env.REWARD_PAYMENT_ADDRESS;
const job = {
  invoice_id: "0x" + "11".repeat(32),
  merchant_id: randomUUID(),
  address: "0x" + "22".repeat(20),
  expected_router: router,
  expected_token: "0x" + "33".repeat(20),
  expected_chain: "11155111",
  kind: "payment",
  nonce: "7",
  gross_amount: "100",
  amount: "50",
  discount_amount: "50",
  reward_id: "1",
  expires_at: new Date("2026-09-26T00:00:00Z"),
};
test("scan v2 cryptographically binds reward choice, gross amount and router while retaining v1", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const key = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const payload = scanSchema.parse({
    version: 2,
    terminalId: randomUUID(),
    invoiceId: job.invoice_id,
    challenge: "a".repeat(43),
    cardId: "0102030405060708",
    chainId: job.expected_chain,
    token: job.expected_token,
    amount: "100",
    expiresAt: "2026-09-26T00:00:00.000Z",
    routerAddress: router,
    useReward: true,
  });
  const signature = sign("sha256", canonicalScan(payload), privateKey).toString(
    "base64",
  );
  assert(verifyScan(payload, signature, key));
  assert(
    !verifyScan(
      { ...payload, useReward: false } as typeof payload,
      signature,
      key,
    ),
  );
  assert(!verifyScan({ ...payload, amount: "50" }, signature, key));
  assert(
    !verifyScan(
      { ...payload, routerAddress: job.expected_token } as typeof payload,
      signature,
      key,
    ),
  );
  const { routerAddress, useReward, ...legacy } = payload as typeof payload & {
    routerAddress: string;
    useReward: boolean;
  };
  assert(scanSchema.safeParse({ ...legacy, version: 1 }).success);
});
test("redemption receipt requires the exact NFT, merchant, gross, discount and actual charge", () => {
  const encoded = rewardABI.encodeEventLog(
    rewardABI.getEvent("RewardRedeemed")!,
    [
      "1",
      job.address,
      merchantBytes32(job.merchant_id),
      job.invoice_id,
      "100",
      "50",
      "50",
    ],
  );
  const log = { ...encoded, address: router, logIndex: "0x0" };
  assert.equal(validateRewardReceipt([log], job)[0]?.kind, "redeemed");
  for (const changed of [
    { reward_id: "2" },
    { amount: "49" },
    { gross_amount: "101" },
    { discount_amount: "49" },
    { address: job.expected_token },
  ])
    assert.throws(() => validateRewardReceipt([log], { ...job, ...changed }));
  assert.throws(() => validateRewardReceipt([], job));
  assert.throws(() => validateRewardReceipt([{ ...log, removed: true }], job));
});
test("new router calldata binds gross price and chosen NFT instead of the discounted charge", () => {
  const iface = new Interface([
    "function payWithReward(bytes32,bytes32,uint256,uint256,uint256)",
  ]);
  const input = iface.encodeFunctionData("payWithReward", [
    job.invoice_id,
    merchantBytes32(job.merchant_id),
    100,
    Math.floor(job.expires_at.getTime() / 1000),
    1,
  ]);
  const tx = { chainId: "11155111", nonce: "7", to: router, input, value: "0" };
  assert(
    matchesJobTransaction(
      { ...job, merchant_key: merchantBytes32(job.merchant_id) },
      tx,
      job.address,
    ),
  );
  assert(
    !matchesJobTransaction(
      {
        ...job,
        gross_amount: "50",
        merchant_key: merchantBytes32(job.merchant_id),
      },
      tx,
      job.address,
    ),
  );
});
test("reward discounts floor and cap without imposing the earning threshold on redemption", () => {
  assert.equal(discountFor("50", 5000, "100"), 25n);
  assert.equal(discountFor("1000", 5000, "50"), 50n);
  assert.equal(discountFor("1", 5000, "100"), 0n);
});
test("campaign confirmation checks exact immutable requested terms", () => {
  const abi = new Interface([
    "event CampaignUpdated(bytes32 indexed merchantId,uint64 indexed version,bool enabled,uint256 minPurchase,uint16 discountBps,uint256 maxDiscount,uint64 validitySeconds)",
  ]);
  const terms = {
    enabled: true,
    minPurchase: "100",
    discountBps: 5000,
    maxDiscount: "50",
    validitySeconds: 2592000,
  };
  const encoded = abi.encodeEventLog(abi.getEvent("CampaignUpdated")!, [
    merchantBytes32(job.merchant_id),
    1,
    true,
    100,
    5000,
    50,
    2592000,
  ]);
  assert(
    campaignReceiptMatches([{ ...encoded, address: router }], {
      merchant_id: job.merchant_id,
      router_address: router,
      terms,
    }),
  );
  assert(
    !campaignReceiptMatches([{ ...encoded, address: router }], {
      merchant_id: job.merchant_id,
      router_address: router,
      terms: { ...terms, discountBps: 4000 },
    }),
  );
});
