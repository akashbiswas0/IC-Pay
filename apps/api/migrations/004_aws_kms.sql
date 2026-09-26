ALTER TABLE wallets ADD COLUMN provider text NOT NULL DEFAULT 'legacy_azure' CHECK(provider IN ('legacy_azure','aws_kms'));
ALTER TABLE wallets ALTER COLUMN provider SET DEFAULT 'aws_kms';
ALTER TABLE wallets ADD COLUMN key_id text;
CREATE UNIQUE INDEX wallets_key_id ON wallets(key_id) WHERE key_id IS NOT NULL;
ALTER TABLE payment_jobs ADD COLUMN signed_tx text, ADD COLUMN broadcast_attempted_at timestamptz;
CREATE TABLE operator_transactions (
 id uuid PRIMARY KEY, key_id text NOT NULL, address text NOT NULL, chain_id text NOT NULL,
 tx_hash text NOT NULL UNIQUE, nonce bigint NOT NULL, signed_tx text NOT NULL,
 status text NOT NULL CHECK(status IN ('signed','pending','reconciling','confirmed','failed')),
 broadcast_attempted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_transactions_address ON operator_transactions(address,status);
