import { test } from "node:test";
import assert from "node:assert/strict";
import { pointProgress, formatPoints } from "./loyalty-state";

test("fractional earnings show progress without becoming spendable whole points", () => {
  assert.deepEqual(pointProgress("850000000000000000", "1000000000000000000"), {
    percent: 85,
    label: "85% toward your next point",
  });
  assert.equal(
    pointProgress("999999999999999999", "1000000000000000000")?.percent,
    99.99,
  );
  assert.equal(
    pointProgress("1000000000000000000", "1000000000000000000"),
    null,
  );
  assert.equal(pointProgress("1", "0"), null);
  assert.equal(pointProgress("-1", "100"), null);
  assert.equal(formatPoints("9007199254740993"), "9,007,199,254,740,993");
});
