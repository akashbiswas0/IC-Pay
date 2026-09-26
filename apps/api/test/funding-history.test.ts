import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHistoryReadRequest,
  mergeFundingSources,
  validMultiBaasURL,
  type FundingPage,
} from "../src/funding-history.js";
const row = (byte: string, time: string) => ({
  txHash: "0x" + byte.repeat(64),
  createdAt: time,
});
const ok = (
  rows: ReturnType<typeof row>[],
  truncated = false,
): PromiseFulfilledResult<FundingPage> => ({
  status: "fulfilled",
  value: { rows, truncated },
});
const failed: PromiseRejectedResult = {
  status: "rejected",
  reason: new Error("Source unavailable"),
};
test("funding source merge preserves older indexed transactions and deduplicates primary copies", () => {
  const older = row("a", "2026-09-26T01:00:00.000Z"),
    newer = row("b", "2026-09-26T02:00:00.000Z");
  const result = mergeFundingSources(
    ok([newer]),
    ok([older, { ...newer, createdAt: "2026-09-26T03:00:00.000Z" }]),
  );
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]?.txHash, newer.txHash);
  assert.equal(result.rows[0]?.createdAt, newer.createdAt);
  assert.equal(result.rows[1]?.txHash, older.txHash);
  assert.equal(result.historyComplete, true);
});
test("missing history is explicit while a successful recent source remains useful", () => {
  const result = mergeFundingSources(
    ok([row("a", "2026-09-26T01:00:00.000Z")]),
    failed,
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.historyComplete, false);
  assert.equal(result.historyStatus, "partial");
  assert.equal(mergeFundingSources(failed, ok([])).historyStatus, "partial");
  assert.throws(() => mergeFundingSources(failed, failed));
  assert.equal(mergeFundingSources(ok([], true)).historyComplete, false);
});
test("historical provider request guard permits only chain identity and nonpersistent event queries", () => {
  assert.doesNotThrow(() =>
    assertHistoryReadRequest("/chains/ethereum/status"),
  );
  assert.doesNotThrow(() =>
    assertHistoryReadRequest("/queries?limit=50&offset=0", { events: [] }),
  );
  for (const path of [
    "/chains/ethereum/transactions/submit",
    "/hsm/key/new",
    "/chains/ethereum/addresses/x/contracts/y/methods/pay",
    "/contracts/rewardpayments/deploy",
    "/queries/saved",
    "/queries?limit=100&offset=0",
  ])
    assert.throws(() => assertHistoryReadRequest(path, { anything: true }));
  assert.throws(() => assertHistoryReadRequest("/chains/ethereum/status", {}));
});
test("provider configuration requires HTTPS without embedded credentials or URL query secrets", () => {
  assert(validMultiBaasURL("https://example.multibaas.com/api/v0"));
  for (const url of [
    "http://example.multibaas.com",
    "https://user:secret@example.multibaas.com",
    "https://example.multibaas.com/?api_key=secret",
    "file:///tmp/data",
  ])
    assert(!validMultiBaasURL(url));
});
