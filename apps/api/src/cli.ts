import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { pool, transaction } from "./db.js";
import { createAccount, issueSession } from "./auth.js";
import { config } from "./config.js";
import { merchantBytes32 } from "./multibaas.js";
import { kmsWallets } from "./wallets.js";
import { submitOperator, reconcileOperator } from "./operator.js";
import { amountSchema } from "./protocol.js";
import { createInvitation } from "./device-auth.js";
const [command, ...args] = process.argv.slice(2);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
try {
  if (command === "migrate") {
    await transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(830146272)");
      await db.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const folder = fileURLToPath(new URL("../migrations/", import.meta.url));
      for (const name of (await readdir(folder))
        .filter((v) => v.endsWith(".sql"))
        .sort()) {
        if (
          (
            await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [
              name,
            ])
          ).rowCount
        )
          continue;
        await db.query(await readFile(`${folder}/${name}`, "utf8"));
        await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [
          name,
        ]);
        console.log(`Applied ${name}`);
      }
    });
  } else if (command === "bootstrap-admin") {
    console.log(
      JSON.stringify(await transaction((db) => createAccount(db, "admin"))),
    );
  } else if (command === "create-merchant") {
    const [name, recipient] = z
      .tuple([z.string().min(1).max(80), address])
      .parse(args);
    const id = randomUUID();
    const result = await transaction(async (db) => {
      await db.query(
        "INSERT INTO merchants(id,name,recipient) VALUES($1,$2,$3)",
        [id, name, recipient],
      );
      const account = await createAccount(db, "merchant");
      await db.query(
        "INSERT INTO merchant_operators(account_id,merchant_id) VALUES($1,$2)",
        [account.accountId, id],
      );
      return {
        ...account,
        merchantId: id,
        onchainMerchantId: merchantBytes32(id),
      };
    });
    console.log(JSON.stringify(result));
  } else if (command === "create-invitation") {
    console.log(
      JSON.stringify(await createInvitation(z.uuid().parse(args[0]))),
    );
  } else if (command === "issue-session") {
    const id = z.uuid().parse(args[0]);
    const result = await transaction(async (db) => {
      if (
        !(await db.query("SELECT id FROM accounts WHERE id=$1", [id])).rowCount
      )
        throw new Error("Account not found");
      return { accountId: id, token: await issueSession(db, id) };
    });
    console.log(JSON.stringify(result));
  } else if (command === "set-merchant-chain") {
    const id = z.uuid().parse(args[0]);
    const keyId = args[1] ?? config.AWS_KMS_OPERATOR_KEY_ID;
    if (!keyId)
      throw new Error(
        "Set AWS_KMS_OPERATOR_KEY_ID or pass an explicit KMS key ID.",
      );
    const merchant = (
      await pool.query("SELECT * FROM merchants WHERE id=$1", [id])
    ).rows[0];
    if (!merchant) throw new Error("Merchant not found");
    console.log(
      JSON.stringify(
        await submitOperator(
          keyId,
          config.PAYMENT_ADDRESS!,
          config.PAYMENT_CONTRACT,
          "setMerchant",
          [merchantBytes32(id), merchant.recipient, merchant.enabled],
        ),
      ),
    );
  } else if (command === "mint") {
    const recipient = address.parse(args[0]);
    const amount = amountSchema.parse(args[1]);
    const keyId = args[2] ?? config.AWS_KMS_OPERATOR_KEY_ID;
    if (!keyId)
      throw new Error(
        "Set AWS_KMS_OPERATOR_KEY_ID or pass an explicit KMS key ID.",
      );
    console.log(
      JSON.stringify(
        await submitOperator(
          keyId,
          config.TOKEN_ADDRESS!,
          config.TOKEN_CONTRACT,
          "mint",
          [recipient, amount],
        ),
      ),
    );
  } else if (command === "reconcile-operator") {
    console.log(
      JSON.stringify(await reconcileOperator(z.uuid().parse(args[0]))),
    );
  } else if (command === "recover-wallet") {
    const accountId = z.uuid().parse(args[0]);
    const cardId = z.uuid().optional().parse(args[1]);
    const wallet = (
      await pool.query(
        "SELECT * FROM wallets WHERE account_id=$1 AND card_id IS NOT DISTINCT FROM $2::uuid",
        [accountId, cardId ?? null],
      )
    ).rows[0];
    if (!wallet) throw new Error("Wallet request not found");
    if (wallet.provider !== "aws_kms")
      throw new Error(
        "Legacy custody wallet requires explicit migration; recovery will not replace it.",
      );
    const found = await (await kmsWallets()).recoverWallet(wallet.key_name);
    const recovered = address.parse(found.address);
    if (wallet.address && wallet.address !== recovered)
      throw new Error(
        "Recovered key address differs from the existing wallet.",
      );
    await pool.query(
      "UPDATE wallets SET address=$2,key_id=$3,status='ready' WHERE id=$1",
      [wallet.id, recovered, found.keyId],
    );
    console.log(JSON.stringify({ accountId, address: recovered }));
  } else if (command === "attach-transaction") {
    const [id, txHash] = z
      .tuple([z.uuid(), z.string().regex(/^0x[0-9a-fA-F]{64}$/)])
      .parse(args);
    // Operator supplies an independently located existing transaction; worker verifies deployment, sender, nonce, calldata and exact payment or Approval event.
    const result = await pool.query(
      `UPDATE payment_jobs SET tx_hash=$2,status='reconciling',updated_at=now() WHERE id=$1 AND status IN ('submitting','pending','reconciling') RETURNING id`,
      [id, txHash],
    );
    if (!result.rowCount) throw new Error("No eligible job");
    console.log("Transaction attached for receipt verification.");
  } else
    throw new Error(
      "Usage: migrate | bootstrap-admin | create-merchant NAME RECIPIENT | create-invitation ACCOUNT_UUID | issue-session ACCOUNT_UUID | set-merchant-chain MERCHANT_UUID [AWS_KMS_KEY_ID] | mint RECIPIENT AMOUNT_BASE_UNITS [AWS_KMS_KEY_ID] | reconcile-operator OPERATION_UUID | recover-wallet ACCOUNT_UUID [CARD_UUID] | attach-transaction JOB_UUID TX_HASH",
    );
} finally {
  await pool.end();
}
