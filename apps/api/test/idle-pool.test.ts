import { test } from "node:test";
import assert from "node:assert/strict";
import { probeIdlePool } from "./support/idle-pool-probe.js";
const database = process.env.TEST_DATABASE_URL;
test(
  "production pool survives its own idle connection loss and reconnects to the isolated test database",
  { skip: !database },
  async () => {
    const result = await probeIdlePool(database!);
    assert.equal(result.database, "suica_payments_test");
    assert.equal(result.unhandledError, false);
    assert.equal(result.reconnected, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.safeLog, true);
  },
);
