-- Migration 012: Pincode reference table for proximity search v2
-- Migration 012: Pincode reference table for proximity search v2
--
-- One row per pincode (not per post office). Read-only reference data,
-- seeded once via `npm run seed:pincodes` and refreshed rarely (India Post
-- pincode boundaries are effectively static; new pincodes are occasionally
-- introduced by India Post, which would warrant a re-run of the seed).
--
-- See PRD_proximity_search_v2.md (v3) for full background. Key points that
-- explain the shape of this table:
--
--   - `office_count` and `resolution` are auditability columns: they record
--     how many raw CSV rows collapsed into this pincode, and whether the
--     centroid came from a real office-type priority signal ('priority')
--     or a fallback average across all offices ('averaged'). If a pincode's
--     centroid ever looks wrong in production, these tell us at a glance
--     which code path produced it.
--
--   - `swap_corrected` flags rows where the seed script detected the raw
--     CSV had latitude/longitude swapped (confirmed present in the real
--     dataset — e.g. a Telangana pincode with latitude=79.0, longitude=17.0,
--     which is nonsensical as given but a valid coordinate once swapped).
--     This lets us audit exactly which pincodes were auto-corrected rather
--     than re-deriving it later.
--
--   - The lat/lng CHECK constraints use India's actual geographic extent
--     (not a generic world bounding box) because we've now profiled the
--     real seed data against this exact box (profile_pincodes.py) and
--     confirmed all correctable rows fall inside it after swap-correction.
--     This makes the constraint a meaningful guard against any future
--     seed-script regression that reintroduces garbage or swapped
--     coordinates, rather than a decorative check that would accept
--     anything.

CREATE TABLE IF NOT EXISTS pincodes (
    pincode        CHAR(6) PRIMARY KEY,
    city           VARCHAR(100) NOT NULL,   -- representative office name / locality
    district       VARCHAR(100),
    state          VARCHAR(100) NOT NULL,
    latitude       NUMERIC(10, 7) NOT NULL,
    longitude      NUMERIC(10, 7) NOT NULL,
    location       GEOMETRY(POINT, 4326),
    office_count   INTEGER NOT NULL,
    resolution     VARCHAR(20) NOT NULL,
    swap_corrected BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_pincode_format CHECK (pincode ~ '^[0-9]{6}$'),
    CONSTRAINT chk_pincode_latitude CHECK (latitude BETWEEN 6.0 AND 38.0),
    CONSTRAINT chk_pincode_longitude CHECK (longitude BETWEEN 68.0 AND 98.0),
    CONSTRAINT chk_pincode_office_count CHECK (office_count > 0),
    CONSTRAINT chk_pincode_resolution CHECK (resolution IN ('priority', 'averaged'))
);

CREATE INDEX IF NOT EXISTS idx_pincodes_location ON pincodes USING GIST (location);

-- Reuse the existing sync_location_geometry() trigger function from migration 001
-- so `location` is always derived consistently, same as listings/properties.
CREATE OR REPLACE TRIGGER trg_pincodes_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON pincodes
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();