011:Fix rentObservationTriggerActiveRenw
--
-- The original trg_capture_rent_observation in migration 006 only fired on
-- UPDATE when OLD.status <> 'active'. This meant that renewals (which keep
-- status='active' but extend expires_at) never created a 'listing_renewed'
-- observation, dropping valid price signals from rent-index computation.
--
-- Fix: watch expires_at in addition to status, and broaden the UPDATE condition
-- to fire whenever NEW.status = 'active' AND either the status changed OR
-- expires_at changed.

CREATE OR REPLACE FUNCTION capture_rent_observation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status = 'active' AND NEW.deleted_at IS NULL THEN
        INSERT INTO rent_observations
            (listing_id, city, locality, room_type, rent_per_month, source)
        VALUES (
            NEW.listing_id,
            NEW.city,
            NULLIF(LOWER(TRIM(COALESCE(NEW.locality, ''))), ''),
            NEW.room_type,
            NEW.rent_per_month,
            'listing_created'
        );

    ELSIF TG_OP = 'UPDATE'
        AND NEW.status = 'active'
        AND NEW.deleted_at IS NULL
        AND (
            OLD.status <> 'active'
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        )
    THEN
        INSERT INTO rent_observations
            (listing_id, city, locality, room_type, rent_per_month, source)
        VALUES (
            NEW.listing_id,
            NEW.city,
            NULLIF(LOWER(TRIM(COALESCE(NEW.locality, ''))), ''),
            NEW.room_type,
            NEW.rent_per_month,
            'listing_renewed'
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-create trigger to also watch expires_at so renewals fire it.
DROP TRIGGER IF EXISTS trg_capture_rent_observation ON listings;

CREATE TRIGGER trg_capture_rent_observation
    AFTER INSERT OR UPDATE OF status, expires_at ON listings
    FOR EACH ROW EXECUTE FUNCTION capture_rent_observation();