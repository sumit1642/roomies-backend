-- Active: 1774765370673@@127.0.0.1@5432@roomies_db
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'notification_type_enum'
          AND e.enumlabel = 'verification_pending'
    ) THEN
        ALTER TYPE notification_type_enum ADD VALUE 'verification_pending';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS verification_event_outbox (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    event_type VARCHAR(50) NOT NULL CHECK (
        event_type IN (
            'verification_approved',
            'verification_rejected',
            'verification_pending'
        )
    ),
    user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES verification_requests (request_id) ON DELETE CASCADE,
    rejection_reason TEXT,
    processed_at TIMESTAMPTZ,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_outbox_unprocessed ON verification_event_outbox (created_at ASC)
WHERE
    processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_verification_outbox_user_id ON verification_event_outbox (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION verification_status_changed()
    RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'verified' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_approved', NEW.user_id, NEW.request_id);

    ELSIF NEW.status = 'rejected' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
        VALUES ('verification_rejected', NEW.user_id, NEW.request_id, NEW.admin_notes);

    ELSIF NEW.status = 'pending' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_pending', NEW.user_id, NEW.request_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    DROP TRIGGER IF EXISTS trg_verification_status_changed ON verification_requests;
END;
$$;

CREATE TRIGGER trg_verification_status_changed
    AFTER UPDATE OF status ON verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION verification_status_changed();