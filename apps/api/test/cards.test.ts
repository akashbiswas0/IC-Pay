import { test } from "node:test";
import assert from "node:assert/strict";
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import {
  cardHash,
  hash,
  randomToken,
  canonicalScan,
  scanSchema,
} from "../src/protocol.js";
import type { CardLinkPurpose } from "../src/cards.js";

const database = process.env.TEST_DATABASE_URL;
test(
  "multiple card wallets preserve ownership and isolate balances and budgets",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"), "Use a dedicated test database");
    const schema = "cards_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      CARD_HMAC_SECRET: "multi-card-integration-secret-32-chars",
      WORLD_APP_ID: "app_card_tests",
      WORLD_RP_ID: "rp_card_tests",
      WORLD_SIGNING_KEY: "11".repeat(32),
      WORLD_ENVIRONMENT: "production",
      MULTIBAAS_URL: "",
      MULTIBAAS_API_KEY: "",
    });
    const { pool, transaction } = await import("../src/db.js");
    const { config } = await import("../src/config.js");
    const { buildServer } = await import("../src/server.js");
    const { applyVerifiedCardLink, prepareCardLink } =
      await import("../src/cards.js");
    const { authorizeForSigning } = await import("../src/worker.js");
    const app = await buildServer();
    const account = randomUUID(),
      outsider = randomUUID(),
      merchant = randomUUID(),
      operator = randomUUID(),
      terminal = randomUUID();
    const token = randomToken(),
      otherToken = randomToken(),
      operatorToken = randomToken();
    const session = "session_" + "a".repeat(128);
    const original = "0102030405060708",
      historical = "0102030405060709",
      additional = "1112131415161718";
    const digest = (raw: string) => cardHash(raw, config.CARD_HMAC_SECRET);
    const headers = { authorization: `Bearer ${token}` };
    const query = pool.query.bind(pool);
    async function cards() {
      const response = await app.inject({
        method: "GET",
        url: "/v1/cards",
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().cards as {
        id: string;
        nickname: string;
        status: string;
        last4: string;
      }[];
    }
    // Exercise the post-verification data operation without fabricating or accepting a World proof.
    async function link(
      raw: string,
      purpose: CardLinkPurpose = "addition",
      targetId?: string,
      owner = account,
    ) {
      return transaction(async (db) => {
        const target = await prepareCardLink(
          db,
          owner,
          purpose,
          digest(raw),
          targetId,
        );
        return applyVerifiedCardLink(db, {
          account_id: owner,
          purpose,
          card_hash: digest(raw),
          card_last4: raw.slice(-4),
          replaces_card_id: target.id,
          replaces_card_generation: target.generation,
        });
      });
    }
    async function patch(id: string, payload: object, auth = headers) {
      return app.inject({
        method: "PATCH",
        url: `/v1/cards/${id}`,
        headers: auth,
        payload,
      });
    }
    try {
      const folder = new URL("../migrations/", import.meta.url);
      const files = (await readdir(folder))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const file of files.filter((file) => file < "010"))
        await query(await readFile(new URL(file, folder), "utf8"));
      await query(
        "INSERT INTO accounts(id,role,verified,world_session) VALUES($1,'customer',true,$2),($3,'customer',true,$4),($5,'merchant',false,NULL)",
        [account, session, outsider, "session_" + "b".repeat(128), operator],
      );
      await query(
        "INSERT INTO cards(card_hash,account_id,last4,active) VALUES($1,$2,'0708',true),($3,$2,'0709',false)",
        [digest(original), account, digest(historical)],
      );
      for (const file of files.filter((file) => file >= "010"))
        await query(await readFile(new URL(file, folder), "utf8"));
      for (const [owner, bearer] of [
        [account, token],
        [outsider, otherToken],
        [operator, operatorToken],
      ])
        await query(
          "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
          [hash(bearer!), owner],
        );
      const wallet = "0x" + "33".repeat(20),
        recipient = "0x" + "22".repeat(20);
      await query(
        "INSERT INTO wallets(account_id,address,key_name,status,provider,key_id) VALUES($1,$2,'card-test-wallet','ready','aws_kms','card-test-key')",
        [account, wallet],
      );
      await query(
        "INSERT INTO policies(account_id,enabled,per_payment_limit,total_limit,spent,reserved,expires_at) VALUES($1,true,600,700,100,0,now()+interval '1 hour')",
        [account],
      );
      await query(
        "INSERT INTO merchants(id,name,recipient) VALUES($1,'Card test merchant',$2)",
        [merchant, recipient],
      );
      await query(
        "INSERT INTO merchant_operators(account_id,merchant_id) VALUES($1,$2)",
        [operator, merchant],
      );
      await query(
        "INSERT INTO policy_merchants(account_id,merchant_id,policy_id) SELECT $1,$2,id FROM policies WHERE account_id=$1",
        [account, merchant],
      );
      const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      await query(
        "INSERT INTO terminals(id,merchant_id,public_key,name) VALUES($1,$2,$3,'Card test terminal')",
        [
          terminal,
          merchant,
          keys.publicKey
            .export({ format: "der", type: "spki" })
            .toString("base64"),
        ],
      );
      let originalId: string, additionalId: string;

      await t.test(
        "migration retains the current card and hides previously replaced cards",
        async () => {
          const listed = await cards();
          assert.equal(listed.length, 1);
          originalId = listed[0]!.id;
          assert.equal(listed[0]!.last4, "0708");
          const old = (
            await query("SELECT removed_at FROM cards WHERE card_hash=$1", [
              digest(historical),
            ])
          ).rows[0];
          assert(old.removed_at);
          assert.match(originalId, /^[a-f0-9-]{36}$/);
        },
      );
      await t.test(
        "legacy funds remain unassigned until explicit card selection",
        async () => {
          let dashboard = await app.inject({
            method: "GET",
            url: "/v1/dashboard",
            headers,
          });
          assert.equal(dashboard.json().wallet, null);
          assert.equal(dashboard.json().unassignedWalletAvailable, true);
          assert.equal(dashboard.json().cards[0].walletStatus, "none");
          const assigned = await app.inject({
            method: "POST",
            url: "/v1/wallet/claim",
            headers,
            payload: { cardId: originalId },
          });
          assert.equal(assigned.statusCode, 200, assigned.body);
          assert.equal(assigned.json().address, wallet);
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM wallets WHERE account_id=$1",
                [account],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await query(
                "SELECT enabled FROM policies WHERE account_id=$1 AND card_id=$2",
                [account, originalId],
              )
            ).rows[0].enabled,
            false,
          );
          // Establish an authorized policy fixture without calling an external provider.
          await query("UPDATE policies SET enabled=true WHERE account_id=$1", [
            account,
          ]);
        },
      );
      await t.test(
        "addition uses the existing World session and leaves current cards unchanged before proof",
        async () => {
          const response = await app.inject({
            method: "POST",
            url: "/v1/world/requests",
            headers,
            payload: { purpose: "addition", cardId: additional },
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().purpose, "addition");
          assert.equal(response.json().sessionId, session);
          assert.equal((await cards()).length, 1);
          // A schema-valid but wrong-account proof is rejected before any verifier call.
          const rejected = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${response.json().id}/verify`,
            headers,
            payload: {
              result: {
                protocol_version: "4.0",
                nonce: response.json().rpContext.nonce,
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
          assert.equal((await cards()).length, 1);
          const cancelled = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${response.json().id}/cancel`,
            headers,
            payload: {},
          });
          assert.equal(cancelled.json().status, "cancelled");
          assert.equal((await cards()).length, 1);
        },
      );
      await t.test(
        "verified addition preserves wallet, budget, spent amount and active cards",
        async () => {
          const before = (
            await query("SELECT * FROM policies WHERE account_id=$1", [account])
          ).rows[0];
          additionalId = await link(additional);
          assert.equal((await cards()).length, 2);
          assert((await cards()).every((card) => card.status === "active"));
          assert.deepEqual(
            (
              await query("SELECT * FROM policies WHERE account_id=$1", [
                account,
              ])
            ).rows[0],
            before,
          );
          assert.equal(
            (
              await query("SELECT address FROM wallets WHERE account_id=$1", [
                account,
              ])
            ).rows[0].address,
            wallet,
          );
          const dashboard = await app.inject({
            method: "GET",
            url: "/v1/dashboard",
            headers,
          });
          assert.equal(dashboard.json().cards.length, 2);
          assert.equal(dashboard.json().card.linked, true);
          assert(!dashboard.body.includes(digest(original)));
          assert(!dashboard.body.includes(original));
          assert.equal(
            dashboard.json().wallet,
            null,
            "Multiple cards must not expose an arbitrary standalone balance",
          );
          assert.equal(
            dashboard.json().cards.find((card: any) => card.id === additionalId)
              .wallet,
            null,
          );
          await query(
            "INSERT INTO wallets(account_id,card_id,address,key_name,status,provider,key_id) VALUES($1,$2,$3,'second-card-wallet','ready','aws_kms','second-card-key')",
            [account, additionalId, "0x" + "55".repeat(20)],
          );
          const secondPolicy = (
            await query(
              "INSERT INTO policies(account_id,card_id,enabled,per_payment_limit,total_limit,expires_at) VALUES($1,$2,true,600,700,now()+interval '1 hour') RETURNING id",
              [account, additionalId],
            )
          ).rows[0].id;
          await query(
            "INSERT INTO policy_merchants(account_id,policy_id,merchant_id) VALUES($1,$2,$3)",
            [account, secondPolicy, merchant],
          );
        },
      );
      await t.test(
        "duplicate scans and another account cannot take an existing card",
        async () => {
          await assert.rejects(link(additional), /already in your cards/);
          await assert.rejects(
            link(additional, "addition", undefined, outsider),
            /another account/,
          );
          const denied = await patch(
            originalId,
            { nickname: "Stolen" },
            { authorization: `Bearer ${otherToken}` },
          );
          assert.equal(denied.statusCode, 404);
          assert.equal(
            (
              await app.inject({
                method: "DELETE",
                url: `/v1/cards/${originalId}`,
                headers: { authorization: `Bearer ${otherToken}` },
              })
            ).statusCode,
            404,
          );
          assert.equal(
            (await app.inject({ method: "GET", url: "/v1/cards" })).statusCode,
            401,
          );
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: "/v1/cards",
                headers: { authorization: `Bearer ${operatorToken}` },
              })
            ).statusCode,
            403,
          );
        },
      );
      await t.test(
        "rename validates input and never changes payment eligibility or card generation",
        async () => {
          const before = (
            await query("SELECT linked_at FROM cards WHERE id=$1", [originalId])
          ).rows[0];
          assert.equal(
            (await patch(originalId, { nickname: "  Commute  " })).json()
              .nickname,
            "Commute",
          );
          for (const payload of [
            { nickname: " " },
            { nickname: "a".repeat(33) },
            { account_id: outsider },
            {},
          ])
            assert.equal((await patch(originalId, payload)).statusCode, 400);
          assert.deepEqual(
            (
              await query("SELECT linked_at FROM cards WHERE id=$1", [
                originalId,
              ])
            ).rows[0],
            before,
          );
        },
      );
      await t.test(
        "simultaneous taps reserve only their own card budgets",
        async () => {
          async function scan(raw: string) {
            const id = "0x" + randomBytes(32).toString("hex");
            await query(
              "INSERT INTO invoices(id,merchant_id,recipient,amount,token,chain_id,expires_at) VALUES($1,$2,$3,400,$4,'11155111',now()+interval '3 minutes')",
              [id, merchant, recipient, "0x" + "44".repeat(20)],
            );
            const challenge = await app.inject({
              method: "POST",
              url: `/v1/invoices/${id}/challenge`,
              headers: { authorization: `Bearer ${operatorToken}` },
              payload: { terminalId: terminal },
            });
            assert.equal(challenge.statusCode, 200, challenge.body);
            const payload = scanSchema.parse({
              version: 1,
              terminalId: terminal,
              invoiceId: id,
              challenge: challenge.json().challenge,
              cardId: raw,
              chainId: "11155111",
              token: "0x" + "44".repeat(20),
              amount: "400",
              expiresAt: challenge.json().expiresAt,
            });
            return app.inject({
              method: "POST",
              url: "/v1/scans",
              headers: { authorization: `Bearer ${operatorToken}` },
              payload: {
                payload,
                signature: sign(
                  "sha256",
                  canonicalScan(payload),
                  keys.privateKey,
                ).toString("base64"),
              },
            });
          }
          const responses = await Promise.all([
            scan(original),
            scan(additional),
          ]);
          assert.deepEqual(
            responses.map((r) => r.statusCode).sort(),
            [200, 200],
            responses.map((r) => r.body).join("\n"),
          );
          assert.equal(
            (
              await query("SELECT reserved FROM policies WHERE account_id=$1", [
                account,
              ])
            ).rows[0].reserved,
            "400",
          );
        },
      );
      await t.test(
        "card funding, approval and permission never select another card wallet",
        async () => {
          const dashboard = (
            await app.inject({ method: "GET", url: "/v1/dashboard", headers })
          ).json();
          assert.equal(dashboard.wallet, null);
          assert.equal(
            dashboard.cards.find((card: any) => card.id === originalId).wallet
              .address,
            wallet,
          );
          assert.equal(
            dashboard.cards.find((card: any) => card.id === additionalId).wallet
              .address,
            "0x" + "55".repeat(20),
          );
          const forbidden = await app.inject({
            method: "GET",
            url: `/v1/cards/${originalId}/funding`,
            headers: { authorization: `Bearer ${otherToken}` },
          });
          assert.equal(forbidden.statusCode, 404);
          const choose = await app.inject({
            method: "POST",
            url: "/v1/wallet",
            headers,
            payload: {},
          });
          assert.equal(choose.statusCode, 409);
          assert.equal(choose.json().error.code, "choose_card");
          const claimAgain = await app.inject({
            method: "POST",
            url: "/v1/wallet/claim",
            headers,
            payload: { cardId: additionalId },
          });
          assert.equal(claimAgain.statusCode, 409);
          const { requestAllowance } =
            await import("../src/payment-requests.js");
          const requestId = randomUUID();
          const first = await requestAllowance(
            account,
            "200",
            requestId,
            originalId,
          );
          const second = await requestAllowance(
            account,
            "300",
            randomUUID(),
            additionalId,
          );
          assert.notEqual(first.id, second.id);
          const jobs = (
            await query(
              "SELECT wallet_id,card_id FROM payment_jobs WHERE id=ANY($1::uuid[])",
              [[first.id, second.id]],
            )
          ).rows;
          assert.equal(new Set(jobs.map((job: any) => job.wallet_id)).size, 2);
          assert.deepEqual(
            new Set(jobs.map((job: any) => job.card_id)),
            new Set([originalId, additionalId]),
          );
          await assert.rejects(
            requestAllowance(account, "200", requestId, additionalId),
            /different terms/,
          );
          const freeze = await app.inject({
            method: "POST",
            url: "/v1/freeze",
            headers,
            payload: { cardId: originalId },
          });
          assert.equal(freeze.statusCode, 200);
          assert.equal(
            (
              await query("SELECT enabled FROM policies WHERE card_id=$1", [
                additionalId,
              ])
            ).rows[0].enabled,
            true,
          );
          await query("UPDATE policies SET enabled=true WHERE card_id=$1", [
            originalId,
          ]);
        },
      );
      await t.test(
        "freezing blocks signing and unfreezing cannot revive an old queued tap",
        async () => {
          const jobId = randomUUID();
          await query(
            "INSERT INTO payment_jobs(id,account_id,kind,amount,card_hash,card_linked_at,card_id,wallet_id,policy_id) SELECT $1,c.account_id,'payment',10,c.card_hash,c.linked_at,c.id,w.id,p.id FROM cards c JOIN wallets w ON w.card_id=c.id JOIN policies p ON p.card_id=c.id WHERE c.id=$2",
            [jobId, originalId],
          );
          const scope = (
            await query(
              "SELECT wallet_id,policy_id,card_id FROM payment_jobs WHERE id=$1",
              [jobId],
            )
          ).rows[0];
          const job = {
            ...scope,
            id: jobId,
            account_id: account,
            kind: "payment",
            amount: "10",
            address: wallet,
            key_id: "card-test-key",
            expected_router: config.PAYMENT_ADDRESS,
            terminal_id: terminal,
            merchant_id: merchant,
            recipient,
            card_hash: digest(original),
            expires_at: new Date(Date.now() + 60000),
          };
          await transaction((db) => authorizeForSigning(db, job));
          const otherWallet = (
            await query("SELECT * FROM wallets WHERE card_id=$1", [
              additionalId,
            ])
          ).rows[0];
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, {
                ...job,
                wallet_id: otherWallet.id,
                address: otherWallet.address,
                key_id: otherWallet.key_id,
              }),
            ),
            /not linked to this card/,
          );
          const otherPolicy = (
            await query("SELECT id FROM policies WHERE card_id=$1", [
              additionalId,
            ])
          ).rows[0];
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, { ...job, policy_id: otherPolicy.id }),
            ),
            /disabled before signing/,
          );
          assert.equal(
            (await patch(originalId, { frozen: true })).json().status,
            "frozen",
          );
          assert.equal(
            (await cards()).find((card) => card.id === additionalId)?.status,
            "active",
          );
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /before signing/,
          );
          const login = await app.inject({
            method: "POST",
            url: "/v1/auth/card/start",
            payload: { cardId: original },
          });
          assert.equal(login.statusCode, 409);
          assert.equal(login.json().error.code, "card_recovery_required");
          assert.equal(
            (await patch(originalId, { frozen: false })).json().status,
            "active",
          );
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /before signing/,
          );
          const policy = (
            await query(
              "SELECT enabled,spent,reserved,total_limit FROM policies WHERE account_id=$1 AND card_id=$2",
              [account, originalId],
            )
          ).rows[0];
          assert.deepEqual(policy, {
            enabled: true,
            spent: "100",
            reserved: "400",
            total_limit: "700",
          });
          for (const raw of [original, additional]) {
            const response = await app.inject({
              method: "POST",
              url: "/v1/auth/card/start",
              payload: { cardId: raw },
            });
            assert.equal(response.statusCode, 200, response.body);
          }
        },
      );
      await t.test(
        "replacement binds one card, rejects changed targets and never removes every card",
        async () => {
          const raw = "2122232425262728";
          const legacy = await app.inject({
            method: "POST",
            url: "/v1/world/requests",
            headers,
            payload: { purpose: "replacement", cardId: raw },
          });
          assert.equal(legacy.statusCode, 409);
          const request = await app.inject({
            method: "POST",
            url: "/v1/world/requests",
            headers,
            payload: {
              purpose: "replacement",
              cardId: raw,
              replacesCardId: originalId,
            },
          });
          assert.equal(request.statusCode, 200, request.body);
          assert.equal(request.json().replacesCardId, originalId);
          const stored = (
            await query(
              "SELECT *,replaces_card_linked_at::text replaces_card_generation FROM world_requests WHERE id=$1",
              [request.json().id],
            )
          ).rows[0];
          await patch(originalId, { frozen: true });
          await assert.rejects(
            transaction((db) => applyVerifiedCardLink(db, stored)),
            /card changed/,
          );
          const replacement = await link(raw, "replacement", originalId);
          const linked = await cards();
          assert.equal(
            (
              await query("SELECT address FROM wallets WHERE card_id=$1", [
                replacement,
              ])
            ).rows[0].address,
            wallet,
          );
          assert.equal(
            (
              await query("SELECT enabled FROM policies WHERE card_id=$1", [
                additionalId,
              ])
            ).rows[0].enabled,
            true,
          );
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM wallets WHERE card_id=$1",
                [originalId],
              )
            ).rows[0].n,
            0,
          );
          assert.deepEqual(
            new Set(linked.map((card) => card.id)),
            new Set([additionalId, replacement]),
          );
          assert.equal(
            (
              await query(
                "SELECT enabled FROM policies WHERE account_id=$1 AND card_id=$2",
                [account, replacement],
              )
            ).rows[0].enabled,
            false,
          );
        },
      );
      await t.test(
        "remove is idempotent, leaves other cards intact and requires verification to re-add",
        async () => {
          for (let attempt = 0; attempt < 2; attempt++)
            assert.equal(
              (
                await app.inject({
                  method: "DELETE",
                  url: `/v1/cards/${additionalId}`,
                  headers,
                })
              ).statusCode,
              200,
            );
          assert.equal((await cards()).length, 1);
          assert.equal(
            (await patch(additionalId, { frozen: false })).statusCode,
            404,
          );
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM audit_events WHERE reference=$1 AND event='card_removed'",
                [additionalId],
              )
            ).rows[0].n,
            1,
          );
          const preservedWallet = (
            await query("SELECT address,key_id FROM wallets WHERE card_id=$1", [
              additionalId,
            ])
          ).rows[0];
          const restored = await link(additional);
          assert.equal(restored, additionalId);
          assert.deepEqual(
            (
              await query(
                "SELECT address,key_id FROM wallets WHERE card_id=$1",
                [additionalId],
              )
            ).rows[0],
            preservedWallet,
          );
          assert.equal(preservedWallet.address, "0x" + "55".repeat(20));
          assert.equal((await cards()).length, 2);
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM wallets WHERE account_id=$1",
                [account],
              )
            ).rows[0].n,
            2,
          );
        },
      );
      await t.test(
        "concurrent attempts to link the same new card have one owner",
        async () => {
          const raw = "3132333435363738";
          const results = await Promise.allSettled([
            link(raw),
            link(raw, "addition", undefined, outsider),
          ]);
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM cards WHERE card_hash=$1",
                [digest(raw)],
              )
            ).rows[0].n,
            1,
          );
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
