ALTER TABLE payment_jobs ADD COLUMN expected_chain text, ADD COLUMN expected_token text, ADD COLUMN expected_router text;
-- Existing ambiguous jobs must be reconciled by an operator against their original deployment before resuming.
