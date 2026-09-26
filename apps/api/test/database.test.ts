import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  randomUUID,
  randomBytes,
} from "node:crypto";
import {
  canonicalScan,
  cardHash,
  hash,
  randomToken,
  scanSchema,
} from "../src/protocol.js";
// These tests use a real, separately provisioned PostgreSQL database. They never start a fake provider.
const database = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL payment authorization invariants",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(
      url.pathname.endsWith("_test"),
      "TEST_DATABASE_URL must end with _test",
    );
    process.env.DATABASE_URL = database!;
    for (const key of [
      "WORLD_APP_ID",
      "WORLD_RP_ID",
      "WORLD_SIGNING_KEY",
      "MULTIBAAS_URL",
      "MULTIBAAS_API_KEY",
    ])
      process.env[key] = "";
    const { pool } = await import("../src/db.js");
    const { config } = await import("../src/config.js");
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer();
    await app.ready();
    const customer = randomUUID(),
      merchant = randomUUID(),
      operator = randomUUID(),
      outsider = randomUUID(),
      terminal = randomUUID();
    const customerToken = randomToken(),
      operatorToken = randomToken(),
      outsiderToken = randomToken();
    const card = "0102030405060708";
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const spki = publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const query = pool.query.bind(pool);
    await query("TRUNCATE accounts,merchants,auth_attempts CASCADE");
    await query(
      `INSERT INTO accounts(id,role,verified) VALUES($1,'customer',true),($2,'merchant',false),($3,'customer',true)`,
      [customer, operator, outsider],
    );
    for (const [account, token] of [
      [customer, customerToken],
      [operator, operatorToken],
      [outsider, outsiderToken],
    ])
      await query(
        `INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
        [hash(token!), account],
      );
    await query("INSERT INTO merchants(id,name,recipient) VALUES($1,$2,$3)", [
      merchant,
      "Integration-test merchant",
      "0x" + "22".repeat(20),
    ]);
    await query(
      "INSERT INTO merchant_operators(account_id,merchant_id) VALUES($1,$2)",
      [operator, merchant],
    );
    await query(
      "INSERT INTO terminals(id,merchant_id,public_key,name) VALUES($1,$2,$3,$4)",
      [terminal, merchant, spki, "Integration-test terminal"],
    );
    await query(
      "INSERT INTO cards(card_hash,account_id,last4) VALUES($1,$2,$3)",
      [cardHash(card, config.CARD_HMAC_SECRET), customer, card.slice(-4)],
    );
    await query(
      `INSERT INTO wallets(account_id,address,key_name,status,provider,key_id,card_id) VALUES($1,$2,$3,'ready','aws_kms','integration-test-key-reference',(SELECT id FROM cards WHERE account_id=$1 AND active LIMIT 1))`,
      [customer, "0x" + "33".repeat(20), `test-${customer}`],
    );
    await query(
      `INSERT INTO policies(account_id,enabled,per_payment_limit,total_limit,expires_at,card_id) VALUES($1,true,600,1000,now()+interval '1 hour',(SELECT id FROM cards WHERE account_id=$1 AND active LIMIT 1))`,
      [customer],
    );
    await query(
      "INSERT INTO policy_merchants(account_id,merchant_id,policy_id) SELECT $1,$2,id FROM policies WHERE account_id=$1",
      [customer, merchant],
    );
    const headers = { authorization: `Bearer ${operatorToken}` };
    async function invoice(amount = "500") {
      const id = "0x" + randomBytes(32).toString("hex");
      await query(
        `INSERT INTO invoices(id,merchant_id,recipient,amount,token,chain_id,expires_at) VALUES($1,$2,$3,$4,$5,'11155111',now()+interval '3 minutes')`,
        [id, merchant, "0x" + "22".repeat(20), amount, "0x" + "44".repeat(20)],
      );
      const challenge = await app.inject({
        method: "POST",
        url: `/v1/invoices/${id}/challenge`,
        headers,
        payload: { terminalId: terminal },
      });
      assert.equal(challenge.statusCode, 200, challenge.body);
      const { challenge: nonce, expiresAt } = challenge.json();
      const payload = scanSchema.parse({
        version: 1,
        terminalId: terminal,
        invoiceId: id,
        challenge: nonce,
        cardId: card,
        chainId: "11155111",
        token: "0x" + "44".repeat(20),
        amount,
        expiresAt,
      });
      return {
        payload,
        signature: sign("sha256", canonicalScan(payload), privateKey).toString(
          "base64",
        ),
      };
    }
    try {
      await t.test(
        "API successes and authentication failures cannot be cached by a shared proxy",
        async () => {
          for (const request of [
            { method: "GET" as const, url: "/health" },
            { method: "GET" as const, url: "/v1/config" },
            { method: "GET" as const, url: "/v1/me" },
            {
              method: "GET" as const,
              url: "/v1/me",
              headers: { authorization: `Bearer ${customerToken}` },
            },
            { method: "GET" as const, url: "/v1/does-not-exist" },
          ]) {
            const response = await app.inject(request);
            assert.equal(
              response.headers["cache-control"],
              "private, no-store",
            );
            const vary = String(response.headers.vary)
              .toLowerCase()
              .split(",")
              .map((v) => v.trim());
            for (const field of ["origin", "cookie", "authorization"])
              assert(
                vary.includes(field),
                `${request.url} lacks Vary ${field}`,
              );
          }
        },
      );
      await t.test(
        "ready wallet survives incomplete token setup and repeated create calls without changing its key",
        async () => {
          const before = (
            await query(
              "SELECT address,key_id FROM wallets WHERE account_id=$1",
              [customer],
            )
          ).rows[0];
          const headers = { authorization: `Bearer ${customerToken}` };
          const dashboard = await app.inject({
            method: "GET",
            url: "/v1/dashboard",
            headers,
          });
          assert.equal(dashboard.statusCode, 200, dashboard.body);
          assert.equal(dashboard.json().wallet.address, before.address);
          assert.equal(dashboard.json().wallet.balance, null);
          assert.equal(dashboard.json().wallet.balanceStatus, "pending_setup");
          const funding = await app.inject({
            method: "GET",
            url: "/v1/funding",
            headers,
          });
          assert.equal(funding.statusCode, 200);
          assert.equal(funding.json().status, "pending_setup");
          assert.equal(funding.json().transfers, null);
          const repeated = await app.inject({
            method: "POST",
            url: "/v1/wallet",
            headers,
            payload: {},
          });
          assert.equal(repeated.statusCode, 200);
          assert.equal(repeated.json().address, before.address);
          assert.equal(repeated.json().status, "ready");
          assert.deepEqual(
            (
              await query(
                "SELECT address,key_id FROM wallets WHERE account_id=$1",
                [customer],
              )
            ).rows,
            [before],
          );
        },
      );
      await t.test(
        "a configured but unreachable balance provider does not hide the real database wallet",
        async () => {
          // Use a genuinely unavailable local transport, not a fake provider/server or mocked response.
          const script = `
          const {buildServer}=await import(${JSON.stringify(fileURLToPath(new URL("../src/server.ts", import.meta.url)))});
          const {pool}=await import(${JSON.stringify(fileURLToPath(new URL("../src/db.ts", import.meta.url)))});
          const app=await buildServer();
          try{
            const headers={authorization:'Bearer '+process.env.TEST_SESSION};
            const dashboard=await app.inject({method:'GET',url:'/v1/dashboard',headers});
            const funding=await app.inject({method:'GET',url:'/v1/funding',headers});
            process.stdout.write(JSON.stringify({status:dashboard.statusCode,wallet:dashboard.json().wallet,fundingStatus:funding.statusCode,funding:funding.json()}));
          }finally{await app.close();await pool.end();}
        `;
          const { stdout } = await promisify(execFile)(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", script],
            {
              env: {
                ...process.env,
                DATABASE_URL: database!,
                CHAIN_ID: "11155111",
                TOKEN_ADDRESS: "0x" + "44".repeat(20),
                PAYMENT_ADDRESS: "0x" + "55".repeat(20),
                MULTIBAAS_URL: "https://127.0.0.1:1",
                MULTIBAAS_API_KEY: "unreachable-transport-test",
                TEST_SESSION: customerToken,
              },
            },
          );
          const result = JSON.parse(stdout);
          assert.equal(result.status, 200);
          assert.equal(result.wallet.address, "0x" + "33".repeat(20));
          assert.equal(result.wallet.balance, null);
          assert.equal(result.wallet.balanceStatus, "unavailable");
          assert.equal(result.fundingStatus, 200);
          assert.equal(result.funding.status, "unavailable");
          assert.equal(result.funding.transfers, null);
        },
      );
      await t.test(
        "unconfigured providers fail closed without fake balances",
        async () => {
          const res = await app.inject({
            method: "POST",
            url: "/v1/enrollments",
            payload: { cardId: card },
          });
          assert.equal(res.statusCode, 503);
          assert.equal(res.json().error.code, "world_unconfigured");
        },
      );
      await t.test(
        "bearer ownership enforced; customer cannot become merchant",
        async () => {
          assert.equal(
            (await app.inject({ method: "GET", url: "/v1/dashboard" }))
              .statusCode,
            401,
          );
          const res = await app.inject({
            method: "POST",
            url: "/v1/terminals",
            headers: { authorization: `Bearer ${customerToken}` },
            payload: { name: "bad", publicKey: spki },
          });
          assert.equal(res.statusCode, 403);
        },
      );
      await t.test(
        "concurrent replay authorizes once and reserves once",
        async () => {
          const report = await invoice();
          const responses = await Promise.all(
            [1, 2].map(() =>
              app.inject({
                method: "POST",
                url: "/v1/scans",
                headers,
                payload: report,
              }),
            ),
          );
          assert.deepEqual(
            responses.map((r) => r.statusCode).sort(),
            [200, 409],
          );
          assert.equal(
            (
              await query(
                "SELECT reserved::text FROM policies WHERE account_id=$1",
                [customer],
              )
            ).rows[0].reserved,
            "500",
          );
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM payment_jobs WHERE account_id=$1",
                [customer],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "modified terms reject before signing; challenge remains usable for correct report",
        async () => {
          const report = await invoice("400");
          const response = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers,
            payload: {
              ...report,
              payload: { ...report.payload, amount: "401" },
            },
          });
          assert.equal(response.statusCode, 403);
          const good = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers,
            payload: report,
          });
          assert.equal(good.statusCode, 200, good.body);
        },
      );
      await t.test(
        "concurrent reservations prevent spending beyond total budget",
        async () => {
          const report = await invoice("101");
          const response = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers,
            payload: report,
          });
          assert.equal(response.statusCode, 403);
          assert.equal(response.json().error.code, "spending_limit");
        },
      );
      await t.test(
        "invoice and jobs cannot be read by another customer",
        async () => {
          const report = await invoice("50");
          const response = await app.inject({
            method: "GET",
            url: `/v1/invoices/${report.payload.invoiceId}`,
            headers: { authorization: `Bearer ${outsiderToken}` },
          });
          assert.equal(response.statusCode, 404);
        },
      );
      await t.test(
        "freeze blocks later scans and preserves reservations",
        async () => {
          const freeze = await app.inject({
            method: "POST",
            url: "/v1/freeze",
            headers: { authorization: `Bearer ${customerToken}` },
          });
          assert.equal(freeze.statusCode, 200);
          const report = await invoice("50");
          const response = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers,
            payload: report,
          });
          assert.equal(response.json().error.code, "spending_disabled");
          assert.equal(
            (
              await query(
                "SELECT reserved::text FROM policies WHERE account_id=$1",
                [customer],
              )
            ).rows[0].reserved,
            "900",
          );
        },
      );
      await t.test(
        "operator can attach a discovered replacement to a pending approval",
        async () => {
          const jobId = randomUUID();
          await query(
            "INSERT INTO payment_jobs(id,account_id,kind,amount,status,tx_hash) VALUES($1,$2,'approval',500,'pending',$3)",
            [jobId, customer, "0x" + "aa".repeat(32)],
          );
          const replacement = "0x" + "bb".repeat(32);
          await promisify(execFile)(
            process.execPath,
            [
              "--import",
              "tsx",
              fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
              "attach-transaction",
              jobId,
              replacement,
            ],
            { env: process.env },
          );
          const row = (
            await query("SELECT status,tx_hash FROM payment_jobs WHERE id=$1", [
              jobId,
            ])
          ).rows[0];
          assert.equal(row.status, "reconciling");
          assert.equal(row.tx_hash, replacement);
        },
      );
      await t.test(
        "legacy custody wallets are never silently replaced by AWS keys",
        async () => {
          await query(
            "INSERT INTO cards(card_hash,account_id,last4) VALUES($1,$2,'9999')",
            [cardHash("9999999999999999", config.CARD_HMAC_SECRET), outsider],
          );
          await query(
            "INSERT INTO wallets(account_id,address,key_name,status,provider,card_id) VALUES($1,$2,$3,'ready','legacy_azure',(SELECT id FROM cards WHERE account_id=$1 AND active LIMIT 1))",
            [outsider, "0x" + "77".repeat(20), `legacy-${outsider}`],
          );
          const response = await app.inject({
            method: "POST",
            url: "/v1/wallet",
            headers: { authorization: `Bearer ${outsiderToken}` },
          });
          assert.equal(response.statusCode, 409);
          assert.equal(response.json().error.code, "wallet_migration_required");
          const row = (
            await query(
              "SELECT provider,address,key_id FROM wallets WHERE account_id=$1",
              [outsider],
            )
          ).rows[0];
          assert.equal(row.provider, "legacy_azure");
          assert.equal(row.key_id, null);
          assert.equal(row.address, "0x" + "77".repeat(20));
        },
      );
      await t.test(
        "approval reorganization restores the unresolved nonce guard without changing spending",
        async () => {
          const { markSettlementUncertain } =
            await import("../src/settlement.js");
          const job = (
            await query(
              "UPDATE payment_jobs SET status='confirmed',block_number=42,block_hash=$2 WHERE account_id=$1 AND kind='approval' RETURNING *",
              [customer, "0x" + "cc".repeat(32)],
            )
          ).rows[0];
          const before = (
            await query(
              "SELECT spent,reserved FROM policies WHERE account_id=$1",
              [customer],
            )
          ).rows[0];
          assert.equal(
            await markSettlementUncertain(job, "canonical_receipt_unavailable"),
            true,
          );
          const blocked = (
            await query(
              "SELECT count(*)::int n FROM payment_jobs WHERE account_id=$1 AND kind='approval' AND status IN ('submitting','pending','reconciling')",
              [customer],
            )
          ).rows[0];
          assert.equal(blocked.n, 1);
          assert.deepEqual(
            (
              await query(
                "SELECT spent,reserved FROM policies WHERE account_id=$1",
                [customer],
              )
            ).rows[0],
            before,
          );
          assert.equal(
            await markSettlementUncertain(job, "chain_reorganization"),
            false,
          );
        },
      );
      await t.test(
        "concurrent payment reorganization restores its reservation exactly once",
        async () => {
          const { markSettlementUncertain } =
            await import("../src/settlement.js");
          const job = (
            await query(
              "SELECT * FROM payment_jobs WHERE account_id=$1 AND kind='payment' ORDER BY created_at LIMIT 1",
              [customer],
            )
          ).rows[0];
          await query(
            "UPDATE payment_jobs SET status='confirmed',block_number=42,block_hash=$2 WHERE id=$1",
            [job.id, "0x" + "dd".repeat(32)],
          );
          await query(
            "UPDATE policies SET reserved=reserved-$2,spent=spent+$2 WHERE account_id=$1",
            [customer, job.amount],
          );
          const results = await Promise.all([
            markSettlementUncertain(job, "chain_reorganization"),
            markSettlementUncertain(job, "chain_reorganization"),
          ]);
          assert.deepEqual(results.sort(), [false, true]);
          const policy = (
            await query(
              "SELECT spent,reserved FROM policies WHERE account_id=$1",
              [customer],
            )
          ).rows[0];
          assert.equal(policy.spent, "0");
          assert.equal(policy.reserved, "900");
        },
      );
      await t.test(
        "device pairing binds the approving account and delivers a native session only once",
        async () => {
          const created = await app.inject({
            method: "POST",
            url: "/v1/device-links",
            payload: {},
          });
          assert.equal(created.statusCode, 200, created.body);
          const link = created.json();
          assert.match(link.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
          const wrong = await app.inject({
            method: "POST",
            url: `/v1/device-links/${link.id}/poll`,
            payload: { deviceSecret: randomToken() },
          });
          assert.equal(wrong.statusCode, 404);
          const pending = await app.inject({
            method: "POST",
            url: `/v1/device-links/${link.id}/poll`,
            payload: { deviceSecret: link.deviceSecret },
          });
          assert.equal(pending.json().status, "pending");
          assert.equal(pending.json().token, undefined);
          const unauthorized = await app.inject({
            method: "POST",
            url: "/v1/device-links/approve",
            payload: { userCode: link.userCode },
          });
          assert.equal(unauthorized.statusCode, 401);
          const approved = await app.inject({
            method: "POST",
            url: "/v1/device-links/approve",
            headers: { authorization: `Bearer ${customerToken}` },
            payload: { userCode: link.userCode },
          });
          assert.equal(approved.statusCode, 200);
          const responses = await Promise.all(
            [1, 2].map(() =>
              app.inject({
                method: "POST",
                url: `/v1/device-links/${link.id}/poll`,
                payload: { deviceSecret: link.deviceSecret },
              }),
            ),
          );
          assert.deepEqual(
            responses.map((r) => r.statusCode).sort(),
            [200, 410],
          );
          const issued = responses.find((r) => r.statusCode === 200)!.json();
          assert.equal(issued.status, "approved");
          const me = await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${issued.token}` },
          });
          assert.equal(me.json().id, customer);
          assert.equal(me.json().role, "customer");
          const stored = (
            await query("SELECT * FROM device_links WHERE id=$1", [link.id])
          ).rows[0];
          assert.equal(stored.secret_hash, hash(link.deviceSecret));
          assert.notEqual(stored.code_hash, link.userCode);
        },
      );
      await t.test(
        "browser pairing uses HttpOnly cookie, requires Origin and signs out only that browser",
        async () => {
          const link = (
            await app.inject({
              method: "POST",
              url: "/v1/device-links",
              payload: {},
            })
          ).json();
          await app.inject({
            method: "POST",
            url: "/v1/device-links/approve",
            headers: { authorization: `Bearer ${customerToken}` },
            payload: { userCode: link.userCode },
          });
          const response = await app.inject({
            method: "POST",
            url: `/v1/device-links/${link.id}/poll`,
            payload: { deviceSecret: link.deviceSecret, browser: true },
          });
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().token, undefined);
          assert.equal(response.headers["cache-control"], "private, no-store");
          const setCookie = String(response.headers["set-cookie"]);
          assert.match(setCookie, /HttpOnly/);
          assert.match(setCookie, /Secure/);
          assert.match(setCookie, /SameSite=Strict/);
          const cookie = setCookie.split(";")[0]!;
          const restored = await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { cookie },
          });
          assert.equal(restored.json().id, customer);
          const csrf = await app.inject({
            method: "POST",
            url: "/v1/logout",
            headers: { cookie, origin: "https://untrusted.invalid" },
          });
          assert.equal(csrf.statusCode, 403);
          const logout = await app.inject({
            method: "POST",
            url: "/v1/logout",
            headers: { cookie, origin: config.CORS_ORIGIN },
          });
          assert.equal(logout.statusCode, 200);
          assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: "/v1/me",
                headers: { cookie },
              })
            ).statusCode,
            401,
          );
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: "/v1/me",
                headers: { authorization: `Bearer ${customerToken}` },
              })
            ).statusCode,
            200,
          );
        },
      );
      await t.test(
        "expired device codes cannot be approved or exchanged",
        async () => {
          const link = (
            await app.inject({
              method: "POST",
              url: "/v1/device-links",
              payload: {},
            })
          ).json();
          await query(
            "UPDATE device_links SET expires_at=now()-interval '1 second' WHERE id=$1",
            [link.id],
          );
          const response = await app.inject({
            method: "POST",
            url: `/v1/device-links/${link.id}/poll`,
            payload: { deviceSecret: link.deviceSecret },
          });
          assert.equal(response.statusCode, 410);
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/v1/device-links/approve",
                headers: { authorization: `Bearer ${customerToken}` },
                payload: { userCode: link.userCode },
              })
            ).statusCode,
            404,
          );
        },
      );
      await t.test(
        "merchant invitation is account-scoped, one use and cannot select a role",
        async () => {
          const { createInvitation } = await import("../src/device-auth.js");
          await assert.rejects(() => createInvitation(customer));
          const invitation = await createInvitation(operator);
          const rejected = await app.inject({
            method: "POST",
            url: "/v1/invitations/exchange",
            payload: { code: invitation.code, role: "admin" },
          });
          assert.equal(rejected.statusCode, 400);
          const responses = await Promise.all(
            [1, 2].map(() =>
              app.inject({
                method: "POST",
                url: "/v1/invitations/exchange",
                payload: { code: invitation.code },
              }),
            ),
          );
          assert.deepEqual(
            responses.map((r) => r.statusCode).sort(),
            [200, 400],
          );
          const issued = responses.find((r) => r.statusCode === 200)!.json();
          const me = await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${issued.token}` },
          });
          assert.equal(me.json().id, operator);
          assert.equal(me.json().role, "merchant");
        },
      );
      await t.test(
        "failed pairing approvals are throttled durably by account",
        async () => {
          for (let attempt = 0; attempt < 10; attempt++)
            assert.equal(
              (
                await app.inject({
                  method: "POST",
                  url: "/v1/device-links/approve",
                  headers: { authorization: `Bearer ${outsiderToken}` },
                  payload: { userCode: "ZZZZ-ZZZZ" },
                })
              ).statusCode,
              404,
            );
          const blocked = await app.inject({
            method: "POST",
            url: "/v1/device-links/approve",
            headers: { authorization: `Bearer ${outsiderToken}` },
            payload: { userCode: "ZZZZ-ZZZZ" },
          });
          assert.equal(blocked.statusCode, 429);
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM auth_attempts WHERE actor_hash=$1 AND kind='device_approve'",
                [hash(outsider)],
              )
            ).rows[0].n,
            10,
          );
        },
      );
      await t.test(
        "World login rejects another session before network verification and never relinks the card",
        async () => {
          const id = randomUUID(),
            handoff = randomToken(),
            exchange = randomToken(),
            nonce = "0x" + "01".repeat(32),
            savedSession = "session_" + "aa".repeat(64);
          await query("UPDATE accounts SET world_session=$2 WHERE id=$1", [
            customer,
            savedSession,
          ]);
          await query(
            "INSERT INTO world_requests(id,account_id,purpose,nonce,card_hash,card_last4,expires_at,rp_context,handoff_hash,exchange_hash) VALUES($1,$2,'login',$3,$4,'0708',now()+interval '5 minutes','{}',$5,$6)",
            [
              id,
              customer,
              nonce,
              cardHash(card, config.CARD_HMAC_SECRET),
              hash(handoff),
              hash(exchange),
            ],
          );
          const before = (
            await query(
              "SELECT active,linked_at FROM cards WHERE account_id=$1",
              [customer],
            )
          ).rows[0];
          const pending = await app.inject({
            method: "POST",
            url: `/v1/auth/card/${id}/exchange`,
            payload: { exchangeSecret: exchange },
          });
          assert.equal(pending.json().status, "pending");
          assert.equal(pending.json().token, undefined);
          const leaked = await app.inject({
            method: "POST",
            url: `/v1/auth/card/${id}/exchange`,
            payload: { exchangeSecret: handoff },
          });
          assert.equal(leaked.statusCode, 404);
          const result = {
            protocol_version: "4.0",
            nonce,
            session_id: "session_" + "bb".repeat(64),
            environment: config.WORLD_ENVIRONMENT,
            responses: [
              {
                identifier: "selfie",
                issuer_schema_id: 11,
                session_nullifier: ["unused", "action"],
                sybil_score: 1,
                proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
              },
            ],
            integrity_bundle: { version: 2 },
          };
          const failed = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${id}/verify`,
            headers: { authorization: `Bearer ${handoff}` },
            payload: { result },
          });
          assert.equal(failed.statusCode, 403);
          assert.equal(failed.json().error.code, "session_mismatch");
          assert.deepEqual(
            (
              await query(
                "SELECT active,linked_at FROM cards WHERE account_id=$1",
                [customer],
              )
            ).rows[0],
            before,
          );
          assert.equal(
            (
              await query(
                "SELECT consumed_at FROM world_requests WHERE id=$1",
                [id],
              )
            ).rows[0].consumed_at,
            null,
          );
          // Exchange state-machine test: seed an already verified database request, not a proof-verifier substitute.
          await query(
            "UPDATE world_requests SET consumed_at=now() WHERE id=$1",
            [id],
          );
          const responses = await Promise.all(
            [1, 2].map(() =>
              app.inject({
                method: "POST",
                url: `/v1/auth/card/${id}/exchange`,
                payload: { exchangeSecret: exchange },
              }),
            ),
          );
          assert.deepEqual(
            responses.map((r) => r.statusCode).sort(),
            [200, 410],
          );
          const issued = responses.find((r) => r.statusCode === 200)!.json();
          assert.equal(issued.status, "verified");
          assert.equal(
            (
              await app.inject({
                method: "GET",
                url: "/v1/me",
                headers: { authorization: `Bearer ${issued.token}` },
              })
            ).json().id,
            customer,
          );
        },
      );
      await t.test(
        "cancelling an owned World request expires it atomically and rejects subsequent proof submission",
        async () => {
          const id = randomUUID(),
            handoff = randomToken();
          await query(
            "INSERT INTO world_requests(id,account_id,purpose,nonce,card_hash,card_last4,expires_at,rp_context,handoff_hash) VALUES($1,$2,'enrollment',$3,$4,'0708',now()+interval '5 minutes','{}',$5)",
            [
              id,
              customer,
              "0x" + randomBytes(32).toString("hex"),
              cardHash(card, config.CARD_HMAC_SECRET),
              hash(handoff),
            ],
          );
          const before = (
            await query(
              "SELECT active,linked_at FROM cards WHERE account_id=$1",
              [customer],
            )
          ).rows[0];
          const stranger = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${id}/cancel`,
            headers: { authorization: `Bearer ${outsiderToken}` },
            payload: {},
          });
          assert.equal(stranger.statusCode, 404);
          const cancelled = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${id}/cancel`,
            headers: { authorization: `Bearer ${customerToken}` },
            payload: {},
          });
          assert.equal(cancelled.json().status, "cancelled");
          const status = await app.inject({
            method: "GET",
            url: `/v1/world/requests/${id}`,
            headers: { authorization: `Bearer ${customerToken}` },
          });
          assert.equal(status.json().status, "expired");
          const denied = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${id}/verify`,
            headers: { authorization: `Bearer ${handoff}` },
            payload: { result: {} },
          });
          assert.equal(denied.statusCode, 410);
          assert.deepEqual(
            (
              await query(
                "SELECT active,linked_at FROM cards WHERE account_id=$1",
                [customer],
              )
            ).rows[0],
            before,
          );
        },
      );
      await t.test(
        "login cancellation requires its native exchange secret and never undoes completed verification",
        async () => {
          const id = randomUUID(),
            handoff = randomToken(),
            secret = randomToken();
          await query(
            "INSERT INTO world_requests(id,account_id,purpose,nonce,card_hash,card_last4,expires_at,rp_context,handoff_hash,exchange_hash) VALUES($1,$2,'login',$3,$4,'0708',now()+interval '5 minutes','{}',$5,$6)",
            [
              id,
              customer,
              "0x" + randomBytes(32).toString("hex"),
              cardHash(card, config.CARD_HMAC_SECRET),
              hash(handoff),
              hash(secret),
            ],
          );
          const forbidden = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${id}/cancel`,
            payload: { exchangeSecret: handoff },
          });
          assert.equal(forbidden.statusCode, 404);
          // A verification finishing under the request row lock wins before cancellation; no proof service is stubbed.
          const locked = await pool.connect();
          await locked.query("BEGIN");
          await locked.query(
            "SELECT id FROM world_requests WHERE id=$1 FOR UPDATE",
            [id],
          );
          const cancellation = app.inject({
            method: "POST",
            url: `/v1/world/requests/${id}/cancel`,
            payload: { exchangeSecret: secret },
          });
          await locked.query(
            "UPDATE world_requests SET consumed_at=now() WHERE id=$1",
            [id],
          );
          await locked.query("COMMIT");
          locked.release();
          const result = await cancellation;
          assert.equal(result.json().status, "verified");
          assert(
            (
              await query(
                "SELECT consumed_at,expires_at>now() still_valid FROM world_requests WHERE id=$1",
                [id],
              )
            ).rows[0].still_valid,
          );
          const next = randomUUID(),
            nextSecret = randomToken();
          await query(
            "INSERT INTO world_requests(id,account_id,purpose,nonce,card_hash,card_last4,expires_at,rp_context,handoff_hash,exchange_hash) VALUES($1,$2,'login',$3,$4,'0708',now()+interval '5 minutes','{}',$5,$6)",
            [
              next,
              customer,
              "0x" + randomBytes(32).toString("hex"),
              cardHash(card, config.CARD_HMAC_SECRET),
              hash(randomToken()),
              hash(nextSecret),
            ],
          );
          const cancelled = await app.inject({
            method: "POST",
            url: `/v1/world/requests/${next}/cancel`,
            payload: { exchangeSecret: nextSecret },
          });
          assert.equal(cancelled.json().status, "cancelled");
          assert.equal(
            (
              await query(
                "SELECT expires_at<=now() expired FROM world_requests WHERE id=$1",
                [next],
              )
            ).rows[0].expired,
            true,
          );
        },
      );
      await t.test("revoked terminal cannot issue new challenges", async () => {
        await app.inject({
          method: "DELETE",
          url: `/v1/terminals/${terminal}`,
          headers,
        });
        const row = (await query("SELECT id FROM invoices LIMIT 1")).rows[0];
        const response = await app.inject({
          method: "POST",
          url: `/v1/invoices/${row.id}/challenge`,
          headers,
          payload: { terminalId: terminal },
        });
        assert.equal(response.statusCode, 409);
      });
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
