import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
const database = process.env.TEST_DATABASE_URL;
test(
  "reward reservations and router migration preserve legacy state in real PostgreSQL",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "rewards_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      CARD_HMAC_SECRET: "reward-tests-card-secret-thirty-two-characters",
      CHAIN_ID: "11155111",
      TOKEN_ADDRESS: "0x" + "33".repeat(20),
      PAYMENT_ADDRESS: "0x" + "44".repeat(20),
      REWARD_PAYMENT_ADDRESS: "0x" + "55".repeat(20),
      MULTIBAAS_URL: "https://127.0.0.1:1",
      MULTIBAAS_API_KEY: "unreachable-transport-only",
      AWS_KMS_OPERATOR_KEY_ID: "fixture-owner-key-not-invoked",
    });
    const { pool, transaction } = await import("../src/db.js");
    const { buildServer } = await import("../src/server.js");
    const { config } = await import("../src/config.js");
    const { hash, randomToken, cardHash, canonicalScan, scanSchema } =
      await import("../src/protocol.js");
    const { reserveReward } = await import("../src/rewards.js");
    const { requestAllowance, requestInvoice } =
      await import("../src/payment-requests.js");
    const { routerSnapshot } = await import("../src/payment-router.js");
    const { authorizeForSigning, failJob } = await import("../src/worker.js");
    const { markSettlementUncertain } = await import("../src/settlement.js");
    for (const file of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((v) => v.endsWith(".sql"))
      .sort())
      await pool.query(
        await readFile(
          new URL("../migrations/" + file, import.meta.url),
          "utf8",
        ),
      );
    const account = randomUUID(),
      operator = randomUUID(),
      mid = randomUUID(),
      cardId = randomUUID(),
      walletId = randomUUID(),
      policyId = randomUUID(),
      terminalId = randomUUID(),
      token = randomToken(),
      merchantToken = randomToken();
    const digest = cardHash("0102030405060708", config.CARD_HMAC_SECRET);
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    await pool.query(
      "INSERT INTO accounts(id,role,verified) VALUES($1,'customer',true),($2,'merchant',false)",
      [account, operator],
    );
    await pool.query(
      "INSERT INTO merchants(id,name,recipient) VALUES($1,$2,$3)",
      [mid, "Reward integration merchant", "0x" + "66".repeat(20)],
    );
    await pool.query(
      "INSERT INTO merchant_operators(account_id,merchant_id) VALUES($1,$2)",
      [operator, mid],
    );
    await pool.query(
      "INSERT INTO cards(id,card_hash,account_id,last4) VALUES($1,$2,$3,$4)",
      [cardId, digest, account, "0708"],
    );
    await pool.query(
      "INSERT INTO wallets(id,account_id,card_id,address,key_name,key_id,status) VALUES($1,$2,$3,$4,$5,$6,'ready')",
      [
        walletId,
        account,
        cardId,
        "0x" + "77".repeat(20),
        "reward-fixture",
        "fixture-key",
      ],
    );
    await pool.query(
      "INSERT INTO policies(id,account_id,card_id,enabled,per_payment_limit,total_limit,expires_at,router_address,use_rewards) VALUES($1,$2,$3,true,100,1000,now()+interval '1 hour',$4,true)",
      [policyId, account, cardId, config.REWARD_PAYMENT_ADDRESS],
    );
    await pool.query(
      "INSERT INTO policy_merchants(account_id,policy_id,merchant_id) VALUES($1,$2,$3)",
      [account, policyId, mid],
    );
    await pool.query(
      "INSERT INTO terminals(id,merchant_id,public_key,name) VALUES($1,$2,$3,$4)",
      [
        terminalId,
        mid,
        publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        "test",
      ],
    );
    for (const [id, session] of [
      [account, token],
      [operator, merchantToken],
    ])
      await pool.query(
        "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hash(session!), id],
      );
    const app = await buildServer();
    const headers = { authorization: `Bearer ${merchantToken}` };
    const fixtureJob = async (invoice: any, rewardId = "1") => {
      const jobId = randomUUID();
      const generation = (
        await pool.query(
          "SELECT linked_at::text generation FROM cards WHERE id=$1",
          [cardId],
        )
      ).rows[0].generation;
      await pool.query(
        "INSERT INTO payment_jobs(id,invoice_id,account_id,kind,amount,wallet_id,policy_id,card_id,terminal_id,card_hash,card_linked_at,expected_chain,expected_token,expected_router,gross_amount,discount_amount,reward_id) VALUES($1,$2,$3,'payment',50,$4,$5,$6,$7,$8,$9,'11155111',$10,$11,100,50,$12)",
        [
          jobId,
          invoice.id,
          account,
          walletId,
          policyId,
          cardId,
          terminalId,
          digest,
          generation,
          config.TOKEN_ADDRESS,
          config.REWARD_PAYMENT_ADDRESS,
          rewardId,
        ],
      );
      return {
        ...(await pool.query("SELECT * FROM payment_jobs WHERE id=$1", [jobId]))
          .rows[0],
        address: "0x" + "77".repeat(20),
        key_id: "fixture-key",
        merchant_id: mid,
        recipient: "0x" + "66".repeat(20),
        expires_at: invoice.expires_at,
      };
    };
    try {
      await t.test(
        "new invoice snapshot selects new router while legacy snapshots remain usable",
        async () => {
          const requestId = randomUUID();
          const inv = await requestInvoice(
            mid,
            "100",
            "reward",
            requestId,
            true,
          );
          assert.equal(inv.router_address, config.REWARD_PAYMENT_ADDRESS);
          assert.equal(inv.scan_version, 2);
          assert.equal(inv.use_reward, true);
          await pool.query(
            "UPDATE invoices SET amount=50,discount_amount=50 WHERE id=$1",
            [inv.id],
          );
          assert.equal(
            (await requestInvoice(mid, "100", "reward", requestId, true)).id,
            inv.id,
          );
          await assert.rejects(() =>
            requestInvoice(mid, "100", "reward", requestId, false),
          );
          assert.equal(routerSnapshot(config.PAYMENT_ADDRESS).kind, "legacy");
          const legacyRequestId = randomUUID();
          const legacyApproval = await requestAllowance(
            account,
            "100",
            legacyRequestId,
            cardId,
            "legacy",
          );
          const recovered = await requestAllowance(
            account,
            "100",
            legacyRequestId,
            cardId,
          );
          assert.equal(recovered.id, legacyApproval.id);
          assert.equal(recovered.routerAddress, config.PAYMENT_ADDRESS);
          await assert.rejects(() =>
            requestAllowance(
              account,
              "100",
              legacyRequestId,
              cardId,
              "rewards",
            ),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT expected_router FROM payment_jobs WHERE id=$1",
                [legacyApproval.id],
              )
            ).rows[0].expected_router,
            config.PAYMENT_ADDRESS,
          );
          await pool.query(
            "UPDATE payment_jobs SET status='failed' WHERE id=$1",
            [legacyApproval.id],
          );
          const approval = await requestAllowance(
            account,
            "100",
            randomUUID(),
            cardId,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT expected_router FROM payment_jobs WHERE id=$1",
                [approval.id],
              )
            ).rows[0].expected_router,
            config.REWARD_PAYMENT_ADDRESS,
          );
        },
      );
      await t.test(
        "signed reward request cannot spend without the customer reward opt-in",
        async () => {
          await pool.query(
            "UPDATE policies SET use_rewards=false WHERE id=$1",
            [policyId],
          );
          const inv = await requestInvoice(mid, "100", "", randomUUID(), true);
          const response = await app.inject({
            method: "POST",
            url: `/v1/invoices/${inv.id}/challenge`,
            headers,
            payload: { terminalId },
          });
          assert.equal(response.statusCode, 200, response.body);
          const challenge = response.json();
          const payload = scanSchema.parse({
            version: 2,
            terminalId,
            invoiceId: inv.id,
            challenge: challenge.challenge,
            cardId: "0102030405060708",
            chainId: inv.chain_id,
            token: inv.token,
            amount: "100",
            expiresAt: challenge.expiresAt,
            routerAddress: inv.router_address,
            useReward: true,
          });
          const scan = await app.inject({
            method: "POST",
            url: "/v1/scans",
            headers,
            payload: {
              payload,
              signature: sign(
                "sha256",
                canonicalScan(payload),
                privateKey,
              ).toString("base64"),
            },
          });
          assert.equal(scan.statusCode, 403, scan.body);
          assert.equal(scan.json().error.code, "reward_permission_required");
          assert.equal(
            (
              await pool.query(
                "SELECT consumed_at FROM challenges WHERE invoice_id=$1",
                [inv.id],
              )
            ).rows[0].consumed_at,
            null,
          );
          await pool.query("UPDATE policies SET use_rewards=true WHERE id=$1", [
            policyId,
          ]);
        },
      );
      await t.test(
        "concurrent redemption reservations cannot claim the same NFT twice",
        async () => {
          const a = await fixtureJob(
              await requestInvoice(mid, "100", "", randomUUID(), true),
            ),
            b = await fixtureJob(
              await requestInvoice(mid, "100", "", randomUUID(), true),
            );
          const outcomes = await Promise.allSettled(
            [a, b].map((j) =>
              transaction((db) =>
                reserveReward(
                  db,
                  config.REWARD_PAYMENT_ADDRESS!,
                  "1",
                  walletId,
                  j.id,
                ),
              ),
            ),
          );
          assert.equal(
            outcomes.filter((v) => v.status === "fulfilled").length,
            1,
          );
          const winner = (
            await pool.query(
              "SELECT job_id FROM reward_reservations WHERE reward_id=$1",
              ["1"],
            )
          ).rows[0].job_id;
          const job = winner === a.id ? a : b;
          const other = winner === a.id ? b : a;
          await pool.query(
            "UPDATE payment_jobs SET status='confirmed' WHERE id=$1",
            [winner],
          );
          await pool.query(
            "UPDATE policies SET spent=50,reserved=0 WHERE id=$1",
            [policyId],
          );
          await pool.query(
            "UPDATE reward_reservations SET consumed_at=now() WHERE job_id=$1",
            [winner],
          );
          await markSettlementUncertain(job, "chain_reorganization");
          assert.equal(
            (
              await pool.query(
                "SELECT released_at FROM reward_reservations WHERE job_id=$1",
                [winner],
              )
            ).rows[0].released_at,
            null,
          );
          await assert.rejects(() =>
            transaction((db) =>
              reserveReward(
                db,
                config.REWARD_PAYMENT_ADDRESS!,
                "1",
                walletId,
                other.id,
              ),
            ),
          );
          await failJob(job, "transaction_reverted");
          assert(
            (
              await pool.query(
                "SELECT released_at FROM reward_reservations WHERE job_id=$1",
                [winner],
              )
            ).rows[0].released_at,
          );
          await transaction((db) =>
            reserveReward(
              db,
              config.REWARD_PAYMENT_ADDRESS!,
              "1",
              walletId,
              other.id,
            ),
          );
        },
      );
      await t.test(
        "campaign writes are merchant scoped, durable and idempotent without provider success",
        async () => {
          const requestId = randomUUID();
          const body = {
            requestId,
            enabled: true,
            minPurchase: "100",
            discountBps: 5000,
            maxDiscount: "50",
            validitySeconds: 2592000,
          };
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/rewards/campaign",
                headers: { authorization: `Bearer ${token}` },
                payload: body,
              })
            ).statusCode,
            403,
          );
          const first = await app.inject({
            method: "PUT",
            url: "/v1/merchant/rewards/campaign",
            headers,
            payload: body,
          });
          assert.equal(first.statusCode, 200, first.body);
          const second = await app.inject({
            method: "PUT",
            url: "/v1/merchant/rewards/campaign",
            headers,
            payload: body,
          });
          assert.equal(second.json().id, first.json().id);
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/rewards/campaign",
                headers,
                payload: { ...body, discountBps: 4000 },
              })
            ).statusCode,
            409,
          );
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/rewards/campaign",
                headers,
                payload: { ...body, requestId: randomUUID() },
              })
            ).statusCode,
            409,
          );
          const restored = await app.inject({
            method: "GET",
            url: `/v1/merchant/rewards/campaign?operationId=${first.json().id}`,
            headers,
          });
          assert.equal(restored.statusCode, 200);
          assert.equal(restored.json().operation.id, first.json().id);
          assert.equal(restored.json().operation.status, "queued");
          assert.equal(restored.json().status, "unavailable");
          await pool.query("UPDATE merchants SET enabled=false WHERE id=$1", [
            mid,
          ]);
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/rewards/campaign",
                headers,
                payload: { ...body, requestId: randomUUID() },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM reward_campaign_operations",
              )
            ).rows[0].n,
            1,
          );
          await pool.query("UPDATE merchants SET enabled=true WHERE id=$1", [
            mid,
          ]);
        },
      );
      await t.test(
        "switching policy routers or lowering gross cap blocks an unsigned reward job",
        async () => {
          const job = await fixtureJob(
            await requestInvoice(mid, "100", "", randomUUID(), true),
            "2",
          );
          await transaction((db) =>
            reserveReward(
              db,
              config.REWARD_PAYMENT_ADDRESS!,
              "2",
              walletId,
              job.id,
            ),
          );
          await pool.query(
            "UPDATE policies SET router_address=$2 WHERE id=$1",
            [policyId, config.PAYMENT_ADDRESS],
          );
          await assert.rejects(() =>
            transaction((db) => authorizeForSigning(db, job)),
          );
          await pool.query(
            "UPDATE policies SET router_address=$2,per_payment_limit=75 WHERE id=$1",
            [policyId, config.REWARD_PAYMENT_ADDRESS],
          );
          await assert.rejects(() =>
            transaction((db) => authorizeForSigning(db, job)),
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
