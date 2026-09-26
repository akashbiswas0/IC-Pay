import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnminedReceiptResponse } from "../src/multibaas.js";
const path = "/chains/ethereum/transactions/receipt/0x" + "ab".repeat(32);
test("only an exact GET receipt 404 is classified as pending or unknown", () => {
  assert(isUnminedReceiptResponse(path, undefined, 404));
  for (const status of [200, 400, 401, 403, 429, 500])
    assert(!isUnminedReceiptResponse(path, undefined, status));
  assert(!isUnminedReceiptResponse(path, {}, 404));
  for (const other of [
    "/chains/ethereum/status",
    "/chains/ethereum/transactions/0x" + "ab".repeat(32),
    "/chains/ethereum/transactions/receipt/not-a-hash",
    path + "?extra=true",
  ])
    assert(!isUnminedReceiptResponse(other, undefined, 404));
});
