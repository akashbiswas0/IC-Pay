import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomUUID,
  randomBytes,
  sign,
} from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import {
  canonicalScan,
  cardHash,
  hash,
  randomToken,
  scanSchema,
} from "../src/protocol.js";
const database = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL all-merchant consent is explicit and rechecked for every scan and signature",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "scope_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      MULTIBAAS_URL: "",
      MULTIBAAS_API_KEY: "",
      PAYMENT_ADDRESS: "0x" + "11".repeat(20),
      TOKEN_ADDRESS: "0x" + "22".repeat(20),
      CHAIN_ID: "11155111",
      REWARD_PAYMENT_ADDRESS: "",
      CARD_HMAC_SECRET: "scope-test-secret-at-least-32-characters",
    });
    const { pool, transaction } = await import("../src/db.js");
    const { config } = await import("../src/config.js");
    const { buildServer } = await import("../src/server.js");
    const { authorizeForSigning } = await import("../src/worker.js");
    const app = await buildServer();
    try {
      for (const name of (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await pool.query(
          await readFile(
            new URL("../migrations/" + name, import.meta.url),
            "utf8",
          ),
        );
      const account = randomUUID(),
        cardId = randomUUID(),
        walletId = randomUUID(),
        session = randomToken(),
        physical = "0102030405060708",
        address = "0x" + "33".repeat(20);
      const headers = { authorization: `Bearer ${session}` };
      await pool.query("INSERT INTO accounts(id,verified)VALUES($1,true)", [
        account,
      ]);
      await pool.query(
        "INSERT INTO sessions(token_hash,account_id,expires_at)VALUES($1,$2,now()+interval '1 hour')",
        [hash(session), account],
      );
      await pool.query(
        "INSERT INTO cards(id,card_hash,account_id,last4)VALUES($1,$2,$3,'0708')",
        [cardId, cardHash(physical, config.CARD_HMAC_SECRET), account],
      );
      await pool.query(
        "INSERT INTO wallets(id,account_id,card_id,address,key_name,key_id,provider,status)VALUES($1,$2,$3,$4,$5,'scope-key','aws_kms','ready')",
        [walletId, account, cardId, address, randomUUID()],
      );
      async function merchant(enabled = true) {
        const id = randomUUID(),
          operator = randomUUID(),
          token = randomToken(),
          terminal = randomUUID(),
          recipient = "0x" + randomBytes(20).toString("hex");
        const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        await pool.query(
          "INSERT INTO merchants(id,name,recipient,enabled)VALUES($1,'Scope test shop',$2,$3)",
          [id, recipient, enabled],
        );
        await pool.query("INSERT INTO accounts(id,role)VALUES($1,'merchant')", [
          operator,
        ]);
        await pool.query(
          "INSERT INTO merchant_operators(account_id,merchant_id)VALUES($1,$2)",
          [operator, id],
        );
        await pool.query(
          "INSERT INTO sessions(token_hash,account_id,expires_at)VALUES($1,$2,now()+interval '1 hour')",
          [hash(token), operator],
        );
        await pool.query(
          "INSERT INTO terminals(id,merchant_id,name,public_key)VALUES($1,$2,'Test terminal',$3)",
          [
            terminal,
            id,
            keys.publicKey
              .export({ type: "spki", format: "der" })
              .toString("base64"),
          ],
        );
        return {
          id,
          terminal,
          recipient,
          privateKey: keys.privateKey,
          headers: { authorization: `Bearer ${token}` },
        };
      }
      const selected = await merchant(),
        other = await merchant();
      const terms = {
        cardId,
        enabled: false,
        perPaymentLimit: "100",
        totalLimit: "1000",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      async function save(extra: Record<string, unknown>) {
        return app.inject({
          method: "PUT",
          url: "/v1/policy",
          headers,
          payload: { ...terms, ...extra },
        });
      }
      async function prepare(
        m: Awaited<ReturnType<typeof merchant>>,
        amount = "10",
      ) {
        const id = "0x" + randomBytes(32).toString("hex");
        await pool.query(
          "INSERT INTO invoices(id,merchant_id,recipient,amount,token,chain_id,expires_at)VALUES($1,$2,$3,$4,$5,'11155111',now()+interval '3 minutes')",
          [id, m.id, m.recipient, amount, config.TOKEN_ADDRESS],
        );
        const challenge = await app.inject({
          method: "POST",
          url: `/v1/invoices/${id}/challenge`,
          headers: m.headers,
          payload: { terminalId: m.terminal },
        });
        assert.equal(challenge.statusCode, 200, challenge.body);
        const payload = scanSchema.parse({
          version: 1,
          terminalId: m.terminal,
          invoiceId: id,
          challenge: challenge.json().challenge,
          cardId: physical,
          chainId: "11155111",
          token: config.TOKEN_ADDRESS,
          amount,
          expiresAt: challenge.json().expiresAt,
        });
        return {
          payload,
          signature: sign(
            "sha256",
            canonicalScan(payload),
            m.privateKey,
          ).toString("base64"),
        };
      }
      async function scan(
        m: Awaited<ReturnType<typeof merchant>>,
        amount = "10",
      ) {
        return app.inject({
          method: "POST",
          url: "/v1/scans",
          headers: m.headers,
          payload: await prepare(m, amount),
        });
      }
      await t.test(
        "legacy omission stays selected and empty or contradictory scopes are rejected",
        async () => {
          const saved = await save({ merchantIds: [selected.id] });
          assert.equal(saved.statusCode, 200, saved.body);
          assert.equal(saved.json().merchantScope, "selected");
          assert.deepEqual(saved.json().merchantIds, [selected.id]);
          for (const value of [
            {},
            { merchantScope: "selected", merchantIds: [] },
            { merchantScope: "all", merchantIds: [selected.id] },
          ])
            assert.equal((await save(value)).statusCode, 400);
          assert.equal(
            (
              await save({
                merchantScope: "selected",
                merchantIds: [randomUUID()],
              })
            ).statusCode,
            400,
          );
          const disabled = await merchant(false);
          assert.equal(
            (await save({ merchantIds: [disabled.id] })).statusCode,
            400,
          );
          await pool.query(
            "UPDATE policies SET enabled=true WHERE account_id=$1",
            [account],
          );
          assert.equal((await scan(selected)).statusCode, 200);
          const rejected = await scan(other);
          assert.equal(rejected.statusCode, 403);
          assert.equal(rejected.json().error.code, "merchant_not_allowed");
        },
      );
      let fresh: Awaited<ReturnType<typeof merchant>>;
      let job: any;
      await t.test(
        "explicit all clears stale selections, preserves budget and admits a merchant onboarded later",
        async () => {
          const before = (
            await pool.query(
              "SELECT spent,reserved FROM policies WHERE account_id=$1",
              [account],
            )
          ).rows[0];
          const saved = await save({ merchantScope: "all" });
          assert.equal(saved.statusCode, 200, saved.body);
          assert.equal(saved.json().merchantScope, "all");
          assert.deepEqual(saved.json().merchantIds, []);
          assert.equal(saved.json().reserved, before.reserved);
          assert.equal(saved.json().spent, before.spent);
          assert.equal(saved.json().enabled, false);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM policy_merchants WHERE account_id=$1",
                [account],
              )
            ).rows[0].n,
            0,
          );
          fresh = await merchant();
          await pool.query(
            "UPDATE policies SET enabled=true WHERE account_id=$1",
            [account],
          );
          assert.equal((await scan(other)).statusCode, 200);
          const accepted = await scan(fresh);
          assert.equal(accepted.statusCode, 200, accepted.body);
          job = (
            await pool.query(
              "SELECT j.*,i.merchant_id,i.recipient,i.expires_at,w.address,w.key_id FROM payment_jobs j JOIN invoices i ON i.id=j.invoice_id JOIN wallets w ON w.id=j.wallet_id WHERE i.id=$1",
              [accepted.json().invoiceId],
            )
          ).rows[0];
          await transaction((db) => authorizeForSigning(db, job));
        },
      );
      await t.test(
        "all never bypasses disabled merchant, unknown merchant or revoked terminal",
        async () => {
          const report = await prepare(fresh);
          await pool.query("UPDATE merchants SET enabled=false WHERE id=$1", [
            fresh.id,
          ]);
          const denied = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers: fresh.headers,
            payload: report,
          });
          assert.equal(denied.statusCode, 403);
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /disabled before signing/,
          );
          await pool.query("UPDATE merchants SET enabled=true WHERE id=$1", [
            fresh.id,
          ]);
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, { ...job, merchant_id: randomUUID() }),
            ),
            /disabled before signing/,
          );
          await pool.query(
            "UPDATE terminals SET revoked_at=now() WHERE id=$1",
            [fresh.terminal],
          );
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /disabled before signing/,
          );
          await pool.query("UPDATE terminals SET revoked_at=NULL WHERE id=$1", [
            fresh.terminal,
          ]);
        },
      );
      await t.test(
        "all retains caps, freeze, expiry, recipient, router and reward guards",
        async () => {
          const capped = await scan(fresh, "101");
          assert.equal(capped.json().error.code, "spending_limit");
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, { ...job, gross_amount: "101" }),
            ),
            /disabled before signing/,
          );
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, { ...job, recipient: address }),
            ),
            /disabled before signing/,
          );
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, { ...job, expected_router: address }),
            ),
            /disabled before signing/,
          );
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, { ...job, reward_id: "1" }),
            ),
            /disabled before signing/,
          );
          for (const change of [
            "enabled=false",
            "expires_at=now()-interval '1 minute'",
          ]) {
            await pool.query(
              `UPDATE policies SET ${change} WHERE account_id=$1`,
              [account],
            );
            await assert.rejects(
              transaction((db) => authorizeForSigning(db, job)),
              /disabled before signing/,
            );
            await pool.query(
              "UPDATE policies SET enabled=true,expires_at=now()+interval '1 hour' WHERE account_id=$1",
              [account],
            );
          }
          await pool.query("UPDATE cards SET active=false WHERE id=$1", [
            cardId,
          ]);
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /before signing/,
          );
          await pool.query("UPDATE cards SET active=true WHERE id=$1", [
            cardId,
          ]);
        },
      );
      await t.test(
        "narrowing all back to selected revokes already queued other-merchant signatures",
        async () => {
          const narrowed = await save({ merchantIds: [selected.id] });
          assert.equal(narrowed.statusCode, 200, narrowed.body);
          assert.equal(narrowed.json().merchantScope, "selected");
          await pool.query(
            "UPDATE policies SET enabled=true WHERE account_id=$1",
            [account],
          );
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /disabled before signing/,
          );
          const denied = await scan(fresh);
          assert.equal(denied.json().error.code, "merchant_not_allowed");
          assert.equal((await scan(selected)).statusCode, 200);
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
