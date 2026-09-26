import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validWebhook } from "../src/webhooks.js";
import { matchingPaymentLog } from "../src/worker.js";
import { merchantBytes32, paymentABI } from "../src/multibaas.js";
test("payment receipt must match every immutable term, payer and contract", () => {
  const router = "0x" + "11".repeat(20),
    token = "0x" + "22".repeat(20);
  const job = {
    invoice_id: "0x" + "33".repeat(32),
    merchant_id: "23456789-1234-4234-8234-123456789012",
    address: "0x" + "44".repeat(20),
    recipient: "0x" + "55".repeat(20),
    amount: "500",
  };
  const encoded = paymentABI.encodeEventLog(
    paymentABI.getEvent("PaymentCompleted")!,
    [
      job.invoice_id,
      merchantBytes32(job.merchant_id),
      job.address,
      job.recipient,
      token,
      500n,
    ],
  );
  const log = { ...encoded, address: router, removed: false, logIndex: "0x0" };
  assert.equal(matchingPaymentLog([log], job, router, token), log);
  for (const change of [
    { amount: "501" },
    { address: "0x" + "66".repeat(20) },
    { recipient: "0x" + "77".repeat(20) },
    { invoice_id: "0x" + "88".repeat(32) },
  ])
    assert.equal(
      matchingPaymentLog([log], { ...job, ...change }, router, token),
      null,
    );
  assert.equal(
    matchingPaymentLog([{ ...log, removed: true }], job, router, token),
    null,
  );
  assert.equal(
    matchingPaymentLog([log], job, "0x" + "99".repeat(20), token),
    null,
  );
});
test("webhook authentication binds raw bytes and timestamp, rejects stale delivery", () => {
  const raw = Buffer.from('[{"id":"test"}]'),
    secret = "test-only-signature-secret",
    timestamp = "1700000000";
  const signature = createHmac("sha256", secret)
    .update(raw)
    .update(timestamp)
    .digest("hex");
  assert(validWebhook(raw, timestamp, signature, secret, 1700000000000));
  assert(
    !validWebhook(
      Buffer.from('[{"id":"changed"}]'),
      timestamp,
      signature,
      secret,
      1700000000000,
    ),
  );
  assert(!validWebhook(raw, timestamp, signature, secret, 1700000301000));
  assert(!validWebhook(raw, timestamp, "00", secret, 1700000000000));
});
