import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withinBudget } from "../src/protocol.js";
process.env.COLLECTIBLE_PAYMENT_ADDRESS = "0x" + "88".repeat(20);
process.env.REWARD_PAYMENT_ADDRESS = "0x" + "55".repeat(20);
process.env.COLLECTIBLE_ARTWORK_BASE_URL =
  "https://assets.example/art/immutable/";
const { creditABI, rewardABI, validateRewardReceipt, collectibleImage } =
  await import("../src/rewards.js");
const { merchantBytes32 } = await import("../src/multibaas.js");
const { assertPaymentModel } = await import("../src/payment-router.js");
const { matchingPaymentLog } = await import("../src/worker.js");
const { paymentABI } = await import("../src/multibaas.js");
const router = process.env.COLLECTIBLE_PAYMENT_ADDRESS;
const job = {
  kind: "payment",
  invoice_id: "0x" + "11".repeat(32),
  merchant_id: randomUUID(),
  address: "0x" + "22".repeat(20),
  recipient: "0x" + "33".repeat(20),
  expected_router: router,
  reward_model: "credit",
  expected_token: "0x" + "44".repeat(20),
  gross_amount: "50",
  amount: "0",
  discount_amount: "50",
  reward_credit_before: "70",
  reward_id: "1",
};
function redemption(changes: Record<string, unknown> = {}) {
  const args = {
    id: "1",
    payer: job.address,
    merchant: merchantBytes32(job.merchant_id),
    invoice: job.invoice_id,
    gross: "50",
    discount: "50",
    net: "0",
    remaining: "20",
    ...changes,
  };
  return {
    ...creditABI.encodeEventLog(
      creditABI.getEvent("CreditRedeemed")!,
      Object.values(args),
    ),
    address: router,
    logIndex: "0x1",
  };
}
test("zero-net credit payment requires exact gross, redeemed credit and retained remainder events", () => {
  assertPaymentModel(job);
  const log = redemption();
  assert.equal(validateRewardReceipt([log], job)[0]?.kind, "redeemed");
  for (const change of [
    { remaining: "0" },
    { net: "1" },
    { discount: "49" },
    { gross: "51" },
    { id: "2" },
    { payer: job.recipient },
  ])
    assert.throws(() => validateRewardReceipt([redemption(change)], job));
  for (const change of [
    { reward_credit_before: "69" },
    { reward_credit_before: null },
    { expected_router: process.env.REWARD_PAYMENT_ADDRESS },
  ])
    assert.throws(() => validateRewardReceipt([log], { ...job, ...change }));
  assert.throws(() => validateRewardReceipt([], job));
  assert.throws(() => validateRewardReceipt([log, log], job));
  const completed = {
    ...paymentABI.encodeEventLog(paymentABI.getEvent("PaymentCompleted")!, [
      job.invoice_id,
      merchantBytes32(job.merchant_id),
      job.address,
      job.recipient,
      job.expected_token,
      0,
    ]),
    address: router,
    logIndex: "0x2",
  };
  assert(matchingPaymentLog([log, completed], job, router, job.expected_token));
  assert.equal(
    matchingPaymentLog([log], job, router, job.expected_token),
    null,
  );
});
test("positive-net final credit consumption uses full remaining amount", () => {
  const final = {
    ...job,
    gross_amount: "100",
    amount: "30",
    discount_amount: "70",
  };
  const log = redemption({
    gross: "100",
    discount: "70",
    net: "30",
    remaining: "0",
  });
  assert.equal(validateRewardReceipt([log], final)[0]?.kind, "redeemed");
  assert.throws(() =>
    validateRewardReceipt([log], { ...final, gross_amount: "101" }),
  );
});
test("credit issuance amount derives from actual purchase with integer rounding and cap", () => {
  const purchase = {
    ...job,
    gross_amount: "1000",
    amount: "1000",
    discount_amount: "0",
    reward_id: null,
  };
  const args = [
    "2",
    job.address,
    merchantBytes32(job.merchant_id),
    job.invoice_id,
    "3",
    "1000",
    "40",
    500,
    "40",
    Math.floor(Date.now() / 1000) + 3600,
  ];
  const log = {
    ...creditABI.encodeEventLog(creditABI.getEvent("CreditIssued")!, args),
    address: router,
    logIndex: "0x0",
  };
  assert.equal(validateRewardReceipt([log], purchase)[0]?.kind, "earned");
  const altered = [...args];
  altered[6] = "41";
  assert.throws(() =>
    validateRewardReceipt(
      [
        {
          ...log,
          ...creditABI.encodeEventLog(
            creditABI.getEvent("CreditIssued")!,
            altered,
          ),
        },
      ],
      purchase,
    ),
  );
  assert.throws(() => validateRewardReceipt([log], job));
});
test("zero-net authorization remains prohibited for legacy or percentage routes", () => {
  for (const change of [
    { expected_router: process.env.REWARD_PAYMENT_ADDRESS },
    { reward_model: "percentage" },
    { reward_id: null },
    { gross_amount: "0" },
    { discount_amount: "49" },
    { amount: "-1" },
  ])
    assert.throws(() => assertPaymentModel({ ...job, ...change }));
  assert.equal(withinBudget("0", "50", "100", "100", "0"), false);
  assert.equal(withinBudget("0", "50", "100", "100", "0", true), true);
  assert.equal(withinBudget("0", "50", "100", "101", "0", true), false);
  const percentage = {
    ...job,
    expected_router: process.env.REWARD_PAYMENT_ADDRESS,
    amount: "25",
    discount_amount: "25",
    reward_model: "percentage",
  };
  const log = {
    ...rewardABI.encodeEventLog(rewardABI.getEvent("RewardRedeemed")!, [
      1,
      job.address,
      merchantBytes32(job.merchant_id),
      job.invoice_id,
      50,
      25,
      25,
    ]),
    address: percentage.expected_router,
    logIndex: "0x0",
  };
  assert.equal(validateRewardReceipt([log], percentage)[0]?.kind, "redeemed");
});
test("collectible image comes only from actual tokenURI JSON and configured immutable HTTPS directory", () => {
  const uri = (image: string) =>
    "data:application/json;base64," +
    Buffer.from(JSON.stringify({ image })).toString("base64");
  assert.equal(
    collectibleImage(uri("https://assets.example/art/immutable/1.jpg")),
    "https://assets.example/art/immutable/1.jpg",
  );
  for (const image of [
    "https://other.example/1.jpg",
    "https://assets.example/art/immutable/../1.jpg",
    "http://assets.example/art/immutable/1.jpg",
    "https://user:pass@assets.example/art/immutable/1.jpg",
    "https://assets.example/art/immutable/1.jpg?secret=x",
    "javascript:alert(1)",
  ])
    assert.equal(collectibleImage(uri(image)), null);
  assert.equal(collectibleImage("not metadata"), null);
});
