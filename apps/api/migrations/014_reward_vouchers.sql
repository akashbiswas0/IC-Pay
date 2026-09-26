-- Additive: preserve legacy addresses, allowances, card policies, receipts and pending jobs.
ALTER TABLE invoices ADD COLUMN router_address text, ADD COLUMN router_label text,
 ADD COLUMN gross_amount numeric(78,0), ADD COLUMN discount_amount numeric(78,0) NOT NULL DEFAULT 0,
 ADD COLUMN use_reward boolean NOT NULL DEFAULT false, ADD COLUMN reward_id text,
 ADD COLUMN scan_version smallint NOT NULL DEFAULT 1 CHECK(scan_version IN (1,2));
UPDATE invoices SET gross_amount=amount;
UPDATE invoices i SET router_address=j.expected_router FROM payment_jobs j WHERE j.invoice_id=i.id;
ALTER TABLE payment_jobs ADD COLUMN expected_router_label text, ADD COLUMN gross_amount numeric(78,0),
 ADD COLUMN discount_amount numeric(78,0) NOT NULL DEFAULT 0, ADD COLUMN reward_id text;
UPDATE payment_jobs SET gross_amount=amount WHERE kind='payment';
ALTER TABLE policies ADD COLUMN router_address text, ADD COLUMN router_label text,
 ADD COLUMN use_rewards boolean NOT NULL DEFAULT false;
CREATE TABLE reward_reservations (
 id uuid PRIMARY KEY, chain_id text NOT NULL, router_address text NOT NULL, reward_id text NOT NULL,
 wallet_id uuid NOT NULL REFERENCES wallets(id), job_id uuid NOT NULL UNIQUE REFERENCES payment_jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz, consumed_at timestamptz
);
-- Keep confirmed consumption reserved too; a reorganization must not free it for a second invoice.
CREATE UNIQUE INDEX reward_reservation_once ON reward_reservations(chain_id,router_address,reward_id) WHERE released_at IS NULL;
CREATE INDEX reward_reservations_wallet ON reward_reservations(wallet_id);
CREATE TABLE reward_receipt_events (
 chain_id text NOT NULL, tx_hash text NOT NULL, log_index bigint NOT NULL, router_address text NOT NULL,
 reward_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('earned','redeemed')),
 invoice_id text NOT NULL REFERENCES invoices(id), block_number bigint NOT NULL, block_hash text NOT NULL,
 PRIMARY KEY(chain_id,tx_hash,log_index)
);
CREATE INDEX reward_events_invoice ON reward_receipt_events(invoice_id);
CREATE TABLE reward_campaign_operations (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES merchants(id), account_id uuid NOT NULL REFERENCES accounts(id),
 request_id uuid NOT NULL, router_address text NOT NULL, router_label text NOT NULL,
 chain_id text NOT NULL, token_address text NOT NULL, terms jsonb NOT NULL,
 stage text NOT NULL DEFAULT 'registration' CHECK(stage IN ('registration','campaign','confirmed','failed')),
 register_operation_id uuid NOT NULL UNIQUE, campaign_operation_id uuid NOT NULL UNIQUE,
 register_attempted_at timestamptz, campaign_attempted_at timestamptz,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,request_id)
);
CREATE UNIQUE INDEX one_pending_campaign ON reward_campaign_operations(merchant_id) WHERE stage IN ('registration','campaign');
ALTER TABLE merchant_registrations ADD COLUMN reward_operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN reward_attempted_at timestamptz, ADD COLUMN reward_router_address text, ADD COLUMN reward_router_label text;
CREATE UNIQUE INDEX merchant_reward_operation ON merchant_registrations(reward_operation_id);
