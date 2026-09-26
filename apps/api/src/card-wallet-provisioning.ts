import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db.js";
import { kmsWallets } from "./wallets.js";
import type { AwsKmsWallets } from "./aws-kms.js";

/** Caller holds the account lock. An existing unassigned wallet requires an explicit choice. */
export async function queueCardWallet(
  db: PoolClient,
  accountId: string,
  cardId: string,
) {
  await db.query(
    `INSERT INTO wallets(account_id,card_id,key_name,status)
     SELECT c.account_id,c.id,$3,'queued' FROM cards c JOIN accounts a ON a.id=c.account_id
     WHERE c.id=$2 AND c.account_id=$1 AND c.removed_at IS NULL AND a.verified AND a.role='customer'
       AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.account_id=$1 AND (w.card_id=c.id OR w.card_id IS NULL))
     ON CONFLICT DO NOTHING`,
    [accountId, cardId, `suica-card-${cardId}-${randomUUID()}`],
  );
}

/** Persist the one-time claim before calling KMS; never retry an ambiguous creation. */
export async function provisionCardWallets(
  provider: () => Promise<Pick<AwsKmsWallets, "createWallet">> = kmsWallets,
  shouldStop: () => boolean = () => false,
) {
  const pending = await pool.query(
    `SELECT w.id,w.account_id FROM wallets w JOIN cards c ON c.id=w.card_id
     WHERE w.status='queued' AND c.removed_at IS NULL ORDER BY w.created_at,w.id LIMIT 20`,
  );
  for (const candidate of pending.rows) {
    if (shouldStop()) break;
    const wallet = await transaction(async (db) => {
      await db.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
        candidate.account_id,
      ]);
      const claimed = await db.query(
        `UPDATE wallets w SET status='provisioning' FROM cards c,accounts a
         WHERE w.id=$1 AND w.status='queued' AND w.provider='aws_kms'
           AND c.id=w.card_id AND c.account_id=w.account_id AND c.removed_at IS NULL
           AND a.id=w.account_id AND a.verified AND a.role='customer'
         RETURNING w.id,w.key_name`,
        [candidate.id],
      );
      return claimed.rows[0];
    });
    if (!wallet) continue;
    try {
      const created = await (await provider()).createWallet(wallet.key_name);
      await pool.query(
        "UPDATE wallets SET address=$2,key_id=$3,status='ready' WHERE id=$1 AND status='provisioning'",
        [wallet.id, created.address.toLowerCase(), created.keyId],
      );
    } catch {
      // Key creation may have succeeded remotely. Recovery must find its existing key by name.
      await pool.query(
        "UPDATE wallets SET status='needs_attention' WHERE id=$1 AND status='provisioning'",
        [wallet.id],
      );
    }
  }
}
