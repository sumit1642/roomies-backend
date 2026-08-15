-- Migration 013: Fix verification_pending outbox event never firing
--
-- Root cause: trg_verification_status_changed (migration 002) was defined as
--   AFTER UPDATE OF status ON verification_requests
-- but src/services/verification.service.js's submitDocument() creates the
-- initial request via a plain INSERT (status defaults to 'pending' via the
-- column default, it is never UPDATEd into that state). Because the trigger
-- only listens for UPDATE OF status, the very first submission never fires
-- it, so no 'verification_pending' row is ever written to
-- verification_event_outbox, and the "documents received" acknowledgement
-- email is silently never sent.
--
-- Approval/rejection ('pending' -> 'verified' / 'pending' -> 'rejected') are
-- genuine UPDATE OF status transitions and already worked correctly — this
-- migration does not change that behavior.
--
-- Fix: widen the trigger to fire on INSERT as well as UPDATE OF status, and
-- guard the UPDATE no-op check with TG_OP so it doesn't affect the INSERT path
-- (there is no OLD row on INSERT, so NEW.status IS NOT DISTINCT FROM OLD.status
-- would error/short-circuit incorrectly if evaluated unconditionally).

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
    AFTER INSERT OR UPDATE OF status ON verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION verification_status_changed();