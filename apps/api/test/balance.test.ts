import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTokenBalance } from "../src/multibaas.js";

test("token balance decoding preserves real zero and large integer precision", () => {
  assert.equal(decodeTokenBalance("0"), "0");
  assert.equal(
    decodeTokenBalance("900719925474099300000000"),
    "900719925474099300000000",
  );
  assert.equal(decodeTokenBalance(0), "0");
});
test("missing and malformed provider balances never become displayed zero", () => {
  for (const value of [
    undefined,
    null,
    "undefined",
    "NaN",
    "-1",
    "1.1",
    "1e18",
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    (1n << 256n).toString(),
  ])
    assert.throws(() => decodeTokenBalance(value));
});
