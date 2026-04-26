-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 006: Proper rent index
--
-- rent_observations: one row per active listing event (created / renewed).
--   Written by a DB trigger on listings — no application code path can forget it.
--
-- rent_index: materialised p25/p50/p75 per (city, locality, room_type).
--   Refreshed nightly by cron/rentIndexRefresh.js.
--   Listings JOIN this table to expose rentDeviation in API responses.

CREATE TABLE IF NOT EXISTS rent_observations (
    observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    listing_id UUID NOT NULL REFERENCES listings (listing_id) ON DELETE CASCADE,
    city VARCHAR(100) NOT NULL,
    locality VARCHAR(100), -- normalised to LOWER(TRIM(...)), NULL for city-wide
    room_type room_type_enum NOT NULL,
    rent_per_month INTEGER NOT NULL, -- paise, same unit as listings.rent_per_month
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'listing_created' | 'listing_renewed' — set by the trigger
    source VARCHAR(30) NOT NULL DEFAULT 'listing_created',
    CONSTRAINT chk_positive_rent CHECK (rent_per_month > 0)
);

-- Index optimised for the cron aggregation query: GROUP BY city, locality, room_type
-- filtered to observations within the rolling 180-day window.
CREATE INDEX IF NOT EXISTS idx_rent_obs_aggregation ON rent_observations (
    city,
    locality,
    room_type,
    observed_at DESC
);

-- Fast lookup for cascading hard-deletes (cleanup cron).
CREATE INDEX IF NOT EXISTS idx_rent_obs_listing_id ON rent_observations (listing_id);

-- Materialised rent index — upserted by cron, never written from app code.
-- locality IS NULL means the row is the city-wide fallback used when no
-- locality-specific data meets the minimum sample threshold.
CREATE TABLE IF NOT EXISTS rent_index (
    rent_index_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    city VARCHAR(100) NOT NULL,
    locality VARCHAR(100), -- NULL = city-wide fallback
    room_type room_type_enum NOT NULL,
    p25 INTEGER NOT NULL, -- 25th percentile, paise
    p50 INTEGER NOT NULL, -- median
    p75 INTEGER NOT NULL, -- 75th percentile
    sample_count INTEGER NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_rent_index UNIQUE (city, locality, room_type),
    CONSTRAINT chk_rent_index_order CHECK (
        p25 <= p50
        AND p50 <= p75
    )
);

CREATE INDEX IF NOT EXISTS idx_rent_index_lookup ON rent_index (city, locality, room_type);

-- Trigger function: fires after INSERT on listings (new listing goes active)
-- and after UPDATE when status flips to 'active' (listing renewed / reactivated).
-- Runs inside the same transaction as the listing write — observation is never lost.
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
        AND OLD.status <> 'active'
        AND NEW.deleted_at IS NULL
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

DROP TRIGGER IF EXISTS trg_capture_rent_observation ON listings;

CREATE TRIGGER trg_capture_rent_observation
    AFTER INSERT OR UPDATE OF status ON listings
    FOR EACH ROW EXECUTE FUNCTION capture_rent_observation();