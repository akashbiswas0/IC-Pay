-- Keep legacy wallet/key references intact until their owner explicitly assigns them.
ALTER TABLE cards ADD CONSTRAINT cards_id_account_unique UNIQUE(id,account_id);
ALTER TABLE wallets ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN card_id uuid;
ALTER TABLE wallets DROP CONSTRAINT wallets_pkey;
ALTER TABLE wallets ADD PRIMARY KEY(id), ADD CONSTRAINT wallets_id_account_unique UNIQUE(id,account_id),
 ADD CONSTRAINT wallets_card_owner FOREIGN KEY(card_id,account_id) REFERENCES cards(id,account_id);
CREATE UNIQUE INDEX wallets_one_card ON wallets(card_id) WHERE card_id IS NOT NULL;
CREATE UNIQUE INDEX wallets_unassigned_account ON wallets(account_id) WHERE card_id IS NULL;
CREATE INDEX wallets_account ON wallets(account_id);

ALTER TABLE policies ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN card_id uuid;
ALTER TABLE policy_merchants DROP CONSTRAINT policy_merchants_account_id_fkey;
ALTER TABLE policies DROP CONSTRAINT policies_pkey;
ALTER TABLE policies ADD PRIMARY KEY(id), ADD CONSTRAINT policies_id_account_unique UNIQUE(id,account_id),
 ADD CONSTRAINT policies_card_owner FOREIGN KEY(card_id,account_id) REFERENCES cards(id,account_id);
CREATE UNIQUE INDEX policies_one_card ON policies(card_id) WHERE card_id IS NOT NULL;
CREATE UNIQUE INDEX policies_unassigned_account ON policies(account_id) WHERE card_id IS NULL;
CREATE INDEX policies_account ON policies(account_id);
ALTER TABLE policy_merchants ADD COLUMN policy_id uuid;
UPDATE policy_merchants m SET policy_id=p.id FROM policies p WHERE p.account_id=m.account_id;
ALTER TABLE policy_merchants ALTER COLUMN policy_id SET NOT NULL;
ALTER TABLE policy_merchants DROP CONSTRAINT policy_merchants_pkey;
ALTER TABLE policy_merchants ADD PRIMARY KEY(policy_id,merchant_id),
 ADD CONSTRAINT policy_merchants_policy_owner FOREIGN KEY(policy_id,account_id) REFERENCES policies(id,account_id);

ALTER TABLE payment_jobs ADD COLUMN wallet_id uuid, ADD COLUMN policy_id uuid, ADD COLUMN card_id uuid;
UPDATE payment_jobs j SET wallet_id=w.id FROM wallets w WHERE w.account_id=j.account_id;
UPDATE payment_jobs j SET policy_id=p.id FROM policies p WHERE p.account_id=j.account_id AND j.kind='payment';
UPDATE payment_jobs j SET card_id=c.id FROM cards c WHERE c.card_hash=j.card_hash AND c.account_id=j.account_id;
ALTER TABLE payment_jobs
 ADD CONSTRAINT jobs_wallet_owner FOREIGN KEY(wallet_id,account_id) REFERENCES wallets(id,account_id),
 ADD CONSTRAINT jobs_policy_owner FOREIGN KEY(policy_id,account_id) REFERENCES policies(id,account_id),
 ADD CONSTRAINT jobs_card_owner FOREIGN KEY(card_id,account_id) REFERENCES cards(id,account_id);
CREATE INDEX jobs_wallet ON payment_jobs(wallet_id);
CREATE INDEX jobs_policy ON payment_jobs(policy_id);
DROP INDEX one_active_approval;
CREATE UNIQUE INDEX one_active_wallet_approval ON payment_jobs(wallet_id) WHERE kind='approval' AND status IN ('queued','submitting','pending','reconciling') AND wallet_id IS NOT NULL;
CREATE UNIQUE INDEX one_active_legacy_approval ON payment_jobs(account_id) WHERE kind='approval' AND status IN ('queued','submitting','pending','reconciling') AND wallet_id IS NULL;
-- Previously shared permission is not silently copied to any new card.
UPDATE policies p SET enabled=false FROM accounts a WHERE a.id=p.account_id AND a.role='customer';
