-- Each verified account gets at most one test claim, including across linked cards.
-- Reserved daily slots include failed and ambiguous operations; they are never recycled.
CREATE TABLE test_funding_claims (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
 card_id uuid NOT NULL,
 card_linked_at timestamptz NOT NULL,
 wallet_id uuid NOT NULL,
 wallet_address text NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),
 chain_id text NOT NULL CHECK(chain_id='11155111'),
 token_address text NOT NULL CHECK(token_address ~ '^0x[0-9a-f]{40}$'),
 token_label text NOT NULL,
 amount numeric(78,0) NOT NULL CHECK(amount>0),
 symbol text NOT NULL,
 operator_key_id text NOT NULL,
 operation_id uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitting','pending','reconciling','confirmed','failed')),
 attempted_at timestamptz,
 tx_hash text,
 error_code text,
 claim_day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(card_id,account_id) REFERENCES cards(id,account_id),
 FOREIGN KEY(wallet_id,account_id) REFERENCES wallets(id,account_id)
);
CREATE INDEX test_funding_claim_day ON test_funding_claims(claim_day);
CREATE INDEX test_funding_due ON test_funding_claims(status,updated_at) WHERE status<>'failed';
