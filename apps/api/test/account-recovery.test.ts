import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { cardHash, hash, randomToken } from "../src/protocol.js";

const database = process.env.TEST_DATABASE_URL;
test(
  "removing every card and signing out must leave a World-protected route to the same wallet",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "recovery_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      CARD_HMAC_SECRET: "account-recovery-test-secret-32-chars",
      WORLD_APP_ID: "app_recovery_tests",
      WORLD_RP_ID: "rp_recovery_tests",
      WORLD_SIGNING_KEY: "11".repeat(32),
      WORLD_ENVIRONMENT: "production",
      MULTIBAAS_URL: "",
      MULTIBAAS_API_KEY: "",
    });
    const { pool, transaction } = await import("../src/db.js");
    const { config } = await import("../src/config.js");
    const { buildServer } = await import("../src/server.js");
    const { finalizeVerifiedWorldRequest } = await import("../src/world.js");
    const app = await buildServer();
    const account = randomUUID(),
      token = randomToken();
    const rawCards = ["0102030405060708", "1112131415161718"];
    const worldSession = "session_" + "a".repeat(128);
    const walletAddress = "0x" + "33".repeat(20);
    const headers = { authorization: `Bearer ${token}` };
    let request: { id: string; handoffToken: string; exchangeSecret: string };
    try {
      const folder = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(folder))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(file, folder), "utf8"));
      await pool.query(
        "INSERT INTO accounts(id,role,verified,world_session) VALUES($1,'customer',true,$2)",
        [account, worldSession],
      );
      await pool.query(
        "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hash(token), account],
      );
      await pool.query(
        "INSERT INTO wallets(account_id,address,key_name,status,provider,key_id) VALUES($1,$2,'recovery-fixture','ready','aws_kms','existing-key-reference')",
        [account, walletAddress],
      );
      await pool.query(
        "INSERT INTO policies(account_id,enabled,per_payment_limit,total_limit,spent,expires_at) VALUES($1,true,100,500,30,now()+interval '1 hour')",
        [account],
      );
      for (const raw of rawCards) {
        const inserted = await pool.query(
          "INSERT INTO cards(card_hash,account_id,last4) VALUES($1,$2,$3) RETURNING id",
          [cardHash(raw, config.CARD_HMAC_SECRET), account, raw.slice(-4)],
        );
        const removed = await app.inject({
          method: "DELETE",
          url: `/v1/cards/${inserted.rows[0].id}`,
          headers,
        });
        assert.equal(removed.statusCode, 200);
      }
      const dashboard = await app.inject({
        method: "GET",
        url: "/v1/dashboard",
        headers,
      });
      assert.equal(dashboard.json().wallet, null);
      assert.equal(
        (
          await pool.query("SELECT address FROM wallets WHERE account_id=$1", [
            account,
          ])
        ).rows[0].address,
        walletAddress,
      );
      assert.equal(dashboard.json().cards.length, 0);
      assert.equal(
        (await app.inject({ method: "POST", url: "/v1/logout", headers }))
          .statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/v1/me", headers }))
          .statusCode,
        401,
      );

      await t.test(
        "ordinary card sign-in explains recovery instead of leaving a dead end",
        async () => {
          const result = await app.inject({
            method: "POST",
            url: "/v1/auth/card/start",
            payload: { cardId: rawCards[0] },
          });
          assert.equal(result.statusCode, 409, result.json().error?.code);
          assert.equal(result.json().error.code, "card_recovery_required");
        },
      );
      await t.test(
        "Link your Suica cannot create a second account for a previously linked card",
        async () => {
          const before = (
            await pool.query("SELECT count(*)::int n FROM accounts")
          ).rows[0].n;
          const result = await app.inject({
            method: "POST",
            url: "/v1/enrollments",
            payload: { cardId: rawCards[0] },
          });
          assert.equal(result.statusCode, 409, result.body);
          assert.equal(result.json().error.code, "card_recovery_required");
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM accounts")).rows[0]
              .n,
            before,
          );
        },
      );
      await t.test(
        "recovery starts a fresh proof of the original World session without granting access",
        async () => {
          const result = await app.inject({
            method: "POST",
            url: "/v1/auth/card/recover",
            payload: { cardId: rawCards[0] },
          });
          assert.equal(result.statusCode, 200, result.body);
          request = result.json();
          assert.equal(request.exchangeSecret.length, 43);
          const context = await app.inject({
            method: "GET",
            url: `/v1/world/requests/${request.id}/context`,
            headers: { authorization: `Bearer ${request.handoffToken}` },
          });
          assert.equal(context.json().purpose, "recovery");
          assert.equal(context.json().sessionId, worldSession);
          const pending = await app.inject({
            method: "POST",
            url: `/v1/auth/card/${request.id}/exchange`,
            payload: { exchangeSecret: request.exchangeSecret },
          });
          assert.deepEqual(pending.json(), { status: "pending" });
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM cards WHERE active"))
              .rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "a different World identity and a wrong exchange secret cannot recover the wallet",
        async () => {
          const context = (
            await app.inject({
              method: "GET",
              url: `/v1/world/requests/${request.id}/context`,
              headers: { authorization: `Bearer ${request.handoffToken}` },
            })
          ).json();
          const rejected = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${request.id}/verify`,
            headers: { authorization: `Bearer ${request.handoffToken}` },
            payload: {
              result: {
                protocol_version: "4.0",
                nonce: context.rpContext.nonce,
                session_id: "session_" + "b".repeat(128),
                environment: "production",
                responses: [
                  {
                    identifier: "selfie",
                    issuer_schema_id: 11,
                    session_nullifier: ["fixture-only", "fixture-only"],
                    sybil_score: 0,
                    proof: ["0", "0", "0", "0", "0"],
                  },
                ],
                integrity_bundle: { version: 2 },
              },
            },
          });
          assert.equal(rejected.statusCode, 403);
          assert.equal(rejected.json().error.code, "session_mismatch");
          const wrongSecret = await app.inject({
            method: "POST",
            url: `/v1/auth/card/${request.id}/exchange`,
            payload: { exchangeSecret: randomToken() },
          });
          assert.equal(wrongSecret.statusCode, 404);
        },
      );
      await t.test(
        "verified recovery signs into the original wallet without relinking cards or changing spending",
        async () => {
          const beforeCards = (
            await pool.query(
              "SELECT card_hash,active,removed_at,linked_at::text FROM cards ORDER BY card_hash",
            )
          ).rows;
          const beforePolicy = (
            await pool.query("SELECT * FROM policies WHERE account_id=$1", [
              account,
            ])
          ).rows[0];
          // Exercise the actual post-verification transition at its trusted boundary.
          // No fixture proof is accepted by or submitted to World.
          await transaction(async (db) => {
            await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
              account,
            ]);
            const row = (
              await db.query(
                "SELECT * FROM world_requests WHERE id=$1 FOR UPDATE",
                [request.id],
              )
            ).rows[0];
            await finalizeVerifiedWorldRequest(db, row, worldSession);
          });
          const exchange = await app.inject({
            method: "POST",
            url: `/v1/auth/card/${request.id}/exchange`,
            payload: { exchangeSecret: request.exchangeSecret },
          });
          assert.equal(exchange.statusCode, 200);
          assert.equal(exchange.json().status, "verified");
          const recoveredHeaders = {
            authorization: `Bearer ${exchange.json().token}`,
          };
          const me = await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: recoveredHeaders,
          });
          assert.equal(me.json().id, account);
          const restored = await app.inject({
            method: "GET",
            url: "/v1/dashboard",
            headers: recoveredHeaders,
          });
          assert.equal(restored.json().wallet, null);
          assert.equal(
            (
              await pool.query(
                "SELECT address FROM wallets WHERE account_id=$1",
                [account],
              )
            ).rows[0].address,
            walletAddress,
          );
          assert.deepEqual(restored.json().cards, []);
          assert.deepEqual(
            (
              await pool.query(
                "SELECT card_hash,active,removed_at,linked_at::text FROM cards ORDER BY card_hash",
              )
            ).rows,
            beforeCards,
          );
          assert.deepEqual(
            (
              await pool.query("SELECT * FROM policies WHERE account_id=$1", [
                account,
              ])
            ).rows[0],
            beforePolicy,
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM accounts")).rows[0]
              .n,
            1,
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM wallets")).rows[0].n,
            1,
          );
          const replay = await app.inject({
            method: "POST",
            url: `/v1/auth/card/${request.id}/exchange`,
            payload: { exchangeSecret: request.exchangeSecret },
          });
          assert.equal(replay.statusCode, 410);
        },
      );
      await t.test(
        "unknown cards cannot choose an account and cancelled recovery grants no access",
        async () => {
          const unknown = await app.inject({
            method: "POST",
            url: "/v1/auth/card/recover",
            payload: { cardId: "9999999999999999" },
          });
          assert.equal(unknown.statusCode, 400);
          const injection = await app.inject({
            method: "POST",
            url: "/v1/auth/card/recover",
            payload: { cardId: rawCards[1], accountId: account },
          });
          assert.equal(injection.statusCode, 400);
          const started = (
            await app.inject({
              method: "POST",
              url: "/v1/auth/card/recover",
              payload: { cardId: rawCards[1] },
            })
          ).json();
          const wrongCancel = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${started.id}/cancel`,
            payload: { exchangeSecret: randomToken() },
          });
          assert.equal(wrongCancel.statusCode, 404);
          const cancel = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${started.id}/cancel`,
            payload: { exchangeSecret: started.exchangeSecret },
          });
          assert.equal(cancel.json().status, "cancelled");
          const expired = await app.inject({
            method: "POST",
            url: `/v1/auth/card/${started.id}/exchange`,
            payload: { exchangeSecret: started.exchangeSecret },
          });
          assert.equal(expired.statusCode, 410);
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
