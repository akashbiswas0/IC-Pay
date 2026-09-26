ALTER TABLE payment_jobs ADD COLUMN block_number bigint;
UPDATE payment_jobs j SET block_number=r.block_number FROM receipts r WHERE r.invoice_id=j.invoice_id;
-- Earlier approval confirmations lack accepted-block metadata; they must be reconciled before another signature.
UPDATE payment_jobs SET status='reconciling',error_code='receipt_metadata_required' WHERE kind='approval' AND status='confirmed' AND block_number IS NULL;
ALTER TABLE operator_transactions ADD COLUMN block_number bigint, ADD COLUMN block_hash text;
UPDATE operator_transactions SET status='reconciling' WHERE status='confirmed';
