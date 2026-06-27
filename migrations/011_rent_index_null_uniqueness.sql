-- Migration 011: enforce uniqueness of city-wide (locality IS NULL) rent_index rows
BEGIN;

ALTER TABLE rent_index
    DROP CONSTRAINT IF EXISTS uq_rent_index;

ALTER TABLE rent_index
    ADD CONSTRAINT uq_rent_index UNIQUE NULLS NOT DISTINCT (city, locality, room_type);

COMMIT;