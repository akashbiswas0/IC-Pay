import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimatedNativeCost,
  requireNativeBalance,
  weiQuantity,
} from "../src/gas.js";
import { AppError } from "../src/errors.js";

test("native gas quantities retain exact wei precision", () => {
  assert.equal(weiQuantity("0x20000000000001"), 9007199254740993n);
  assert.equal(
    estimatedNativeCost({
      gas: 21000,
      gasPrice: "9007199254740993",
      value: "7",
    }),
    21000n * 9007199254740993n + 7n,
  );
  assert.equal(
    estimatedNativeCost({
      gas: 50000,
      gasFeeCap: "30",
      gasPrice: "10",
      value: "0",
    }),
    1500000n,
  );
});
test("zero and below-estimate gas fail definitively without invented funding", () => {
  const insufficient = (error: unknown) =>
    error instanceof AppError && error.code === "insufficient_gas";
  assert.throws(() => requireNativeBalance(0n), insufficient);
  assert.throws(() => requireNativeBalance(1499999n, 1500000n), insufficient);
  assert.doesNotThrow(() => requireNativeBalance(1500000n, 1500000n));
});
test("malformed or missing provider gas quantities fail closed", () => {
  for (const invalid of [
    undefined,
    null,
    1,
    NaN,
    "-1",
    "1.2",
    "1e18",
    "0x",
    "",
    " 10",
  ])
    assert.throws(() => weiQuantity(invalid));
  for (const gas of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      estimatedNativeCost({ gas, gasPrice: "1", value: "0" }),
    );
  assert.throws(() => estimatedNativeCost({ gas: 21000, value: "0" }));
});
