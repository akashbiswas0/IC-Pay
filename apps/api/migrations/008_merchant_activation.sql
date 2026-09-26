ALTER TABLE invitations ADD COLUMN activated_terminal_id uuid REFERENCES terminals(id);
CREATE INDEX invitations_activated_terminal ON invitations(activated_terminal_id) WHERE activated_terminal_id IS NOT NULL;
