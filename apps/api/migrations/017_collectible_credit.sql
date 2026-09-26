-- Router and reward models remain snapshotted; old percentage vouchers stay single-use.
ALTER TABLE invoices ADD COLUMN reward_model text NOT NULL DEFAULT 'percentage' CHECK(reward_model IN ('percentage','credit'));
ALTER TABLE payment_jobs ADD COLUMN reward_model text NOT NULL DEFAULT 'percentage' CHECK(reward_model IN ('percentage','credit')), ADD COLUMN reward_credit_before numeric(78,0);
ALTER TABLE invoices DROP CONSTRAINT invoices_amount_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_amount_check CHECK(amount>0 OR (amount=0 AND reward_model='credit' AND use_reward AND reward_id IS NOT NULL AND gross_amount>0 AND discount_amount=gross_amount));
ALTER TABLE payment_jobs DROP CONSTRAINT payment_jobs_amount_check;
ALTER TABLE payment_jobs ADD CONSTRAINT payment_jobs_amount_check CHECK(amount>0 OR (amount=0 AND kind='payment' AND reward_model='credit' AND reward_id IS NOT NULL AND gross_amount>0 AND discount_amount=gross_amount));
ALTER TABLE receipts ADD COLUMN reward_model text NOT NULL DEFAULT 'percentage' CHECK(reward_model IN ('percentage','credit')), ADD COLUMN gross_amount numeric(78,0), ADD COLUMN discount_amount numeric(78,0) NOT NULL DEFAULT 0, ADD COLUMN reward_id text;
ALTER TABLE receipts ADD CONSTRAINT receipts_amount_model CHECK(amount>0 OR (amount=0 AND reward_model='credit' AND reward_id IS NOT NULL AND gross_amount>0 AND discount_amount=gross_amount));
ALTER TABLE merchant_registrations ADD COLUMN collectible_operation_id uuid NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN collectible_attempted_at timestamptz, ADD COLUMN collectible_router_address text, ADD COLUMN collectible_router_label text;
CREATE UNIQUE INDEX merchant_collectible_operation ON merchant_registrations(collectible_operation_id);
DROP INDEX one_pending_campaign;
CREATE UNIQUE INDEX one_pending_campaign ON reward_campaign_operations(merchant_id,router_address) WHERE stage IN ('registration','campaign');
