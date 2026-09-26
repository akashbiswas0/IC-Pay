import { config, hasRewards, hasCollectibles, hasLoyalty } from "./config.js";
import { pool, transaction } from "./db.js";
import { paymentRouter, routerSnapshot } from "./payment-router.js";
import { AppError } from "./errors.js";
import { kmsWallets } from "./wallets.js";
import { merchantBytes32, multibaas } from "./multibaas.js";
import { reconcileOperator, submitOperator } from "./operator.js";

// Called under the worker's global advisory lock. Network calls stay outside DB transactions.
export async function provisionMerchants(
  shouldStop: () => boolean = () => false,
) {
  const pending = (
    await pool.query(
      "SELECT * FROM merchant_registrations WHERE stage<>'ready' ORDER BY updated_at LIMIT 3",
    )
  ).rows;
  for (const signup of pending) {
    if (shouldStop()) break;
    try {
      if (signup.stage === "wallet") {
        const keyName = `suica-${signup.account_id}`;
        const claimed = (
          await pool.query(
            "UPDATE merchant_registrations SET wallet_attempted_at=now() WHERE account_id=$1 AND wallet_attempted_at IS NULL RETURNING account_id",
            [signup.account_id],
          )
        ).rowCount;
        const kms = await kmsWallets();
        // After any ambiguous result, recover the tagged key; never create a second one.
        const wallet = claimed
          ? await kms.createWallet(keyName)
          : await kms.recoverWallet(keyName);
        await transaction(async (db) => {
          await db.query(
            "UPDATE wallets SET address=$2,key_id=$3,status='ready' WHERE account_id=$1 AND card_id IS NULL",
            [signup.account_id, wallet.address, wallet.keyId],
          );
          await db.query(
            "INSERT INTO merchants(id,name,recipient,enabled) VALUES($1,$2,$3,false)",
            [signup.reserved_merchant_id, signup.name, wallet.address],
          );
          await db.query(
            "INSERT INTO merchant_operators(account_id,merchant_id) VALUES($1,$2)",
            [signup.account_id, signup.reserved_merchant_id],
          );
          await db.query(
            "UPDATE merchant_registrations SET stage='registration',error_code=NULL,updated_at=now() WHERE account_id=$1",
            [signup.account_id],
          );
        });
      }
      const merchant = (
        await pool.query("SELECT * FROM merchants WHERE id=$1", [
          signup.reserved_merchant_id,
        ])
      ).rows[0];
      if (!merchant) throw new Error("Merchant wallet is not ready");
      const previous = (
        await pool.query("SELECT id FROM operator_transactions WHERE id=$1", [
          signup.reserved_operation_id,
        ])
      ).rows[0];
      const operation = previous
        ? await reconcileOperator(previous.id)
        : await submitOperator(
            config.AWS_KMS_OPERATOR_KEY_ID!,
            config.PAYMENT_ADDRESS!,
            config.PAYMENT_CONTRACT,
            "setMerchant",
            [merchantBytes32(merchant.id), merchant.recipient, true],
            signup.reserved_operation_id,
          );
      if (operation.status === "failed")
        throw new AppError(
          "merchant_registration_failed",
          "Merchant registration failed.",
          409,
        );
      if (operation.status === "confirmed") {
        const result = await multibaas.call(
          config.PAYMENT_ADDRESS!,
          config.PAYMENT_CONTRACT,
          "merchants",
          [merchantBytes32(merchant.id)],
        );
        if (
          !Array.isArray(result.output) ||
          String(result.output[0]).toLowerCase() !== merchant.recipient ||
          result.output[1] !== true
        )
          throw new AppError(
            "merchant_registration_mismatch",
            "Merchant registration does not match.",
            502,
          );
        let routerPending = false;
        // Complete every stored registration even when the default payment router changes.
        // New merchants also require each currently configured reward generation.
        for (const registration of [
          {
            kind: "rewards" as const,
            prefix: "reward",
            configured: hasRewards,
          },
          {
            kind: "loyalty" as const,
            prefix: "loyalty",
            configured: hasLoyalty,
          },
          {
            kind: "collectibles" as const,
            prefix: "collectible",
            configured: hasCollectibles,
          },
        ]) {
          const { kind, prefix, configured } = registration;
          const address = signup[`${prefix}_router_address`];
          const label = signup[`${prefix}_router_label`];
          const operationId = signup[`${prefix}_operation_id`];
          if (!configured && !address) continue;
          const router = address
            ? routerSnapshot(address, label)
            : paymentRouter(kind);
          if (!address)
            await pool.query(
              `UPDATE merchant_registrations SET ${prefix}_router_address=$2,${prefix}_router_label=$3 WHERE account_id=$1 AND ${prefix}_router_address IS NULL`,
              [signup.account_id, router.address, router.label],
            );
          const old = (
            await pool.query(
              "SELECT id FROM operator_transactions WHERE id=$1",
              [operationId],
            )
          ).rows[0];
          if (!old && signup[`${prefix}_attempted_at`])
            throw new AppError(
              "merchant_registration_unknown",
              "Reward-router registration needs reconciliation before retry.",
              409,
            );
          let rewardOperation;
          if (old) rewardOperation = await reconcileOperator(old.id);
          else {
            rewardOperation = await submitOperator(
              config.AWS_KMS_OPERATOR_KEY_ID!,
              router.address,
              router.label,
              "setMerchant",
              [merchantBytes32(merchant.id), merchant.recipient, true],
              operationId,
              async () => {
                const marked = await pool.query(
                  `UPDATE merchant_registrations SET ${prefix}_attempted_at=now() WHERE account_id=$1 AND ${prefix}_attempted_at IS NULL RETURNING account_id`,
                  [signup.account_id],
                );
                if (!marked.rowCount)
                  throw new AppError(
                    "merchant_registration_unknown",
                    "Registration was already attempted; reconcile its existing operation.",
                    409,
                  );
              },
            );
          }
          if (rewardOperation.status === "failed")
            throw new AppError(
              "merchant_registration_failed",
              "Reward-router registration reverted.",
              409,
            );
          if (rewardOperation.status !== "confirmed") {
            routerPending = true;
            break;
          }
          const state = await multibaas.call(
            router.address,
            router.label,
            "merchants",
            [merchantBytes32(merchant.id)],
          );
          if (
            !Array.isArray(state.output) ||
            String(state.output[0]).toLowerCase() !== merchant.recipient ||
            state.output[1] !== true
          )
            throw new AppError(
              "merchant_registration_mismatch",
              "Reward-router merchant does not match.",
              502,
            );
        }
        if (routerPending) {
          await pool.query(
            "UPDATE merchant_registrations SET error_code=NULL,updated_at=now() WHERE account_id=$1",
            [signup.account_id],
          );
          continue;
        }
        await transaction(async (db) => {
          await db.query("UPDATE merchants SET enabled=true WHERE id=$1", [
            merchant.id,
          ]);
          await db.query(
            "UPDATE merchant_registrations SET stage='ready',error_code=NULL,updated_at=now() WHERE account_id=$1",
            [signup.account_id],
          );
          await db.query(
            "INSERT INTO audit_events(account_id,event,reference) VALUES($1,'merchant_signup_ready',$2)",
            [signup.account_id, merchant.id],
          );
        });
      } else {
        await pool.query(
          "UPDATE merchant_registrations SET error_code=NULL,updated_at=now() WHERE account_id=$1",
          [signup.account_id],
        );
      }
    } catch (error) {
      await pool.query(
        "UPDATE merchant_registrations SET error_code=$2,updated_at=now() WHERE account_id=$1",
        [
          signup.account_id,
          error instanceof AppError ? error.code : "merchant_setup_pending",
        ],
      );
    }
  }
}
