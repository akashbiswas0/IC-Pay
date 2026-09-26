import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
const database = process.env.TEST_DATABASE_URL;
test(
  "retained credit collectibles preserve prior routers, permit only valid zero-net rows and serialize partial redemption",
  { skip: !database },
  async (t) => {
    const url = new URL(database!);
    assert(url.pathname.endsWith("_test"));
    const schema = "credit_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(),
      CHAIN_ID: "11155111",
      TOKEN_ADDRESS: "0x" + "11".repeat(20),
      PAYMENT_ADDRESS: "0x" + "22".repeat(20),
      REWARD_PAYMENT_ADDRESS: "0x" + "33".repeat(20),
      COLLECTIBLE_PAYMENT_ADDRESS: "0x" + "44".repeat(20),
      MULTIBAAS_URL: "https://127.0.0.1:1",
      MULTIBAAS_API_KEY: "not-invoked",
      AWS_KMS_OPERATOR_KEY_ID: "not-invoked",
    });
    const { pool, transaction } = await import("../src/db.js");
    const { config } = await import("../src/config.js");
    const { buildServer } = await import("../src/server.js");
    const { publicPolicy } = await import("../src/card-wallets.js");
    const { requestAllowance, requestInvoice } =
      await import("../src/payment-requests.js");
    const { routerSnapshot, paymentRouter } =
      await import("../src/payment-router.js");
    const { reserveReward, consumeRewardReservation, reservedRewardIds } =
      await import("../src/rewards.js");
    const { hash, randomToken } = await import("../src/protocol.js");
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
        operator = randomUUID(),
        card = randomUUID(),
        wallet = randomUUID(),
        merchant = randomUUID(),
        policy = randomUUID(),
        merchantToken = randomToken(),
        recipient = "0x" + "66".repeat(20);
      await pool.query(
        "INSERT INTO accounts(id,verified,role)VALUES($1,true,'customer'),($2,false,'merchant')",
        [account, operator],
      );
      await pool.query(
        "INSERT INTO merchants(id,name,recipient)VALUES($1,'Credit merchant',$2)",
        [merchant, recipient],
      );
      await pool.query(
        "INSERT INTO merchant_operators(account_id,merchant_id)VALUES($1,$2)",
        [operator, merchant],
      );
      await pool.query(
        "INSERT INTO sessions(token_hash,account_id,expires_at)VALUES($1,$2,now()+interval '1 hour')",
        [hash(merchantToken), operator],
      );
      await pool.query(
        "INSERT INTO cards(id,card_hash,account_id,last4)VALUES($1,$2,$3,'0101')",
        [card, randomUUID(), account],
      );
      await pool.query(
        "INSERT INTO wallets(id,account_id,card_id,address,key_name,key_id,provider,status)VALUES($1,$2,$3,$4,$5,'test-key','aws_kms','ready')",
        [wallet, account, card, "0x" + "77".repeat(20), randomUUID()],
      );
      await pool.query(
        "INSERT INTO policies(id,account_id,card_id,enabled,per_payment_limit,total_limit,spent,reserved,expires_at,router_address,use_rewards,merchant_scope)VALUES($1,$2,$3,true,100,1000,100,50,now()+interval '1 hour',$4,true,'all')",
        [policy, account, card, config.REWARD_PAYMENT_ADDRESS],
      );
      await t.test(
        "fresh router needs explicit approval while historical snapshots and spent budget stay intact",
        async () => {
          assert.equal(paymentRouter().kind, "collectibles");
          assert.equal(
            routerSnapshot(config.REWARD_PAYMENT_ADDRESS).kind,
            "rewards",
          );
          assert.equal(routerSnapshot(config.PAYMENT_ADDRESS).kind, "legacy");
          const saved = (
            await pool.query("SELECT * FROM policies WHERE id=$1", [policy])
          ).rows[0];
          assert.equal(publicPolicy(saved).requiresApproval, true);
          assert.equal(publicPolicy(saved).spent, "100");
          assert.equal(publicPolicy(saved).reserved, "50");
          assert.equal(saved.router_address, config.REWARD_PAYMENT_ADDRESS);
          const oldId = randomUUID();
          const old = await requestAllowance(
            account,
            "500",
            oldId,
            card,
            "rewards",
          );
          assert.equal(
            (await requestAllowance(account, "500", oldId, card)).id,
            old.id,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT expected_router FROM payment_jobs WHERE id=$1",
                [old.id],
              )
            ).rows[0].expected_router,
            config.REWARD_PAYMENT_ADDRESS,
          );
          await assert.rejects(
            requestAllowance(account, "500", oldId, card, "collectibles"),
            /different terms/,
          );
          await pool.query(
            "UPDATE payment_jobs SET status='confirmed' WHERE id=$1",
            [old.id],
          );
          const next = await requestAllowance(
            account,
            "500",
            randomUUID(),
            card,
            "collectibles",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT expected_router FROM payment_jobs WHERE id=$1",
                [next.id],
              )
            ).rows[0].expected_router,
            config.COLLECTIBLE_PAYMENT_ADDRESS,
          );
        },
      );
      const invoice = await requestInvoice(
        merchant,
        "50",
        "Credit-covered purchase",
        randomUUID(),
        true,
      );
      async function job(
        model = "credit",
        router = config.COLLECTIBLE_PAYMENT_ADDRESS!,
        amount = "0",
        id = randomUUID(),
      ) {
        await pool.query(
          "INSERT INTO payment_jobs(id,account_id,wallet_id,card_id,policy_id,kind,amount,gross_amount,discount_amount,reward_id,reward_model,reward_credit_before,expected_router,expected_chain,expected_token)VALUES($1,$2,$3,$4,$5,'payment',$6,50,50,'1',$7,70,$8,$9,$10)",
          [
            id,
            account,
            wallet,
            card,
            policy,
            amount,
            model,
            router,
            config.CHAIN_ID,
            config.TOKEN_ADDRESS,
          ],
        );
        return { id, kind: "payment", reward_id: "1", expected_router: router };
      }
      await t.test(
        "new invoices bind credit router and positive gross; zero charge requires full credit coverage",
        async () => {
          assert.equal(
            invoice.router_address,
            config.COLLECTIBLE_PAYMENT_ADDRESS,
          );
          assert.equal(invoice.reward_model, "credit");
          assert.equal(invoice.scan_version, 2);
          assert.equal(invoice.amount, "50");
          await pool.query(
            "UPDATE invoices SET amount=0,discount_amount=50,reward_id='1' WHERE id=$1",
            [invoice.id],
          );
          await assert.rejects(
            pool.query("UPDATE invoices SET discount_amount=49 WHERE id=$1", [
              invoice.id,
            ]),
            (error) => (error as any).code === "23514",
          );
          await assert.rejects(
            pool.query(
              "UPDATE invoices SET reward_model='percentage' WHERE id=$1",
              [invoice.id],
            ),
            (error) => (error as any).code === "23514",
          );
          await assert.rejects(
            job("percentage", config.REWARD_PAYMENT_ADDRESS),
            (error) => (error as any).code === "23514",
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO payment_jobs(id,account_id,kind,amount,reward_model,gross_amount,discount_amount,reward_id)VALUES($1,$2,'approval',0,'credit',50,50,'1')",
              [randomUUID(), account],
            ),
            (error) => (error as any).code === "23514",
          );
          const hash = "0x" + randomBytes(32).toString("hex");
          await pool.query(
            "INSERT INTO receipts(invoice_id,tx_hash,log_index,block_number,block_hash,payer,recipient,amount,reward_model,gross_amount,discount_amount,reward_id)VALUES($1,$2,0,1,$2,$3,$4,0,'credit',50,50,'1')",
            [invoice.id, hash, "0x" + "77".repeat(20), recipient],
          );
          await assert.rejects(
            pool.query(
              "UPDATE receipts SET reward_model='percentage' WHERE invoice_id=$1",
              [invoice.id],
            ),
            (error) => (error as any).code === "23514",
          );
        },
      );
      await t.test(
        "partial redemption releases only after confirmation and unresolved reorg restores exclusion",
        async () => {
          const first = await job(),
            second = await job();
          await transaction((db) =>
            reserveReward(
              db,
              config.COLLECTIBLE_PAYMENT_ADDRESS!,
              "1",
              wallet,
              first.id,
            ),
          );
          await assert.rejects(
            transaction((db) =>
              reserveReward(
                db,
                config.COLLECTIBLE_PAYMENT_ADDRESS!,
                "1",
                wallet,
                second.id,
              ),
            ),
            /already committed/,
          );
          assert(
            (
              await reservedRewardIds(
                wallet,
                config.COLLECTIBLE_PAYMENT_ADDRESS!,
              )
            ).has("1"),
          );
          await transaction(async (db) => {
            await consumeRewardReservation(db, first);
            await db.query(
              "UPDATE payment_jobs SET status='confirmed' WHERE id=$1",
              [first.id],
            );
          });
          assert.equal(
            (
              await reservedRewardIds(
                wallet,
                config.COLLECTIBLE_PAYMENT_ADDRESS!,
              )
            ).has("1"),
            false,
          );
          await pool.query(
            "UPDATE payment_jobs SET status='reconciling' WHERE id=$1",
            [first.id],
          );
          assert(
            (
              await reservedRewardIds(
                wallet,
                config.COLLECTIBLE_PAYMENT_ADDRESS!,
              )
            ).has("1"),
          );
          await pool.query(
            "UPDATE payment_jobs SET status='confirmed' WHERE id=$1",
            [first.id],
          );
          await transaction((db) =>
            reserveReward(
              db,
              config.COLLECTIBLE_PAYMENT_ADDRESS!,
              "1",
              wallet,
              second.id,
            ),
          );
          assert(
            (
              await reservedRewardIds(
                wallet,
                config.COLLECTIBLE_PAYMENT_ADDRESS!,
              )
            ).has("1"),
          );
          const old = await job(
            "percentage",
            config.REWARD_PAYMENT_ADDRESS,
            "25",
          );
          await transaction((db) =>
            reserveReward(
              db,
              config.REWARD_PAYMENT_ADDRESS!,
              "1",
              wallet,
              old.id,
            ),
          );
          await transaction(async (db) => {
            await consumeRewardReservation(db, old);
            await db.query(
              "UPDATE payment_jobs SET status='confirmed' WHERE id=$1",
              [old.id],
            );
          });
          assert(
            (
              await reservedRewardIds(wallet, config.REWARD_PAYMENT_ADDRESS!)
            ).has("1"),
          );
        },
      );
      await t.test(
        "credit campaigns and percentage campaigns keep separate rates, operations and pending uniqueness",
        async () => {
          const headers = { authorization: `Bearer ${merchantToken}` },
            requestId = randomUUID();
          const terms = {
            enabled: true,
            minPurchase: "1",
            earnBps: 500,
            maxCredit: "50",
            validitySeconds: 2592000,
            requestId,
          };
          const credit = await app.inject({
            method: "PUT",
            url: "/v1/merchant/collectibles/campaign",
            headers,
            payload: terms,
          });
          assert.equal(credit.statusCode, 200, credit.body);
          const retry = await app.inject({
            method: "PUT",
            url: "/v1/merchant/collectibles/campaign",
            headers,
            payload: terms,
          });
          assert.equal(retry.json().id, credit.json().id);
          const legacy = {
            enabled: true,
            minPurchase: "1",
            discountBps: 5000,
            maxDiscount: "50",
            validitySeconds: 2592000,
            requestId,
          };
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/rewards/campaign",
                headers,
                payload: legacy,
              })
            ).statusCode,
            409,
          );
          const old = await app.inject({
            method: "PUT",
            url: "/v1/merchant/rewards/campaign",
            headers,
            payload: { ...legacy, requestId: randomUUID() },
          });
          assert.equal(old.statusCode, 200, old.body);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM reward_campaign_operations WHERE merchant_id=$1",
                [merchant],
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/collectibles/campaign",
                headers,
                payload: { ...legacy, requestId: randomUUID() },
              })
            ).statusCode,
            400,
          );
          await pool.query("UPDATE merchants SET enabled=false WHERE id=$1", [
            merchant,
          ]);
          assert.equal(
            (
              await app.inject({
                method: "PUT",
                url: "/v1/merchant/collectibles/campaign",
                headers,
                payload: { ...terms, requestId: randomUUID() },
              })
            ).statusCode,
            403,
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
