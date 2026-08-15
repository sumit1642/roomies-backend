-- Migration 014: Fix verification_rejected outbox event carrying the wrong reason
--
-- Root cause: trg_verification_status_changed (migration 002) populates
-- verification_event_outbox.rejection_reason from NEW.admin_notes:
--
--   INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
--   VALUES ('verification_rejected', NEW.user_id, NEW.request_id, NEW.admin_notes);
--
-- But the actual rejection reason shown to the PG owner (passed by the caller
-- as `rejectionReason` in src/services/verification.service.js's rejectRequest())
-- is only ever written to pg_owner_profiles.rejection_reason — a different
-- table the trigger has no visibility into. verification_requests never had
-- its own rejection_reason column, so admin_notes (a separate, admin-internal
-- field, populated only when the admin optionally supplies one) was used by
-- mistake. When the admin doesn't supply adminNotes (the common case), this
-- column is NULL, and the outbox — and therefore the rejection email — falls
-- back to the generic "Please review the requirements and resubmit." message,
-- silently discarding the real reason.
--
-- Fix: give verification_requests its own rejection_reason column, populate
-- it from the same value written to pg_owner_profiles.rejection_reason, and
-- point the trigger at it instead of admin_notes. admin_notes remains
-- untouched as admin-internal commentary, distinct from the reason shown to
-- the PG owner.
--
-- Existing rows: rejection_reason is backfilled from pg_owner_profiles for any
-- already-rejected requests, on a best-effort basis (matches the most recent
-- rejected request per user, since verification_requests doesn't retain a
-- direct link to which historical rejection produced the profile's current
-- reason). New rejections going forward are correct by construction because
-- the application code now writes the reason directly at rejection time.

ALTER TABLE verification_requests
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Best-effort backfill for pre-existing rejected requests: only affects the
-- single most recent rejected request per user (the one whose reason is
-- still visible on pg_owner_profiles today); older superseded rejections
-- cannot be recovered since the original per-request reason was never stored.
UPDATE verification_requests vr
SET rejection_reason = pop.rejection_reason
FROM pg_owner_profiles pop
WHERE vr.user_id = pop.user_id
  AND vr.status = 'rejected'
  AND vr.rejection_reason IS NULL
  AND pop.rejection_reason IS NOT NULL
  AND vr.request_id = (
      SELECT vr2.request_id
      FROM verification_requests vr2
      WHERE vr2.user_id = vr.user_id
        AND vr2.status = 'rejected'
      ORDER BY vr2.reviewed_at DESC NULLS LAST, vr2.submitted_at DESC
      LIMIT 1
  );

CREATE OR REPLACE FUNCTION verification_status_changed()
    RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'verified' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id)
        VALUES ('verification_approved', NEW.user_id, NEW.request_id);

    ELSIF NEW.status = 'rejected' THEN
        INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
        VALUES ('verification_rejected', NEW.user_id, NEW.request_id, NEW.rejection_reason);

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
    AFTER INSERT OR UPDATE OF status ON verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION verification_status_changed();