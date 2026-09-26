import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { hash, randomToken } from "../src/protocol.js";

const database = process.env.TEST_DATABASE_URL;
test(
  "merchant self-service signup and account-scoped invitations",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"), "Use a dedicated test database");
    const schema = "merchant_signup_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.CHAIN_ID = "11155111";
    process.env.TOKEN_ADDRESS = "0x" + "11".repeat(20);
    process.env.PAYMENT_ADDRESS = "0x" + "22".repeat(20);
    // No provider is invoked by these HTTP tests: cloud work is queued for the worker.
    process.env.MULTIBAAS_URL = "https://not-contacted.invalid";
    process.env.MULTIBAAS_API_KEY = "unused-in-route-tests";
    process.env.AWS_KMS_OPERATOR_KEY_ID = "unused-in-route-tests";
    const { pool } = await import("../src/db.js");
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer();
    try {
      const folder = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(folder))
        .filter((v) => v.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(file, folder), "utf8"));
      const secret = randomToken();
      const payload = { name: "Same business name", signupSecret: secret };
      const signup = () =>
        app.inject({ method: "POST", url: "/v1/merchants/register", payload });
      let firstId: string;
      let secondId: string;
      let secondSecret: string;
      await t.test(
        "concurrent retry creates one account and a durable wallet job",
        async () => {
          const responses = await Promise.all([signup(), signup()]);
          assert(responses.every((r) => r.statusCode === 200));
          firstId = responses[0].json().accountId;
          assert.equal(responses[1].json().accountId, firstId);
          assert.equal(responses[0].json().token, secret);
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM accounts")).rows[0]
              .n,
            1,
          );
          const row = (
            await pool.query(
              "SELECT r.stage,r.wallet_attempted_at,w.status FROM merchant_registrations r JOIN wallets w ON w.account_id=r.account_id WHERE r.account_id=$1",
              [firstId],
            )
          ).rows[0];
          assert.equal(row.stage, "wallet");
          assert.equal(row.wallet_attempted_at, null);
          assert.equal(row.status, "provisioning");
        },
      );
      await t.test(
        "another business gets a different account even with the same display name",
        async () => {
          secondSecret = randomToken();
          const response = await app.inject({
            method: "POST",
            url: "/v1/merchants/register",
            payload: { ...payload, signupSecret: secondSecret },
          });
          assert.equal(response.statusCode, 200);
          secondId = response.json().accountId;
          assert.notEqual(firstId, secondId);
          const rows = (
            await pool.query(
              "SELECT r.reserved_merchant_id,w.key_name FROM merchant_registrations r JOIN wallets w ON w.account_id=r.account_id",
            )
          ).rows;
          assert.equal(
            new Set(rows.map((r) => r.reserved_merchant_id)).size,
            2,
          );
          assert.equal(new Set(rows.map((r) => r.key_name)).size, 2);
        },
      );
      await t.test(
        "signup rejects role injection and changing an existing request",
        async () => {
          const role = await app.inject({
            method: "POST",
            url: "/v1/merchants/register",
            payload: { ...payload, role: "admin" },
          });
          assert.equal(role.statusCode, 400);
          const changed = await app.inject({
            method: "POST",
            url: "/v1/merchants/register",
            payload: { ...payload, name: "Changed" },
          });
          assert.equal(changed.statusCode, 409);
        },
      );
      await t.test(
        "pending merchants cannot invite and setup is account-scoped",
        async () => {
          const setup = await app.inject({
            method: "GET",
            url: "/v1/merchant/setup",
            headers: { authorization: `Bearer ${secret}` },
          });
          assert.equal(setup.statusCode, 200);
          assert.equal(setup.json().status, "wallet");
          const invite = await app.inject({
            method: "POST",
            url: "/v1/merchant/invitations",
            headers: { authorization: `Bearer ${secret}` },
            payload: {},
          });
          assert.equal(invite.statusCode, 403);
          const unsigned = await app.inject({
            method: "POST",
            url: "/v1/merchant/invitations",
            payload: {},
          });
          assert.equal(unsigned.statusCode, 401);
        },
      );
      await t.test(
        "merchant can issue a single-use invitation only for its own account",
        async () => {
          const registration = (
            await pool.query(
              "SELECT reserved_merchant_id FROM merchant_registrations WHERE account_id=$1",
              [firstId!],
            )
          ).rows[0];
          await pool.query(
            "INSERT INTO merchants(id,name,recipient) VALUES($1,'Business A',$2)",
            [registration.reserved_merchant_id, "0x" + "33".repeat(20)],
          );
          await pool.query(
            "INSERT INTO merchant_operators(account_id,merchant_id) VALUES($1,$2)",
            [firstId!, registration.reserved_merchant_id],
          );
          await pool.query(
            "UPDATE merchant_registrations SET stage='ready' WHERE account_id=$1",
            [firstId!],
          );
          const invite = await app.inject({
            method: "POST",
            url: "/v1/merchant/invitations",
            headers: { authorization: `Bearer ${secret}` },
            payload: {},
          });
          assert.equal(invite.statusCode, 200);
          assert.equal(invite.json().merchantName, "Business A");
          assert.match(invite.json().code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
          const override = await app.inject({
            method: "POST",
            url: "/v1/merchant/invitations",
            headers: { authorization: `Bearer ${secret}` },
            payload: { accountId: secondId! },
          });
          assert.equal(override.statusCode, 400);
          const exchange = await app.inject({
            method: "POST",
            url: "/v1/invitations/exchange",
            payload: { code: invite.json().code },
          });
          assert.equal(exchange.statusCode, 200);
          const me = await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${exchange.json().token}` },
          });
          assert.equal(me.json().id, firstId!);
          assert.equal(me.json().merchantId, registration.reserved_merchant_id);
          const used = await app.inject({
            method: "POST",
            url: "/v1/invitations/exchange",
            payload: { code: invite.json().code },
          });
          assert.equal(used.statusCode, 400);
          const other = await app.inject({
            method: "GET",
            url: "/v1/merchant/setup",
            headers: { authorization: `Bearer ${secondSecret!}` },
          });
          assert.equal(other.json().status, "wallet");
        },
      );
      await t.test(
        "customers cannot generate merchant invitations",
        async () => {
          const account = randomUUID(),
            token = randomToken();
          await pool.query(
            "INSERT INTO accounts(id,role,verified) VALUES($1,'customer',true)",
            [account],
          );
          await pool.query(
            "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
            [hash(token), account],
          );
          const response = await app.inject({
            method: "POST",
            url: "/v1/merchant/invitations",
            headers: { authorization: `Bearer ${token}` },
            payload: {},
          });
          assert.equal(response.statusCode, 403);
        },
      );
      await t.test(
        "same-phone activation is scoped, retryable and enrolls one terminal",
        async () => {
          const publicKey = generateKeyPairSync("ec", {
            namedCurve: "prime256v1",
          })
            .publicKey.export({ type: "spki", format: "der" })
            .toString("base64");
          const headers = { authorization: `Bearer ${secret}` };
          const { createInvitation } = await import("../src/device-auth.js");
          const { code } = await createInvitation(firstId!);
          const payload = { code, publicKey };
          const activation = () =>
            app.inject({
              method: "POST",
              url: "/v1/merchant/activate",
              headers,
              payload,
            });
          const results = await Promise.all([activation(), activation()]);
          assert(results.every((r) => r.statusCode === 200));
          assert.equal(results[0].json().id, results[1].json().id);
          const terminalId = results[0].json().id;
          const terminalState = await app.inject({
            method: "GET",
            url: `/v1/terminals/${terminalId}`,
            headers,
          });
          assert.equal(terminalState.statusCode, 200);
          assert.equal(terminalState.json().active, true);
          assert.equal(terminalState.json().publicKey, publicKey);
          assert.equal(
            (await pool.query("SELECT count(*)::int n FROM terminals")).rows[0]
              .n,
            1,
          );
          const otherKey = generateKeyPairSync("ec", {
            namedCurve: "prime256v1",
          })
            .publicKey.export({ type: "spki", format: "der" })
            .toString("base64");
          const otherDevice = await app.inject({
            method: "POST",
            url: "/v1/merchant/activate",
            headers,
            payload: { code, publicKey: otherKey },
          });
          assert.equal(otherDevice.statusCode, 400);
          const replayLogin = await app.inject({
            method: "POST",
            url: "/v1/invitations/exchange",
            payload: { code },
          });
          assert.equal(replayLogin.statusCode, 400);
          const secondMerchant = (
            await pool.query(
              "SELECT reserved_merchant_id FROM merchant_registrations WHERE account_id=$1",
              [secondId!],
            )
          ).rows[0].reserved_merchant_id;
          await pool.query(
            "INSERT INTO merchants(id,name,recipient) VALUES($1,'Business B',$2)",
            [secondMerchant, "0x" + "44".repeat(20)],
          );
          await pool.query(
            "INSERT INTO merchant_operators(account_id,merchant_id) VALUES($1,$2)",
            [secondId!, secondMerchant],
          );
          const wrongAccount = await app.inject({
            method: "POST",
            url: "/v1/merchant/activate",
            headers: { authorization: `Bearer ${secondSecret!}` },
            payload,
          });
          assert.equal(wrongAccount.statusCode, 400);
          const otherTerminal = await app.inject({
            method: "GET",
            url: `/v1/terminals/${terminalId}`,
            headers: { authorization: `Bearer ${secondSecret!}` },
          });
          assert.equal(otherTerminal.statusCode, 404);
          await app.inject({
            method: "DELETE",
            url: `/v1/terminals/${terminalId}`,
            headers,
          });
          const revoked = await app.inject({
            method: "GET",
            url: `/v1/terminals/${terminalId}`,
            headers,
          });
          assert.equal(revoked.json().active, false);
          assert.equal((await activation()).statusCode, 400);
          const expired = await createInvitation(firstId!);
          await pool.query(
            "UPDATE invitations SET expires_at=now()-interval '1 second' WHERE code_hash=$1",
            [hash(expired.code.replaceAll("-", ""))],
          );
          const invalid = await app.inject({
            method: "POST",
            url: "/v1/merchant/activate",
            headers,
            payload: { code: expired.code, publicKey },
          });
          assert.equal(invalid.statusCode, 400);
        },
      );
      await t.test(
        "a revoked signup credential cannot sign in again through registration",
        async () => {
          await app.inject({
            method: "POST",
            url: "/v1/logout",
            headers: { authorization: `Bearer ${secret}` },
            payload: {},
          });
          const retried = await signup();
          assert.equal(retried.statusCode, 410);
        },
      );
      await t.test(
        "payment request retries recover the same invoice and allowance job",
        async () => {
          const { requestInvoice, requestAllowance, remainingPolicyAllowance } =
            await import("../src/payment-requests.js");
          const registrations = (
            await pool.query(
              "SELECT account_id,reserved_merchant_id FROM merchant_registrations ORDER BY created_at",
            )
          ).rows;
          const firstMerchant = registrations.find(
            (r) => r.account_id === firstId!,
          )!.reserved_merchant_id;
          const secondMerchant = registrations.find(
            (r) => r.account_id === secondId!,
          )!.reserved_merchant_id;
          const requestId = randomUUID();
          const invoices = await Promise.all([
            requestInvoice(firstMerchant, "20", "Restored request", requestId),
            requestInvoice(firstMerchant, "20", "Restored request", requestId),
          ]);
          assert.equal(invoices[0].id, invoices[1].id);
          await assert.rejects(
            requestInvoice(firstMerchant, "21", "Restored request", requestId),
            /different terms/,
          );
          const other = await requestInvoice(
            secondMerchant,
            "20",
            "Restored request",
            requestId,
          );
          assert.notEqual(other.id, invoices[0].id);
          const customer = randomUUID();
          await pool.query(
            "INSERT INTO accounts(id,role,verified) VALUES($1,'customer',true)",
            [customer],
          );
          await pool.query(
            "INSERT INTO wallets(account_id,address,key_name,status,provider,key_id) VALUES($1,$2,$3,'ready','aws_kms',$4)",
            [
              customer,
              "0x" + "55".repeat(20),
              "test-" + customer,
              "test-key-" + customer,
            ],
          );
          const allowanceId = randomUUID();
          const approvals = await Promise.all([
            requestAllowance(customer, "500", allowanceId),
            requestAllowance(customer, "500", allowanceId),
          ]);
          assert.equal(approvals[0].id, approvals[1].id);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM payment_jobs WHERE account_id=$1",
                [customer],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            requestAllowance(customer, "600", allowanceId),
            /different terms/,
          );
          await assert.rejects(
            requestAllowance(customer, "500", randomUUID()),
            /already being confirmed/,
          );
          await pool.query(
            "UPDATE payment_jobs SET status='confirmed' WHERE id=$1",
            [approvals[0].id],
          );
          assert.equal(
            (await requestAllowance(customer, "500", allowanceId)).status,
            "confirmed",
          );
          assert.equal(remainingPolicyAllowance("500", "30"), 470n);
          assert.equal(remainingPolicyAllowance("500", "500"), 0n);
          assert.equal(
            remainingPolicyAllowance("9007199254741000", "9007199254740990"),
            10n,
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
