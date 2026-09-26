import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAmount, parseAmount, safeExternalUrl } from "./money.ts";
test("amounts never pass through floating point", () => {
  assert.equal(
    formatAmount("12345678901234567890123456789", 18),
    "12,345,678,901.234567890123456789",
  );
  assert.equal(
    parseAmount("12345678901.234567890123456789", 18),
    "12345678901234567890123456789",
  );
  assert.equal(formatAmount("0", 18), "0");
  assert.equal(formatAmount("500", 0), "500");
});
test("invalid, negative, zero or overprecision input cannot become a payment", () => {
  for (const v of ["0", "-1", "1e3", "NaN", "1.001", "1,000"])
    assert.throws(() => parseAmount(v, 2));
});
test("transaction links accept only HTTPS URLs", () => {
  assert.equal(safeExternalUrl("javascript:alert(1)"), undefined);
  assert.equal(
    safeExternalUrl("https://example.com/tx/1"),
    "https://example.com/tx/1",
  );
});
