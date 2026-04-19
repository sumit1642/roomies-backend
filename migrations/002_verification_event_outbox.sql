-- Active: 1774765370673@@127.0.0.1@5432@roomies_db
-- migrations/002_verification_event_outbox.sql
--
-- Adds the CDC (Change Data Capture) infrastructure for verification events.
--
-- What this migration does:
--   1.  Adds 'verification_pending' to notification_type_enum so the worker
--       can store acknowledgement notifications when a document is submitted.
--   2.  Creates the verification_event_outbox table — the durable bridge
--       between database-level changes and the application-level worker.
--   3.  Creates the verification_status_changed() trigger function that fires
--       automatically on any UPDATE to verification_requests.status, regardless
--       of whether that change came from the API, a migration script, or a
--       direct psql session.
--   4.  Attaches the trigger to the verification_requests table.
--
-- Why an outbox table instead of just pg_notify?
--   pg_notify() sends an ephemeral signal. If the Node.js worker is down or
--   restarting at the moment the signal fires, the message is lost permanently.
--   The outbox table persists the event to disk inside the same transaction as
--   the data change, so the worker can drain it on startup and catch up on
--   anything it missed. Think of it as a durable message queue implemented
--   entirely inside your existing Postgres instance — no extra infrastructure.
--
-- How to run:
--   psql "$DATABASE_URL" -f migrations/002_verification_event_outbox.sql

-- =============================================================================
-- STEP 1 — Extend notification_type_enum with the new value.
--
-- ALTER TYPE ... ADD VALUE is transactional in Postgres 12+ but cannot be
-- rolled back inside the same transaction that uses the new value. Since this
-- migration only adds the value (no INSERT using it), it is safe to run
-- in a transaction. The IF NOT EXISTS guard makes re-runs a no-op.
-- =============================================================================

DO $$
BEGIN
    -- Check if the value already exists before trying to add it.
    -- pg_enum holds all enum values; this avoids an error on re-run.
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

-- =============================================================================
-- STEP 2 — Create the outbox table.
--
-- Each row represents one CDC event: "something significant happened to a
-- verification request." Rows are written by the DB trigger and drained
-- (read + marked processed) by the Node.js verificationEventWorker.
--
-- Key design decisions:
--   processed_at  NULL means "not yet consumed by the worker." The worker
--                 sets this to NOW() as its acknowledgement step, making
--                 the operation idempotent — a row is processed exactly once.
--
--   attempts      Tracks how many times the worker tried to process this event.
--                 The worker stops retrying after MAX_ATTEMPTS (defined in the
--                 worker code, currently 5) to avoid infinite retry loops on
--                 permanently broken events.
--
--   error_message Records the last error from a failed processing attempt,
--                 giving operators visibility without needing to dig through
--                 application logs.
--
--   rejection_reason  Denormalized from verification_requests.admin_notes at
--                     write time. This makes the outbox row self-contained —
--                     the worker does not need to re-query the source table,
--                     and the notification reflects the reason as it was at
--                     decision time even if admin_notes is later edited.
-- =============================================================================

CREATE TABLE IF NOT EXISTS verification_event_outbox (
    event_id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

-- The type of event. Values mirror notification_type_enum so the worker
-- can pass the value directly to enqueueNotification() without mapping.
-- Stored as VARCHAR rather than the enum because trigger functions write
-- string literals, and the worker validates the value at processing time.
event_type VARCHAR(50) NOT NULL CHECK (
    event_type IN (
        'verification_approved',
        'verification_rejected',
        'verification_pending'
    )
),

-- The PG owner whose verification status changed.
user_id UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,

-- The specific verification request row that changed.
request_id UUID NOT NULL REFERENCES verification_requests (request_id) ON DELETE CASCADE,

-- Populated only for rejection events. Captured at trigger time from
-- verification_requests.admin_notes so the email contains the right reason
-- even if the admin edits their notes after the fact.
rejection_reason TEXT,

-- Worker lifecycle columns.
processed_at     TIMESTAMPTZ,         -- NULL = pending. Set by worker on success.
    error_message    TEXT,                 -- Last failure message, if any.
    attempts         INTEGER      NOT NULL DEFAULT 0,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Primary worker query pattern: "give me all unprocessed events, oldest first."
-- Partial index on processed_at IS NULL keeps the index tiny. Once the worker
-- marks an event processed, it falls out of this index automatically — the index
-- never grows beyond the current pending backlog.
CREATE INDEX IF NOT EXISTS idx_verification_outbox_unprocessed ON verification_event_outbox (created_at ASC)
WHERE
    processed_at IS NULL;

-- Secondary index for operational queries: "show me all events for a given user"
-- (useful for debugging and the admin dashboard).
CREATE INDEX IF NOT EXISTS idx_verification_outbox_user_id ON verification_event_outbox (user_id, created_at DESC);

-- =============================================================================
-- STEP 3 — Trigger function: writes an outbox row when verification status
-- changes. Runs inside the same transaction as the UPDATE, so atomicity is
-- guaranteed — the outbox row and the data change always commit together.
-- =============================================================================

CREATE OR REPLACE FUNCTION verification_status_changed()
    RETURNS TRIGGER AS $$
BEGIN
    -- Guard: only fire when status actually changed. Without this guard, the
    -- trigger would produce an outbox row whenever ANY column on the row is
    -- updated (e.g. admin edits admin_notes but keeps status = 'pending').
    -- That would produce spurious events and duplicate notifications.
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    -- Map the new status value to the outbox event type the application expects.
    -- 'verified'  → verification_approved  (PG owner can now create listings)
    -- 'rejected'  → verification_rejected  (PG owner needs to resubmit)
    -- 'pending'   → verification_pending   (acknowledgement: "we received it")
    --
    -- 'unverified' is the default state set at account creation and never
    -- transitioned to from another state via business logic, so no event is
    -- needed for it.
    IF NEW.status = 'verified' THEN
        INSERT INTO verification_event_outbox
            (event_type, user_id, request_id)
        VALUES
            ('verification_approved', NEW.user_id, NEW.request_id);

    ELSIF NEW.status = 'rejected' THEN
        -- Capture admin_notes as the rejection reason at decision time.
        -- Denormalizing here makes the outbox row self-contained so the worker
        -- does not need to re-query verification_requests.
        INSERT INTO verification_event_outbox
            (event_type, user_id, request_id, rejection_reason)
        VALUES
            ('verification_rejected', NEW.user_id, NEW.request_id, NEW.admin_notes);

    ELSIF NEW.status = 'pending' THEN
        -- A new document submission. The worker will send an acknowledgement
        -- email to the PG owner: "We received your documents and are reviewing them."
        INSERT INTO verification_event_outbox
            (event_type, user_id, request_id)
        VALUES
            ('verification_pending', NEW.user_id, NEW.request_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- STEP 4 — Attach the trigger to verification_requests.
--
-- AFTER UPDATE OF status ensures:
--   - The trigger only fires when the `status` column is part of the UPDATE
--     statement, not on every column update (efficient).
--   - AFTER means NEW.status already reflects the committed value when
--     INSERT INTO verification_event_outbox runs (correct ordering).
--   - FOR EACH ROW means one outbox event per changed row, even in bulk UPDATEs.
--
-- CREATE OR REPLACE TRIGGER (Postgres 14+) makes this idempotent on re-runs.
-- For Postgres < 14, the DO $$ block below handles idempotency.
-- =============================================================================

DO $$
BEGIN
    -- Drop the old trigger if it exists so we can (re-)create it cleanly.
    -- This handles the case where the trigger function was changed and the
    -- migration is being re-applied to a database that already has the trigger.
    DROP TRIGGER IF EXISTS trg_verification_status_changed ON verification_requests;
END;
$$;

CREATE TRIGGER trg_verification_status_changed
    AFTER UPDATE OF status ON verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION verification_status_changed();

-- Verification: confirm the trigger was attached correctly.
-- This is a no-op at runtime but serves as documentation.
-- SELECT trigger_name, event_manipulation, action_timing
-- FROM information_schema.triggers
-- WHERE event_object_table = 'verification_requests';