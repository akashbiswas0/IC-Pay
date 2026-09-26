import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEventTimestamp } from "../src/multibaas.js";

test("real MultiBaas PostgreSQL event timestamps become portable ISO timestamps", () => {
  assert.equal(
    normalizeEventTimestamp("2026-09-26 04:19:36+00"),
    "2026-09-26T04:19:36.000Z",
  );
  assert.equal(
    normalizeEventTimestamp("2026-09-26 13:19:36.123456+09"),
    "2026-09-26T04:19:36.123Z",
  );
  assert.equal(
    normalizeEventTimestamp("2026-09-26T04:19:36.000Z"),
    "2026-09-26T04:19:36.000Z",
  );
});
test("missing, invalid or timezone-ambiguous event timestamps are not invented", () => {
  for (const value of [
    null,
    undefined,
    123,
    "2026-09-26 04:19:36",
    "not-a-date",
    "2026-99-99 04:19:36+00",
  ])
    assert.throws(() => normalizeEventTimestamp(value));
});
