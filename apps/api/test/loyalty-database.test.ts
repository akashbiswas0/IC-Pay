import { test } from "node:test";
import assert from "node:assert/strict";
import {
  randomUUID,
  generateKeyPairSync,
  sign,
  randomBytes,
} from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import {
  canonicalScan,
  scanSchema,
  cardHash,
  hash,
  randomToken,
} from "../src/protocol.js";
const database = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL pooled points protect quote caps, prior consent, reservations and refund intent",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "loyalty_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      DATABASE_SSL_CA_FILE: "",
      CARD_HMAC_SECRET: "loyalty-real-postgres-test-secret-32-chars",
      CHAIN_ID: "11155111",
      TOKEN_ADDRESS: "0x" + "11".repeat(20),
      PAYMENT_ADDRESS: "0x" + "22".repeat(20),
      REWARD_PAYMENT_ADDRESS: "0x" + "33".repeat(20),
      COLLECTIBLE_PAYMENT_ADDRESS: "0x" + "44".repeat(20),
      LOYALTY_PAYMENT_ADDRESS: "0x" + "55".repeat(20),
      MULTIBAAS_URL: "https://127.0.0.1:1",
      MULTIBAAS_API_KEY: "not-invoked",
      AWS_KMS_OPERATOR_KEY_ID: "not-invoked",
    });
    const { pool, transaction } = await import("../src/db.js");
    const { config } = await import("../src/config.js");
    const { buildServer } = await import("../src/server.js");
    const { publicPolicy } = await import("../src/card-wallets.js");
    const { paymentRouter } = await import("../src/payment-router.js");
    const { requestInvoice } = await import("../src/payment-requests.js");
    const { allowsPolicyRouter } = await import("../src/policy-router.js");
    const { reservePoints, reservedPoints, consumePoints } =
      await import("../src/loyalty.js");
    const { authorizeForSigning, failJob } = await import("../src/worker.js");
    const { requestRefund, dueLoyaltyRefunds, guardRefundWallet } =
      await import("../src/loyalty-refunds.js");
    const unit = 10n ** 18n,
      account = randomUUID(),
      operator = randomUUID(),
      merchant = randomUUID(),
      card = randomUUID(),
      wallet = randomUUID(),
      policy = randomUUID(),
      terminal = randomUUID(),
      physical = "0102030405060708",
      address = "0x" + "66".repeat(20),
      recipient = "0x" + "77".repeat(20),
      userToken = randomToken(),
      merchantToken = randomToken();
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const headers = { authorization: `Bearer ${userToken}` },
      merchantHeaders = { authorization: `Bearer ${merchantToken}` };
    const app = await buildServer();
    try {
      const migrations = (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter((n) => n.endsWith(".sql"))
        .sort();
      for (const name of migrations.filter((n) => !n.startsWith("018")))
        await pool.query(
          await readFile(
            new URL("../migrations/" + name, import.meta.url),
            "utf8",
          ),
        );
      await pool.query(
        "INSERT INTO accounts(id,role,verified)VALUES($1,'customer',true),($2,'merchant',false)",
        [account, operator],
      );
      await pool.query(
        "INSERT INTO sessions(token_hash,account_id,expires_at)VALUES($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')",
        [hash(userToken), account, hash(merchantToken), operator],
      );
      await pool.query(
        "INSERT INTO merchants(id,name,recipient)VALUES($1,'Points Shop',$2)",
        [merchant, recipient],
      );
      await pool.query(
        "INSERT INTO merchant_operators(account_id,merchant_id)VALUES($1,$2)",
        [operator, merchant],
      );
      await pool.query(
        "INSERT INTO cards(id,card_hash,account_id,last4)VALUES($1,$2,$3,'0708')",
        [card, cardHash(physical, config.CARD_HMAC_SECRET), account],
      );
      await pool.query(
        "INSERT INTO wallets(id,account_id,card_id,address,key_name,key_id,provider,status)VALUES($1,$2,$3,$4,$5,'customer-test-key','aws_kms','ready'),($6,$7,NULL,$8,$9,'merchant-test-key','aws_kms','ready')",
        [
          wallet,
          account,
          card,
          address,
          randomUUID(),
          randomUUID(),
          operator,
          recipient,
          randomUUID(),
        ],
      );
      await pool.query(
        "INSERT INTO policies(id,account_id,card_id,enabled,per_payment_limit,total_limit,expires_at,router_address,use_rewards,merchant_scope)VALUES($1,$2,$3,true,$4,$5,now()+interval '1 hour',$6,true,'all')",
        [
          policy,
          account,
          card,
          String(10n * unit),
          String(100n * unit),
          config.COLLECTIBLE_PAYMENT_ADDRESS,
        ],
      );
      await pool.query(
        "INSERT INTO terminals(id,merchant_id,public_key,name)VALUES($1,$2,$3,'Real P256 test terminal')",
        [
          terminal,
          merchant,
          keys.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
        ],
      );
      for (const name of migrations.filter((n) => n.startsWith("018")))
        await pool.query(
          await readFile(
            new URL("../migrations/" + name, import.meta.url),
            "utf8",
          ),
        );
      await t.test(
        "migration retains earlier enabled consent and changing active router needs explicit new approval",
        async () => {
          const old = (
            await pool.query("SELECT * FROM policies WHERE id=$1", [policy])
          ).rows[0];
          assert.equal(paymentRouter().kind, "loyalty");
          assert.equal(publicPolicy(old).requiresApproval, true);
          assert.equal(publicPolicy(old).maxPointsPerPayment, null);
          assert.equal(old.router_address, config.COLLECTIBLE_PAYMENT_ADDRESS);
          assert.equal(
            (
              await pool.query(
                "SELECT router_address FROM policy_router_consents WHERE policy_id=$1",
                [policy],
              )
            ).rows[0].router_address,
            config.COLLECTIBLE_PAYMENT_ADDRESS,
          );
          await pool.query(
            "UPDATE policies SET router_address=$2 WHERE id=$1",
            [policy, config.LOYALTY_PAYMENT_ADDRESS],
          );
          const active = (
            await pool.query("SELECT * FROM policies WHERE id=$1", [policy])
          ).rows[0];
          assert(
            await allowsPolicyRouter(
              pool,
              active,
              config.COLLECTIBLE_PAYMENT_ADDRESS!,
              true,
            ),
          );
          assert.equal(
            await allowsPolicyRouter(
              pool,
              active,
              config.COLLECTIBLE_PAYMENT_ADDRESS!,
              false,
            ),
            false,
          );
          assert.equal(
            await allowsPolicyRouter(
              pool,
              active,
              config.REWARD_PAYMENT_ADDRESS!,
              true,
            ),
            false,
          );
        },
      );
      await t.test(
        "policy nullable point cap persists and invalid whole-point quantities fail",
        async () => {
          const body = {
            cardId: card,
            enabled: false,
            router: "loyalty",
            perPaymentLimit: String(10n * unit),
            totalLimit: String(100n * unit),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            merchantScope: "all",
            useRewards: true,
            maxPointsPerPayment: "2",
          };
          const result = await app.inject({
            method: "PUT",
            url: "/v1/policy",
            headers,
            payload: body,
          });
          assert.equal(result.statusCode, 200, result.body);
          assert.equal(result.json().maxPointsPerPayment, "2");
          for (const value of ["-1", "0.5", "01"]) {
            const bad = await app.inject({
              method: "PUT",
              url: "/v1/policy",
              headers,
              payload: { ...body, maxPointsPerPayment: value },
            });
            assert.equal(bad.statusCode, 400);
          }
          await pool.query(
            "UPDATE policies SET enabled=true,max_points_per_payment=NULL WHERE id=$1",
            [policy],
          );
        },
      );
      await t.test(
        "v3 scan quote metadata is immutable; ordinary payment works with customer reward opt-out",
        async () => {
          await pool.query(
            "UPDATE policies SET use_rewards=false WHERE id=$1",
            [policy],
          );
          const invoice = await requestInvoice(
            merchant,
            String(unit),
            "First visit",
            randomUUID(),
            false,
            "loyalty",
            null,
          );
          assert.equal(invoice.scan_version, 3);
          assert.equal(invoice.reward_model, "points");
          const challenge = await app.inject({
            method: "POST",
            url: `/v1/invoices/${invoice.id}/challenge`,
            headers: merchantHeaders,
            payload: { terminalId: terminal },
          });
          assert.equal(challenge.statusCode, 200, challenge.body);
          const payload = scanSchema.parse({
            version: 3,
            terminalId: terminal,
            invoiceId: invoice.id,
            challenge: challenge.json().challenge,
            cardId: physical,
            chainId: "11155111",
            token: config.TOKEN_ADDRESS,
            amount: String(unit),
            expiresAt: challenge.json().expiresAt,
            routerAddress: config.LOYALTY_PAYMENT_ADDRESS,
            useReward: false,
            maxPoints: null,
          });
          const signature = sign(
            "sha256",
            canonicalScan(payload),
            keys.privateKey,
          ).toString("base64");
          const wrong = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers: merchantHeaders,
            payload: { payload: { ...payload, maxPoints: "1" }, signature },
          });
          assert.equal(wrong.statusCode, 403);
          const accepted = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers: merchantHeaders,
            payload: { payload, signature },
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          const job = (
            await pool.query(
              "SELECT j.*,i.merchant_id,i.recipient,i.expires_at,w.address,w.key_id FROM payment_jobs j JOIN invoices i ON i.id=j.invoice_id JOIN wallets w ON w.id=j.wallet_id WHERE j.invoice_id=$1",
              [invoice.id],
            )
          ).rows[0];
          assert.equal(job.points_redeemed, "0");
          await transaction((db) => authorizeForSigning(db, job));
          await failJob(job, "fixture_cancel");
        },
      );
      async function pointJob(points = "2") {
        const id = randomUUID(),
          invoice = await requestInvoice(
            merchant,
            String(BigInt(points) * unit),
            "Point purchase",
            randomUUID(),
            true,
            "loyalty",
            points,
          );
        await pool.query(
          "UPDATE invoices SET account_id=$2,amount=0,discount_amount=gross_amount,points_redeemed=$3,status='authorised' WHERE id=$1",
          [invoice.id, account, points],
        );
        await pool.query(
          "INSERT INTO payment_jobs(id,account_id,invoice_id,wallet_id,card_id,policy_id,kind,amount,gross_amount,discount_amount,points_redeemed,max_points,reward_model,expected_router,expected_chain,expected_token,terminal_id,card_hash,card_linked_at)SELECT $1,$2,$3,$4,$5,$6,'payment',0,$7,$7,$8,$8,'points',$9,$10,$11,$12,c.card_hash,c.linked_at FROM cards c WHERE c.id=$5",
          [
            id,
            account,
            invoice.id,
            wallet,
            card,
            policy,
            String(BigInt(points) * unit),
            points,
            config.LOYALTY_PAYMENT_ADDRESS,
            config.CHAIN_ID,
            config.TOKEN_ADDRESS,
            terminal,
          ],
        );
        return (
          await pool.query(
            "SELECT j.*,i.merchant_id,i.recipient,i.expires_at,w.address,w.key_id FROM payment_jobs j JOIN invoices i ON i.id=j.invoice_id JOIN wallets w ON w.id=j.wallet_id WHERE j.id=$1",
            [id],
          )
        ).rows[0];
      }
      await t.test(
        "exact point reservations and lower consent caps stop already queued signatures",
        async () => {
          const job = await pointJob();
          await transaction((db) =>
            reservePoints(
              db,
              wallet,
              merchant,
              job.id,
              "2",
              config.LOYALTY_PAYMENT_ADDRESS!,
            ),
          );
          assert.equal(
            await reservedPoints(
              wallet,
              merchant,
              config.LOYALTY_PAYMENT_ADDRESS!,
            ),
            2n,
          );
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /disabled before signing/,
          );
          await pool.query(
            "UPDATE policies SET use_rewards=true,max_points_per_payment=1 WHERE id=$1",
            [policy],
          );
          await assert.rejects(
            transaction((db) => authorizeForSigning(db, job)),
            /disabled before signing/,
          );
          await pool.query(
            "UPDATE policies SET max_points_per_payment=2 WHERE id=$1",
            [policy],
          );
          await transaction((db) => authorizeForSigning(db, job));
          await assert.rejects(
            transaction((db) =>
              authorizeForSigning(db, { ...job, max_points: "1" }),
            ),
            /disabled before signing/,
          );
          await transaction(async (db) => {
            await consumePoints(db, job);
            await db.query(
              "UPDATE payment_jobs SET status='confirmed' WHERE id=$1",
              [job.id],
            );
          });
          assert.equal(
            await reservedPoints(
              wallet,
              merchant,
              config.LOYALTY_PAYMENT_ADDRESS!,
            ),
            0n,
          );
          await pool.query(
            "UPDATE payment_jobs SET status='reconciling' WHERE id=$1",
            [job.id],
          );
          assert.equal(
            await reservedPoints(
              wallet,
              merchant,
              config.LOYALTY_PAYMENT_ADDRESS!,
            ),
            2n,
          );
          await failJob(job, "fixture_revert");
          assert.equal(
            await reservedPoints(
              wallet,
              merchant,
              config.LOYALTY_PAYMENT_ADDRESS!,
            ),
            0n,
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO payment_jobs(id,account_id,kind,amount,reward_model,gross_amount,discount_amount,points_redeemed)VALUES($1,$2,'approval',0,'points',1,1,1)",
              [randomUUID(), account],
            ),
            (error) => (error as any).code === "23514",
          );
        },
      );
      async function paidInvoice(amount: bigint) {
        const invoice = await requestInvoice(
          merchant,
          String(amount),
          "Refund test",
          randomUUID(),
          false,
          "loyalty",
          null,
        );
        const tx = "0x" + randomBytes(32).toString("hex");
        await pool.query(
          "UPDATE invoices SET account_id=$2,status='confirmed' WHERE id=$1",
          [invoice.id, account],
        );
        await pool.query(
          "INSERT INTO payment_jobs(id,account_id,invoice_id,wallet_id,card_id,kind,amount,status,expected_router,expected_token,expected_chain,tx_hash,block_number,block_hash)VALUES($1,$2,$3,$4,$5,'payment',$6,'confirmed',$7,$8,$9,$10,1,$10)",
          [
            randomUUID(),
            account,
            invoice.id,
            wallet,
            card,
            String(amount),
            config.LOYALTY_PAYMENT_ADDRESS,
            config.TOKEN_ADDRESS,
            config.CHAIN_ID,
            tx,
          ],
        );
        return invoice;
      }
      let a: any, b: any, refundA: any, refundB: any, requestA: string;
      await t.test(
        "refund retry intent is account-owned, request-specific and preserves full immutable token amount",
        async () => {
          a = await paidInvoice(100n * unit);
          b = await paidInvoice(50n * unit);
          requestA = randomUUID();
          refundA = await requestRefund(operator, merchant, a.id, requestA);
          refundB = await requestRefund(operator, merchant, b.id, randomUUID());
          assert.equal(
            (await requestRefund(operator, merchant, a.id, requestA))!.id,
            refundA.id,
          );
          assert.equal(refundA.amount, String(100n * unit));
          await assert.rejects(
            requestRefund(operator, merchant, b.id, requestA),
            /different payment/,
          );
          const denied = await app.inject({
            method: "POST",
            url: `/v1/invoices/${a.id}/refund`,
            headers,
            payload: { requestId: randomUUID() },
          });
          assert.equal(denied.statusCode, 403);
          assert.equal(
            (await app.inject({ url: `/v1/refunds/${refundA.id}`, headers }))
              .statusCode,
            200,
          );
          const stored = (
            await pool.query("SELECT * FROM loyalty_refunds WHERE id=$1", [
              refundA.id,
            ])
          ).rows[0];
          await guardRefundWallet(stored, async () => undefined);
          await pool.query(
            "UPDATE wallets SET status='needs_attention' WHERE account_id=$1",
            [operator],
          );
          await assert.rejects(
            guardRefundWallet(stored, async () => undefined),
            /changed/,
          );
          await pool.query(
            "UPDATE wallets SET status='ready' WHERE account_id=$1",
            [operator],
          );
        },
      );
      await t.test(
        "shared merchant allowance serializes entire first approval/refund before next refund",
        async () => {
          await pool.query(
            "UPDATE loyalty_refunds SET created_at=now()-interval '2 minutes',updated_at=now() WHERE id=$1",
            [refundA.id],
          );
          await pool.query(
            "UPDATE loyalty_refunds SET created_at=now()-interval '1 minute',updated_at=now() WHERE id=$1",
            [refundB.id],
          );
          let selected = await dueLoyaltyRefunds();
          assert(selected.some((r) => r.id === refundA.id));
          assert(!selected.some((r) => r.id === refundB.id));
          await pool.query(
            "UPDATE loyalty_refunds SET stage='refund' WHERE id=$1",
            [refundA.id],
          );
          selected = await dueLoyaltyRefunds();
          assert(!selected.some((r) => r.id === refundB.id));
          await pool.query(
            "UPDATE loyalty_refunds SET stage='confirmed',updated_at=now() WHERE id=$1",
            [refundA.id],
          );
          selected = await dueLoyaltyRefunds();
          assert(selected.some((r) => r.id === refundB.id));
          await pool.query(
            "UPDATE loyalty_refunds SET stage='refund' WHERE id=$1",
            [refundA.id],
          );
          selected = await dueLoyaltyRefunds();
          assert(!selected.some((r) => r.id === refundB.id));
        },
      );
      await t.test(
        "failed refund intent stays idempotent and unknown prior signing cannot trigger a new attempt",
        async () => {
          await pool.query(
            "UPDATE loyalty_refunds SET stage='failed',approval_attempted_at=now(),error_code='refund_transaction_reverted' WHERE id=$1",
            [refundA.id],
          );
          assert.equal(
            (await requestRefund(operator, merchant, a.id, requestA))!.status,
            "failed",
          );
          await assert.rejects(
            requestRefund(operator, merchant, a.id, randomUUID()),
            (error) => (error as any).code === "refund_submission_unknown",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int count FROM loyalty_refunds WHERE invoice_id=$1",
                [a.id],
              )
            ).rows[0].count,
            1,
          );
        },
      );
      await t.test(
        "merchant points program is explicit, idempotent and does not silently mutate prior campaign",
        async () => {
          const requestId = randomUUID(),
            terms = {
              enabled: true,
              minPurchase: String(unit),
              earnBps: 500,
              maxPointsPerPurchase: "50",
              validitySeconds: 2592000,
              requestId,
            };
          const saved = await app.inject({
            method: "PUT",
            url: "/v1/merchant/loyalty/program",
            headers: merchantHeaders,
            payload: terms,
          });
          assert.equal(saved.statusCode, 200, saved.body);
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/loyalty/program",
                headers: merchantHeaders,
                payload: terms,
              })
            ).json().id,
            saved.json().id,
          );
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/loyalty/program",
                headers: merchantHeaders,
                payload: { ...terms, earnBps: 1000 },
              })
            ).statusCode,
            409,
          );
          const op = (
            await pool.query(
              "SELECT router_address,terms FROM reward_campaign_operations WHERE id=$1",
              [saved.json().id],
            )
          ).rows[0];
          assert.equal(op.router_address, config.LOYALTY_PAYMENT_ADDRESS);
          assert.equal(op.terms.maxPointsPerPurchase, "50");
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
