ALTER TABLE payment_jobs ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX payment_jobs_client_request ON payment_jobs(account_id,client_request_id) WHERE client_request_id IS NOT NULL;
ALTER TABLE invoices ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX invoices_client_request ON invoices(merchant_id,client_request_id) WHERE client_request_id IS NOT NULL;
