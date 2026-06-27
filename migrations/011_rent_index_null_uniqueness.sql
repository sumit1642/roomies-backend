-- Migration 011: enforce uniqueness of city-wide (locality IS NULL) rent_index rows
-- Fix: deduplicate existing NULL-locality rows before adding the NULLS NOT DISTINCT
-- constraint. Keeps the newest row (highest computed_at) per (city, locality, room_type)
-- to avoid ALTER TABLE failures on databases that already ran the refresh cron.
--
-- Why only NULL-locality rows can be duplicates:
--   The old uq_rent_index constraint used standard NULL-distinct semantics, where
--   each NULL is treated as unequal to every other NULL, so it allowed multiple
--   (city, NULL, room_type) rows. Locality-specific rows (locality IS NOT NULL)
--   were already protected by the old constraint and cannot have duplicates.

BEGIN;

-- Step 1: Remove duplicate city-wide (locality IS NULL) rows, keeping the newest.
DELETE FROM rent_index
WHERE rent_index_id IN (
    SELECT rent_index_id
    FROM (
        SELECT
            rent_index_id,
            ROW_NUMBER() OVER (
                PARTITION BY city, room_type
                ORDER BY computed_at DESC, rent_index_id
            ) AS rn
        FROM rent_index
        WHERE locality IS NULL
    ) ranked
    WHERE rn > 1
);

-- Step 2: Swap in the NULL-aware unique constraint.
ALTER TABLE rent_index
    DROP CONSTRAINT IF EXISTS uq_rent_index;

ALTER TABLE rent_index
    ADD CONSTRAINT uq_rent_index UNIQUE NULLS NOT DISTINCT (city, locality, room_type);

COMMIT;