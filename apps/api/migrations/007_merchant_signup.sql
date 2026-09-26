CREATE TABLE merchant_registrations (
 account_id uuid PRIMARY KEY REFERENCES accounts(id),
 reserved_merchant_id uuid NOT NULL UNIQUE,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
 signup_hash text NOT NULL UNIQUE,
 actor_hash text NOT NULL,
 stage text NOT NULL DEFAULT 'wallet' CHECK (stage IN ('wallet','registration','ready')),
 wallet_attempted_at timestamptz,
 reserved_operation_id uuid NOT NULL UNIQUE,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchant_registrations_actor ON merchant_registrations(actor_hash,created_at);
CREATE INDEX merchant_registrations_pending ON merchant_registrations(updated_at) WHERE stage <> 'ready';
