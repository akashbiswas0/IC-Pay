ALTER TABLE cards
 ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 ADD COLUMN nickname text NOT NULL DEFAULT 'Suica' CHECK (char_length(nickname) BETWEEN 1 AND 32),
 ADD COLUMN removed_at timestamptz;

-- Previously inactive cards were replaced, not frozen. Do not resurrect them.
UPDATE cards SET removed_at=linked_at WHERE NOT active;
ALTER TABLE cards ADD CONSTRAINT removed_cards_inactive CHECK (removed_at IS NULL OR NOT active);
DROP INDEX cards_active_account;
CREATE INDEX cards_account_linked ON cards(account_id,linked_at,id) WHERE removed_at IS NULL;

ALTER TABLE world_requests DROP CONSTRAINT world_requests_purpose_check;
ALTER TABLE world_requests ADD CONSTRAINT world_requests_purpose_check
 CHECK (purpose IN ('enrollment','addition','replacement','login'));
ALTER TABLE world_requests
 ADD COLUMN replaces_card_id uuid REFERENCES cards(id),
 ADD COLUMN replaces_card_linked_at timestamptz;
ALTER TABLE world_requests ADD CONSTRAINT world_replacement_target
 CHECK ((replaces_card_id IS NULL AND replaces_card_linked_at IS NULL)
     OR (purpose='replacement' AND replaces_card_id IS NOT NULL AND replaces_card_linked_at IS NOT NULL));
