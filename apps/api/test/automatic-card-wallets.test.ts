import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { hash, randomToken } from "../src/protocol.js";

const database = process.env.TEST_DATABASE_URL;
test(
  "verified card links durably provision independent wallets",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "auto_wallet_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      CARD_HMAC_SECRET: "automatic-wallet-test-secret-32-chars",
      WORLD_APP_ID: "app_wallet_tests",
      WORLD_RP_ID: "rp_wallet_tests",
      WORLD_SIGNING_KEY: "11".repeat(32),
      WORLD_ENVIRONMENT: "production",
      MULTIBAAS_URL: "",
      MULTIBAAS_API_KEY: "",
    });
    const { pool, transaction } = await import("../src/db.js");
    const { beginWorldRequest, finalizeVerifiedWorldRequest } =
      await import("../src/world.js");
    const { provisionCardWallets } =
      await import("../src/card-wallet-provisioning.js");
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer();
    let sequence = 0;
    const raw = () => (++sequence).toString(16).padStart(16, "0").toUpperCase();
    const worldSession = "session_" + "a".repeat(128);
    const account = randomUUID(),
      token = randomToken();
    const headers = { authorization: `Bearer ${token}` };
    const walletRows = async (owner = account) =>
      (
        await pool.query(
          "SELECT * FROM wallets WHERE account_id=$1 ORDER BY created_at,id",
          [owner],
        )
      ).rows;
    const begin = (
      owner: string,
      purpose: "enrollment" | "addition" | "replacement",
      card: string,
      replaces?: string,
    ) =>
      beginWorldRequest(
        {
          id: owner,
          world_session:
            purpose === "enrollment"
              ? null
              : owner === account
                ? worldSession
                : "session_" + "b".repeat(128),
        },
        purpose,
        card,
        undefined,
        replaces,
      );
    const finish = async (id: string, rollback = false) =>
      transaction(async (db) => {
        const row = (
          await db.query(
            "SELECT r.* FROM world_requests r JOIN accounts a ON a.id=r.account_id WHERE r.id=$1 FOR UPDATE OF r,a",
            [id],
          )
        ).rows[0];
        await finalizeVerifiedWorldRequest(db, row, worldSession);
        if (rollback) throw new Error("rollback fixture");
      });
    const signers: string[] = [];
    const provider = async () => ({
      createWallet: async (ref: string) => {
        signers.push(ref);
        const address = "0x" + signers.length.toString(16).padStart(40, "0");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { address, keyId: "fixture-key-" + ref };
      },
    });
    try {
      const folder = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(folder))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(file, folder), "utf8"));
      await pool.query(
        "INSERT INTO accounts(id,role,verified) VALUES($1,'customer',false)",
        [account],
      );
      await pool.query(
        "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hash(token), account],
      );
      const firstRaw = raw();
      const firstRequest = await begin(account, "enrollment", firstRaw);
      let firstCard: string, firstAddress: string;
      await t.test(
        "pending verification never creates or queues a wallet",
        async () => {
          assert.equal((await walletRows()).length, 0);
          await provisionCardWallets(provider);
          assert.equal(signers.length, 0);
        },
      );
      await t.test(
        "enrollment queues a wallet atomically with verified linkage",
        async () => {
          await finish(firstRequest.id);
          const rows = await walletRows();
          assert.equal(rows.length, 1);
          assert.equal(rows[0].status, "queued");
          firstCard = rows[0].card_id;
          const dashboard = await app.inject({
            method: "GET",
            url: "/v1/dashboard",
            headers,
          });
          assert.equal(dashboard.statusCode, 200, dashboard.body);
          assert.equal(dashboard.json().cards[0].walletStatus, "provisioning");
          assert.equal(dashboard.json().cards[0].wallet, null);
          const retry = await app.inject({
            method: "POST",
            url: "/v1/wallet",
            headers,
            payload: { cardId: firstCard },
          });
          assert.equal(retry.statusCode, 200, retry.body);
          assert.equal(retry.json().status, "provisioning");
          assert.equal(signers.length, 0);
        },
      );
      await t.test(
        "concurrent workers create one key and persist its address",
        async () => {
          await Promise.all([
            provisionCardWallets(provider),
            provisionCardWallets(provider),
          ]);
          assert.equal(signers.length, 1);
          const wallet = (await walletRows())[0];
          assert.equal(wallet.status, "ready");
          assert.equal(wallet.key_id, "fixture-key-" + wallet.key_name);
          firstAddress = wallet.address;
          await provisionCardWallets(provider);
          assert.equal(signers.length, 1);
        },
      );
      await t.test(
        "adding another card creates a different wallet automatically",
        async () => {
          const request = await begin(account, "addition", raw());
          await finish(request.id);
          await provisionCardWallets(provider);
          const rows = await walletRows();
          assert.equal(rows.length, 2);
          assert.equal(signers.length, 2);
          assert.equal(new Set(rows.map((w) => w.address)).size, 2);
          assert(rows.every((w) => w.status === "ready"));
        },
      );
      await t.test(
        "removing and re-adding restores the same wallet without creating a key",
        async () => {
          const removed = await app.inject({
            method: "DELETE",
            url: `/v1/cards/${firstCard}`,
            headers,
          });
          assert.equal(removed.statusCode, 200);
          const request = await begin(account, "addition", firstRaw);
          await finish(request.id);
          await provisionCardWallets(provider);
          const wallet = (await walletRows()).find(
            (w) => w.card_id === firstCard,
          );
          assert.equal(wallet.address, firstAddress);
          assert.equal(signers.length, 2);
        },
      );
      await t.test(
        "replacement preserves its wallet instead of provisioning another",
        async () => {
          const request = await begin(account, "replacement", raw(), firstCard);
          await finish(request.id);
          await provisionCardWallets(provider);
          const wallet = (await walletRows()).find(
            (w) => w.address === firstAddress,
          );
          assert.notEqual(wallet.card_id, firstCard);
          assert.equal(signers.length, 2);
        },
      );
      await t.test(
        "unassigned funds require an explicit choice and remain untouched",
        async () => {
          const owner = randomUUID();
          await pool.query(
            "INSERT INTO accounts(id,role,verified,world_session) VALUES($1,'customer',true,$2)",
            [owner, "session_" + "b".repeat(128)],
          );
          const address = "0x" + "99".repeat(20);
          await pool.query(
            "INSERT INTO wallets(account_id,key_name,address,key_id,status) VALUES($1,'legacy-fixture',$2,'legacy-key','ready')",
            [owner, address],
          );
          const request = await begin(owner, "addition", raw());
          await finish(request.id);
          await provisionCardWallets(provider);
          const rows = await walletRows(owner);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].card_id, null);
          assert.equal(rows[0].address, address);
          assert.equal(signers.length, 2);
        },
      );
      await t.test(
        "rolled-back verification cannot leave a wallet queue or a card",
        async () => {
          const request = await begin(account, "addition", raw());
          await assert.rejects(finish(request.id, true), /rollback fixture/);
          assert.equal((await walletRows()).length, 2);
          assert.equal(
            (
              await pool.query(
                "SELECT consumed_at FROM world_requests WHERE id=$1",
                [request.id],
              )
            ).rows[0].consumed_at,
            null,
          );
        },
      );
      await t.test(
        "removed queued cards wait until re-added before creating a key",
        async () => {
          const cardRaw = raw();
          const request = await begin(account, "addition", cardRaw);
          await finish(request.id);
          const queued = (await walletRows()).find(
            (w) => w.status === "queued",
          );
          await app.inject({
            method: "DELETE",
            url: `/v1/cards/${queued.card_id}`,
            headers,
          });
          await provisionCardWallets(provider);
          assert.equal(signers.length, 2);
          const readded = await begin(account, "addition", cardRaw);
          await finish(readded.id);
          await provisionCardWallets(provider);
          assert.equal(signers.length, 3);
        },
      );
      await t.test(
        "ambiguous KMS failure keeps the card linked and never retries key creation",
        async () => {
          const request = await begin(account, "addition", raw());
          await finish(request.id);
          let attempts = 0;
          const failedProvider = async () => ({
            createWallet: async (): Promise<never> => {
              attempts++;
              throw new Error("ambiguous timeout");
            },
          });
          await provisionCardWallets(failedProvider);
          await provisionCardWallets(failedProvider);
          assert.equal(attempts, 1);
          const rows = await walletRows();
          const failed = rows.find((w) => w.status === "needs_attention");
          assert(failed);
          assert.equal(failed.address, null);
          assert.equal(
            (
              await pool.query("SELECT removed_at FROM cards WHERE id=$1", [
                failed.card_id,
              ])
            ).rows[0].removed_at,
            null,
          );
          const dashboard = await app.inject({
            method: "GET",
            url: "/v1/dashboard",
            headers,
          });
          assert.equal(
            dashboard.json().cards.find((c: any) => c.id === failed.card_id)
              .walletStatus,
            "needs_attention",
          );
        },
      );
      await t.test(
        "re-adding a replaced original gets a separate key without taking the replacement wallet",
        async () => {
          const before = signers.length;
          const replacement = (await walletRows()).find(
            (w) => w.address === firstAddress,
          );
          const request = await begin(account, "addition", firstRaw);
          await finish(request.id);
          await provisionCardWallets(provider);
          const rows = await walletRows();
          const restoredOriginal = rows.find((w) => w.card_id === firstCard);
          assert.equal(restoredOriginal.status, "ready");
          assert.notEqual(restoredOriginal.address, firstAddress);
          assert.notEqual(restoredOriginal.key_name, replacement.key_name);
          assert.equal(
            rows.find((w) => w.id === replacement.id).address,
            firstAddress,
          );
          assert.equal(signers.length, before + 1);
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
