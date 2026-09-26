-- Existing permissions remain limited to explicitly selected merchants.
ALTER TABLE policies ADD COLUMN merchant_scope text NOT NULL DEFAULT 'selected'
 CHECK(merchant_scope IN ('selected','all'));
