-- Queue wallet creation in the same transaction as a verified card link.
-- Queued means no KMS creation has been attempted; provisioning may be ambiguous.
ALTER TABLE wallets DROP CONSTRAINT wallets_status_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_status_check
 CHECK(status IN ('queued','provisioning','ready','needs_attention'));
CREATE INDEX wallets_queued ON wallets(created_at,id) WHERE status='queued';
