CREATE TABLE accounts (
 id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','merchant','admin')),
 world_session text UNIQUE, verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE merchants (
 id uuid PRIMARY KEY, name text NOT NULL, recipient text NOT NULL CHECK(recipient ~ '^0x[0-9a-f]{40}$'), enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE merchant_operators (
 account_id uuid PRIMARY KEY REFERENCES accounts(id), merchant_id uuid NOT NULL REFERENCES merchants(id)
);
CREATE INDEX operators_merchant ON merchant_operators(merchant_id);
CREATE TABLE terminals (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES merchants(id), public_key text NOT NULL, name text NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminals_merchant ON terminals(merchant_id);
CREATE TABLE world_requests (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), purpose text NOT NULL CHECK(purpose IN ('enrollment','replacement')),
 nonce text NOT NULL UNIQUE, card_hash text NOT NULL, card_last4 text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX world_requests_account ON world_requests(account_id);
CREATE TABLE world_proofs (nullifier text PRIMARY KEY, request_id uuid NOT NULL REFERENCES world_requests(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX world_proofs_request ON world_proofs(request_id);
CREATE TABLE cards (
 card_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), last4 text NOT NULL, active boolean NOT NULL DEFAULT true,
 linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cards_active_account ON cards(account_id) WHERE active;
CREATE TABLE wallets (
 account_id uuid PRIMARY KEY REFERENCES accounts(id), address text UNIQUE, key_name text NOT NULL UNIQUE,
 key_version text, status text NOT NULL CHECK(status IN ('provisioning','ready','needs_attention')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE policies (
 account_id uuid PRIMARY KEY REFERENCES accounts(id), enabled boolean NOT NULL, per_payment_limit numeric(78,0) NOT NULL CHECK(per_payment_limit > 0),
 total_limit numeric(78,0) NOT NULL CHECK(total_limit >= per_payment_limit), spent numeric(78,0) NOT NULL DEFAULT 0 CHECK(spent >= 0),
 reserved numeric(78,0) NOT NULL DEFAULT 0 CHECK(reserved >= 0), expires_at timestamptz NOT NULL, consent_at timestamptz NOT NULL DEFAULT now(),
 CHECK(spent + reserved <= total_limit)
);
CREATE TABLE policy_merchants (
 account_id uuid NOT NULL REFERENCES policies(account_id), merchant_id uuid NOT NULL REFERENCES merchants(id), PRIMARY KEY(account_id,merchant_id)
);
CREATE INDEX policy_merchants_merchant ON policy_merchants(merchant_id);
CREATE TABLE invoices (
 id text PRIMARY KEY CHECK(id ~ '^0x[0-9a-f]{64}$'), merchant_id uuid NOT NULL REFERENCES merchants(id), recipient text NOT NULL,
 amount numeric(78,0) NOT NULL CHECK(amount > 0), token text NOT NULL, chain_id text NOT NULL, description text NOT NULL DEFAULT '',
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'awaiting_tap' CHECK(status IN ('awaiting_tap','authorised','submitting','pending','reconciling','confirmed','failed','expired','cancelled')),
 account_id uuid REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_merchant_created ON invoices(merchant_id,created_at DESC);
CREATE INDEX invoices_account_created ON invoices(account_id,created_at DESC);
CREATE TABLE challenges (
 challenge_hash text PRIMARY KEY, invoice_id text NOT NULL REFERENCES invoices(id), terminal_id uuid NOT NULL REFERENCES terminals(id),
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX challenges_invoice ON challenges(invoice_id);
CREATE INDEX challenges_terminal ON challenges(terminal_id);
CREATE TABLE payment_jobs (
 id uuid PRIMARY KEY, invoice_id text UNIQUE REFERENCES invoices(id), account_id uuid NOT NULL REFERENCES accounts(id),
 kind text NOT NULL CHECK(kind IN ('payment','approval')), amount numeric(78,0) NOT NULL CHECK(amount > 0),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitting','pending','reconciling','confirmed','failed')),
 tx_hash text UNIQUE, nonce bigint, block_hash text, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status ON payment_jobs(status,created_at);
CREATE INDEX jobs_account ON payment_jobs(account_id);
CREATE UNIQUE INDEX one_active_approval ON payment_jobs(account_id) WHERE kind='approval' AND status IN ('queued','submitting','pending','reconciling');
CREATE TABLE receipts (
 invoice_id text PRIMARY KEY REFERENCES invoices(id), tx_hash text NOT NULL, log_index bigint NOT NULL, block_number bigint NOT NULL,
 block_hash text NOT NULL, payer text NOT NULL, recipient text NOT NULL, amount numeric(78,0) NOT NULL, UNIQUE(tx_hash,log_index)
);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, account_id uuid REFERENCES accounts(id), event text NOT NULL, reference text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_account ON audit_events(account_id,created_at DESC);
ALTER TABLE world_requests ADD COLUMN rp_context jsonb NOT NULL, ADD COLUMN handoff_hash text NOT NULL UNIQUE;
CREATE TABLE webhook_deliveries (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE payment_jobs ADD COLUMN terminal_id uuid REFERENCES terminals(id), ADD COLUMN card_hash text REFERENCES cards(card_hash);
CREATE INDEX jobs_terminal ON payment_jobs(terminal_id);
CREATE INDEX jobs_card ON payment_jobs(card_hash);
