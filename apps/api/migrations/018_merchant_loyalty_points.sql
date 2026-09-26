-- Explicit new router; prior reward models, allowances and policies retain their meaning.
ALTER TABLE policies ADD COLUMN max_points_per_payment numeric(78,0) CHECK(max_points_per_payment>=0);
ALTER TABLE invoices ADD COLUMN max_points numeric(78,0) CHECK(max_points>=0), ADD COLUMN points_redeemed numeric(78,0) NOT NULL DEFAULT 0 CHECK(points_redeemed>=0);
ALTER TABLE payment_jobs ADD COLUMN max_points numeric(78,0) CHECK(max_points>=0), ADD COLUMN points_redeemed numeric(78,0) NOT NULL DEFAULT 0 CHECK(points_redeemed>=0);
ALTER TABLE receipts ADD COLUMN points_redeemed numeric(78,0) NOT NULL DEFAULT 0 CHECK(points_redeemed>=0);
ALTER TABLE invoices DROP CONSTRAINT invoices_scan_version_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_scan_version_check CHECK(scan_version IN (1,2,3));
ALTER TABLE invoices DROP CONSTRAINT invoices_reward_model_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_reward_model_check CHECK(reward_model IN ('percentage','credit','points'));
ALTER TABLE payment_jobs DROP CONSTRAINT payment_jobs_reward_model_check;
ALTER TABLE payment_jobs ADD CONSTRAINT payment_jobs_reward_model_check CHECK(reward_model IN ('percentage','credit','points'));
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_reward_model_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_reward_model_check CHECK(reward_model IN ('percentage','credit','points'));
ALTER TABLE invoices DROP CONSTRAINT invoices_amount_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_amount_check CHECK(amount>0 OR (amount=0 AND use_reward AND gross_amount>0 AND discount_amount=gross_amount AND ((reward_model='credit' AND reward_id IS NOT NULL) OR (reward_model='points' AND points_redeemed>0))));
ALTER TABLE payment_jobs DROP CONSTRAINT payment_jobs_amount_check;
ALTER TABLE payment_jobs ADD CONSTRAINT payment_jobs_amount_check CHECK(amount>0 OR (amount=0 AND kind='payment' AND gross_amount>0 AND discount_amount=gross_amount AND ((reward_model='credit' AND reward_id IS NOT NULL) OR (reward_model='points' AND points_redeemed>0))));
ALTER TABLE receipts DROP CONSTRAINT receipts_amount_model;
ALTER TABLE receipts ADD CONSTRAINT receipts_amount_model CHECK(amount>0 OR (amount=0 AND gross_amount>0 AND discount_amount=gross_amount AND ((reward_model='credit' AND reward_id IS NOT NULL) OR (reward_model='points' AND points_redeemed>0))));
CREATE TABLE loyalty_reservations (
 id uuid PRIMARY KEY,chain_id text NOT NULL,router_address text NOT NULL,
 wallet_id uuid NOT NULL REFERENCES wallets(id),merchant_id uuid NOT NULL REFERENCES merchants(id),
 job_id uuid NOT NULL UNIQUE REFERENCES payment_jobs(id),points numeric(78,0) NOT NULL CHECK(points>0),
 created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz,released_at timestamptz
);
CREATE INDEX loyalty_reservations_ledger ON loyalty_reservations(chain_id,router_address,wallet_id,merchant_id);
CREATE TABLE loyalty_receipt_events (
 chain_id text NOT NULL,router_address text NOT NULL,tx_hash text NOT NULL,log_index bigint NOT NULL,
 invoice_id text REFERENCES invoices(id),wallet_id uuid REFERENCES wallets(id),merchant_id uuid NOT NULL REFERENCES merchants(id),
 kind text NOT NULL,block_number bigint NOT NULL,block_hash text NOT NULL,
 PRIMARY KEY(chain_id,tx_hash,log_index)
);
CREATE INDEX loyalty_events_wallet ON loyalty_receipt_events(wallet_id,merchant_id);
CREATE TABLE loyalty_refunds (
 id uuid PRIMARY KEY,invoice_id text NOT NULL REFERENCES invoices(id),merchant_id uuid NOT NULL REFERENCES merchants(id),
 account_id uuid NOT NULL REFERENCES accounts(id),request_id uuid NOT NULL,
 payer text NOT NULL,recipient text NOT NULL,amount numeric(78,0) NOT NULL CHECK(amount>=0),
 chain_id text NOT NULL,token_address text NOT NULL,router_address text NOT NULL,router_label text NOT NULL,key_id text NOT NULL,
 approval_operation_id uuid NOT NULL UNIQUE,refund_operation_id uuid NOT NULL UNIQUE,
 approval_attempted_at timestamptz,refund_attempted_at timestamptz,
 stage text NOT NULL DEFAULT 'approval' CHECK(stage IN ('approval','refund','confirmed','failed')),
 tx_hash text,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,request_id)
);
CREATE UNIQUE INDEX one_active_loyalty_refund ON loyalty_refunds(invoice_id) WHERE stage<>'failed';
CREATE INDEX loyalty_refunds_invoice ON loyalty_refunds(invoice_id,created_at DESC);
CREATE INDEX loyalty_refunds_due ON loyalty_refunds(stage,updated_at);
ALTER TABLE merchant_registrations ADD COLUMN loyalty_operation_id uuid NOT NULL DEFAULT gen_random_uuid(), ADD COLUMN loyalty_attempted_at timestamptz, ADD COLUMN loyalty_router_address text, ADD COLUMN loyalty_router_label text;
CREATE UNIQUE INDEX merchant_loyalty_operation ON merchant_registrations(loyalty_operation_id);
-- Preserve only currently enabled prior router consent; never migrate approval to a new spender.
CREATE TABLE policy_router_consents (
 policy_id uuid NOT NULL REFERENCES policies(id),router_address text NOT NULL,router_label text,
 consented_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(policy_id,router_address)
);
INSERT INTO policy_router_consents(policy_id,router_address,router_label,consented_at)
 SELECT id,router_address,router_label,consent_at FROM policies WHERE enabled AND router_address IS NOT NULL;
