import assert from "node:assert/strict";
const configured = new URL(process.env.DATABASE_URL!);
assert.equal(configured.pathname, "/suica_payments_test");
const { pool } = await import("../../src/db.js");
const client = await pool.connect();
const row = (
  await client.query(
    "SELECT pg_backend_pid()::int pid,current_database() db,current_setting('application_name') application",
  )
).rows[0];
assert.equal(row.db, "suica_payments_test");
assert.equal(row.application, process.env.IDLE_TEST_APPLICATION);
client.release();
process.stdout.write(JSON.stringify({ stage: "idle", ...row }) + "\n");
process.stdin.once("data", () => {
  void (async () => {
    const next = (
      await pool.query(
        "SELECT pg_backend_pid()::int pid,current_database() db,1 value",
      )
    ).rows[0];
    assert.equal(next.db, "suica_payments_test");
    assert.equal(next.value, 1);
    assert.notEqual(next.pid, row.pid);
    process.stdout.write(
      JSON.stringify({ stage: "reconnected", ...next }) + "\n",
    );
    process.stdin.pause();
    await pool.end();
  })().catch(() => {
    process.stderr.write("Idle connection reconnect probe failed\n");
    process.exitCode = 1;
    process.stdin.pause();
    void pool.end();
  });
});
