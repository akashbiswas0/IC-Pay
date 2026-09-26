import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHmac } from "node:crypto";
import {
  canonicalScan,
  cardHash,
  fieldHash,
  scanSchema,
  signWorldRequest,
  verifyScan,
  withinBudget,
} from "../src/protocol.js";
const scan = scanSchema.parse({
  version: 1,
  terminalId: "bfc4e3bb-bd54-4db9-a04d-26f19d841b59",
  invoiceId: "0x" + "ab".repeat(32),
  challenge: "a".repeat(43),
  cardId: "0102030405060708",
  chainId: "11155111",
  token: "0x" + "12".repeat(20),
  amount: "500",
  expiresAt: "2026-09-26T04:00:00.000Z",
});
test("P-256 signature binds every invoice and card field", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const key = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const signature = sign("sha256", canonicalScan(scan), privateKey).toString(
    "base64",
  );
  assert(verifyScan(scan, signature, key));
  for (const changed of [
    { amount: "501" },
    { cardId: "0102030405060709" },
    { challenge: "b".repeat(43) },
    { chainId: "1" },
    { token: "0x" + "13".repeat(20) },
    { expiresAt: "2026-09-26T04:00:01.000Z" },
  ])
    assert.equal(verifyScan({ ...scan, ...changed }, signature, key), false);
  assert.throws(() =>
    scanSchema.parse({ ...scan, cardId: "0102030405060708\n" }),
  );
});
test("card identifier storage is secret-keyed and normalized strictly", () => {
  assert.notEqual(
    cardHash(scan.cardId, "a".repeat(32)),
    cardHash(scan.cardId, "b".repeat(32)),
  );
  assert.throws(() => cardHash("ffffffffffffffff", "a".repeat(32)));
});
test("integer budget includes concurrent reservations without numeric rounding", () => {
  assert(withinBudget("5", "5", "9007199254741000", "9007199254740990", "5"));
  assert(!withinBudget("6", "6", "9007199254741000", "9007199254740990", "5"));
  assert(!withinBudget("6", "5", "10", "0", "0"));
});
test("World request signature matches official session test vector", async () => {
  assert.equal(
    fieldHash(new Uint8Array()),
    "0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4",
  );
  const value = await signWorldRequest(
    "ab".repeat(32),
    Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    1700000000,
  );
  assert.equal(
    value.nonce,
    "0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd",
  );
  assert.equal(
    value.signature,
    "0x14f693175773aed912852a601e9c0fd30f2afe2738d31388316232ce6f64ae9e4edbfb19d81c4229ba9c9fca78ede4b28956b7ba4415f08d957cbc1b3bdaa4021b",
  );
});
