import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
const database = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL worker schedule prioritizes fresh work and honors webhook wakeups",
  { skip: !database },
  async () => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "schedule_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const { pool } = await import("../src/db.js");
    const { loadDuePaymentJobs } = await import("../src/worker.js");
    try {
      for (const name of (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter((v) => v.endsWith(".sql"))
        .sort())
        await pool.query(
          await readFile(
            new URL("../migrations/" + name, import.meta.url),
            "utf8",
          ),
        );
      const account = randomUUID(),
        wallet = randomUUID();
      await pool.query("INSERT INTO accounts(id) VALUES($1)", [account]);
      await pool.query(
        "INSERT INTO wallets(id,account_id,key_name,status) VALUES($1,$2,'schedule-fixture','ready')",
        [wallet, account],
      );
      const ids: Record<string, string> = {};
      for (const [name, status, error, age] of [
        ["fresh", "queued", null, 0],
        ["blocked", "queued", "wallet_operation_pending", 0],
        ["retry", "queued", "wallet_operation_pending", 31],
        ["pending", "pending", null, 0],
        ["due", "pending", null, 13],
        ["unknown", "reconciling", "submission_unknown", 13],
        ["recentConfirmed", "confirmed", null, 299],
        ["oldConfirmed", "confirmed", null, 301],
        ["wake", "pending", null, 0],
      ] as const) {
        ids[name] = randomUUID();
        await pool.query(
          "INSERT INTO payment_jobs(id,account_id,wallet_id,kind,amount,status,error_code,updated_at) VALUES($1,$2,$3,'payment',1,$4,$5,now()-$6*interval '1 second')",
          [ids[name], account, wallet, status, error, age],
        );
      }
      await pool.query(
        "UPDATE payment_jobs SET updated_at=to_timestamp(0) WHERE id=$1",
        [ids.wake],
      );
      const selected = await loadDuePaymentJobs();
      const set = new Set(selected.map((j) => j.id));
      for (const name of [
        "fresh",
        "retry",
        "due",
        "unknown",
        "oldConfirmed",
        "wake",
      ])
        assert(set.has(ids[name]), name);
      for (const name of ["blocked", "pending", "recentConfirmed"])
        assert(!set.has(ids[name]), name);
      assert.equal(selected[0].status, "queued");
      assert.equal(selected.at(-1).status, "confirmed");
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
