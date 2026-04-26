-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
ALTER TYPE notification_type_enum ADD VALUE IF NOT EXISTS 'saved_search_alert';

CREATE TABLE IF NOT EXISTS saved_searches (
    search_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}',
    last_alerted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_user_id ON saved_searches (user_id)
WHERE
    deleted_at IS NULL;

CREATE OR REPLACE TRIGGER trg_saved_searches_updated_at
    BEFORE UPDATE ON saved_searches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();