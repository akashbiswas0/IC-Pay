ALTER TABLE world_requests DROP CONSTRAINT world_requests_purpose_check;
ALTER TABLE world_requests ADD CONSTRAINT world_requests_purpose_check
 CHECK (purpose IN ('enrollment','addition','replacement','login','recovery'));
