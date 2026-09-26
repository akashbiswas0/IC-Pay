import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Interface } from "ethers";
import pg from "pg";
const database = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL test claims enforce ownership, account-wide idempotency, atomic daily budgets and ambiguous signing recovery",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "funding_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.TEST_FUNDING_ENABLED = "true";
    process.env.TEST_FUNDING_DAILY_LIMIT = "2";
    process.env.CHAIN_ID = "11155111";
    process.env.TOKEN_ADDRESS = "0x" + "11".repeat(20);
    process.env.PAYMENT_ADDRESS = "0x" + "22".repeat(20);
    process.env.MULTIBAAS_URL = "https://test-unreachable.example";
    process.env.MULTIBAAS_API_KEY = "unused-test-value";
    process.env.AWS_KMS_OPERATOR_KEY_ID = "unused-test-key";
    const { pool } = await import("../src/db.js");
    const { buildServer } = await import("../src/server.js");
    const { hash, randomToken } = await import("../src/protocol.js");
    const {
      processTestFunding,
      fundingMintMatches,
      guardTestFundingSignature,
    } = await import("../src/test-funding.js");
    const app = await buildServer();
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
      async function account(verified = true, role = "customer") {
        const id = randomUUID(),
          token = randomToken();
        await pool.query(
          "INSERT INTO accounts(id,verified,role)VALUES($1,$2,$3)",
          [id, verified, role],
        );
        await pool.query(
          "INSERT INTO sessions(token_hash,account_id,expires_at)VALUES($1,$2,now()+interval '1 hour')",
          [hash(token), id],
        );
        return { id, headers: { authorization: `Bearer ${token}` } };
      }
      async function card(accountId: string, index: number, ready = true) {
        const id = randomUUID(),
          wallet = randomUUID(),
          address = "0x" + index.toString(16).padStart(40, "0");
        await pool.query(
          "INSERT INTO cards(id,card_hash,account_id,last4)VALUES($1,$2,$3,'1234')",
          [id, randomUUID(), accountId],
        );
        await pool.query(
          "INSERT INTO wallets(id,account_id,card_id,key_name,address,status)VALUES($1,$2,$3,$4,$5,$6)",
          [
            wallet,
            accountId,
            id,
            randomUUID(),
            ready ? address : null,
            ready ? "ready" : "queued",
          ],
        );
        return { id, address };
      }
      const first = await account(),
        second = await account(),
        third = await account(),
        unverified = await account(false),
        merchant = await account(false, "merchant");
      const a = await card(first.id, 1),
        b = await card(first.id, 2),
        c = await card(second.id, 3),
        d = await card(third.id, 4);
      await t.test(
        "only verified customers can claim; amount and recipient are not request inputs",
        async () => {
          assert.equal(
            (await app.inject({ url: "/v1/test-funding" })).statusCode,
            401,
          );
          for (const user of [unverified, merchant])
            assert.equal(
              (
                await app.inject({
                  method: "POST",
                  url: "/v1/test-funding",
                  headers: user.headers,
                  payload: {},
                })
              ).statusCode,
              403,
            );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/v1/test-funding",
                headers: first.headers,
                payload: { cardId: a.id, amount: "1", address: c.address },
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/v1/test-funding",
                headers: first.headers,
                payload: { cardId: c.id },
              })
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/v1/test-funding",
                headers: first.headers,
                payload: {},
              })
            ).statusCode,
            409,
          );
        },
      );
      let firstId: string;
      await t.test(
        "concurrent retries across two cards produce one immutable account claim",
        async () => {
          const result = await Promise.all(
            [a, b, a, b].map((card) =>
              app.inject({
                method: "POST",
                url: "/v1/test-funding",
                headers: first.headers,
                payload: { cardId: card.id },
              }),
            ),
          );
          for (const item of result) assert.equal(item.statusCode, 200);
          assert.equal(new Set(result.map((v) => v.json().claim.id)).size, 1);
          const claim = result[0]!.json().claim;
          firstId = claim.id;
          assert.equal(claim.amount, "1000000000000000000000");
          assert.equal(result[0]!.json().canClaim, false);
          const record = (
            await pool.query(
              "SELECT * FROM test_funding_claims WHERE account_id=$1",
              [first.id],
            )
          ).rows[0];
          assert.equal(record.operation_id, record.id);
          await pool.query(
            "UPDATE cards SET active=false,removed_at=now() WHERE id=$1",
            [record.card_id],
          );
          const other = record.card_id === a.id ? b : a;
          const lookup = await app.inject({
            url: `/v1/test-funding?cardId=${other.id}`,
            headers: first.headers,
          });
          assert.equal(lookup.json().claim.id, claim.id);
          assert.equal(
            lookup.json().claim.walletAddress,
            record.wallet_address,
          );
        },
      );
      await t.test(
        "different accounts racing for final daily slot cannot exceed reserved budget",
        async () => {
          const result = await Promise.all(
            [
              { user: second, card: c },
              { user: third, card: d },
            ].map((v) =>
              app.inject({
                method: "POST",
                url: "/v1/test-funding",
                headers: v.user.headers,
                payload: { cardId: v.card.id },
              }),
            ),
          );
          assert.equal(result.filter((v) => v.json().claim).length, 1);
          assert.equal(
            result.filter((v) => v.json().reason === "daily_limit_reached")
              .length,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM test_funding_claims",
              )
            ).rows[0].n,
            2,
          );
        },
      );
      await t.test(
        "removed or relinked card and changed account or wallet cannot pass signing authorization",
        async () => {
          const row = (
            await pool.query(
              "SELECT * FROM test_funding_claims WHERE account_id=$1",
              [first.id],
            )
          ).rows[0];
          let called = false;
          const action = async () => {
            called = true;
          };
          await assert.rejects(
            guardTestFundingSignature(row, action),
            (error) =>
              (error as any).code === "funding_destination_unavailable",
          );
          assert.equal(called, false);
          await pool.query(
            "UPDATE cards SET active=true,removed_at=NULL,linked_at=now()+interval '1 second' WHERE id=$1",
            [row.card_id],
          );
          await assert.rejects(guardTestFundingSignature(row, action));
          assert.equal(called, false);
          const valid = (
            await pool.query(
              "SELECT * FROM test_funding_claims WHERE account_id<>$1",
              [first.id],
            )
          ).rows[0];
          await guardTestFundingSignature(valid, async () => {
            called = true;
          });
          assert.equal(called, true);
          await pool.query("UPDATE accounts SET verified=false WHERE id=$1", [
            valid.account_id,
          ]);
          await assert.rejects(guardTestFundingSignature(valid, action));
          await pool.query("UPDATE accounts SET verified=true WHERE id=$1", [
            valid.account_id,
          ]);
          await pool.query(
            "UPDATE wallets SET status='needs_attention' WHERE id=$1",
            [valid.wallet_id],
          );
          await assert.rejects(guardTestFundingSignature(valid, action));
          await pool.query("UPDATE wallets SET status='ready' WHERE id=$1", [
            valid.wallet_id,
          ]);
        },
      );
      await t.test(
        "signing guard holds real card locks through the authorization action",
        async () => {
          const row = (
            await pool.query(
              "SELECT * FROM test_funding_claims WHERE account_id<>$1",
              [first.id],
            )
          ).rows[0];
          let entered!: () => void, release!: () => void;
          const active = new Promise<void>((r) => {
            entered = r;
          });
          const finish = new Promise<void>((r) => {
            release = r;
          });
          const guarded = guardTestFundingSignature(row, async () => {
            entered();
            await finish;
          });
          await active;
          const db = await pool.connect();
          try {
            await db.query("BEGIN");
            await db.query("SET LOCAL lock_timeout='50ms'");
            await assert.rejects(
              db.query("UPDATE cards SET active=false WHERE id=$1", [
                row.card_id,
              ]),
              (error) => (error as any).code === "55P03",
            );
          } finally {
            await db.query("ROLLBACK");
            db.release();
            release();
            await guarded;
          }
        },
      );
      await t.test(
        "missing operator audit after signing marker is held without provider calls or remint",
        async () => {
          await pool.query(
            "UPDATE test_funding_claims SET status='submitting',attempted_at=now(),updated_at=now()-interval '1 minute'",
          );
          await processTestFunding();
          const claims = (
            await pool.query(
              "SELECT status,error_code FROM test_funding_claims",
            )
          ).rows;
          assert(
            claims.every(
              (c) =>
                c.status === "reconciling" &&
                c.error_code === "submission_unknown",
            ),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM operator_transactions",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "failed claims remain consumed and retain original destination",
        async () => {
          await pool.query(
            "UPDATE test_funding_claims SET status='failed',error_code='transaction_reverted' WHERE id=$1",
            [firstId!],
          );
          const retry = await app.inject({
            method: "POST",
            url: "/v1/test-funding",
            headers: first.headers,
            payload: { cardId: b.id },
          });
          assert.equal(retry.json().claim.id, firstId!);
          assert.equal(retry.json().canClaim, false);
          assert.equal(retry.json().claim.status, "failed");
        },
      );
      await t.test(
        "mint receipt matches exact token, zero sender, recipient and amount",
        async () => {
          const abi = new Interface([
            "event Transfer(address indexed from,address indexed to,uint256 value)",
          ]);
          const event = abi.encodeEventLog(abi.getEvent("Transfer")!, [
            "0x" + "00".repeat(20),
            a.address,
            1000n,
          ]);
          const claim = {
            token_address: process.env.TOKEN_ADDRESS,
            wallet_address: a.address,
            amount: "1000",
          };
          const log = { ...event, address: process.env.TOKEN_ADDRESS };
          assert.equal(fundingMintMatches([log], claim), true);
          for (const bad of [
            { ...log, removed: true },
            { ...log, address: b.address },
          ])
            assert.equal(fundingMintMatches([bad], claim), false);
          assert.equal(
            fundingMintMatches([log], { ...claim, amount: "1001" }),
            false,
          );
          assert.equal(
            fundingMintMatches([log], { ...claim, wallet_address: b.address }),
            false,
          );
          assert.equal(fundingMintMatches([log, log], claim), false);
          const transfer = {
            ...abi.encodeEventLog(abi.getEvent("Transfer")!, [
              b.address,
              a.address,
              1000n,
            ]),
            address: claim.token_address,
          };
          assert.equal(fundingMintMatches([transfer], claim), false);
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
