import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBlockNumber } from "../src/multibaas.js";

test("receipt hex block quantities become decimal MultiBaas lookup identifiers", () => {
  assert.equal(normalizeBlockNumber("0xb3ce7a"), "11783802");
  assert.equal(normalizeBlockNumber("11783802"), "11783802");
  assert.equal(normalizeBlockNumber("0x0"), "0");
  assert.equal(normalizeBlockNumber("000001"), "1");
  assert.equal(normalizeBlockNumber("0x20000000000001"), "9007199254740993");
});
test("invalid block identifiers fail before a provider request can be constructed", () => {
  for (const value of [
    undefined,
    null,
    11783802,
    -1,
    "-1",
    "-0x1",
    "0x",
    "1.5",
    "1e3",
    "latest",
    "../latest",
    " 1",
    "1?include=anything",
  ])
    assert.throws(() => normalizeBlockNumber(value));
});
