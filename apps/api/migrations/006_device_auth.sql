CREATE TABLE device_links (
 id uuid PRIMARY KEY, code_hash text NOT NULL UNIQUE, secret_hash text NOT NULL UNIQUE,
 account_id uuid REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, approved_at timestamptz, consumed_at timestamptz
);
CREATE INDEX device_links_account ON device_links(account_id);
CREATE INDEX device_links_expiry ON device_links(expires_at);
CREATE TABLE invitations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), code_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_account ON invitations(account_id);
CREATE TABLE auth_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_hash text NOT NULL, kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_rate_window ON auth_attempts(actor_hash,kind,created_at);
ALTER TABLE world_requests DROP CONSTRAINT world_requests_purpose_check;
ALTER TABLE world_requests ADD CONSTRAINT world_requests_purpose_check CHECK(purpose IN ('enrollment','replacement','login'));
ALTER TABLE world_requests ADD COLUMN exchange_hash text UNIQUE, ADD COLUMN exchanged_at timestamptz;
