-- Migration 015: Ensure SRID 4326 (WGS84) exists in spatial_ref_sys
--
-- Root cause: on some postgis/postgis Docker images (confirmed on
-- postgis/postgis:16-3.4-alpine), `CREATE EXTENSION postgis` installs the
-- spatial_ref_sys TABLE but does not always populate it with the ~8,500
-- standard EPSG rows the extension script is supposed to load. This is a
-- packaging/init quirk of that image, not an application bug — simple point
-- construction (ST_SetSRID, used by sync_location_geometry()'s trigger) does
-- not need a spatial_ref_sys row and works fine either way, which is why this
-- was invisible until a query that actually needs geodetic math
-- (ST_DWithin on a ::geography cast, used by listing.service.js's
-- proximity/lat-lng search) ran and failed with:
--   "Cannot find SRID (4326) in spatial_ref_sys"
--
-- Fix: insert the standard WGS84 (SRID 4326) definition directly if it's
-- missing. This is the only SRID this application ever uses (every
-- ST_SetSRID / ST_MakePoint call in the codebase is hardcoded to 4326), so a
-- single targeted row is sufficient — no need to reproduce the full EPSG
-- dataset. ON CONFLICT DO NOTHING makes this safe to run against an
-- environment where spatial_ref_sys is already correctly populated (e.g. a
-- non-alpine or differently-built postgis image).

INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text)
VALUES (
    4326,
    'EPSG',
    4326,
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
    '+proj=longlat +datum=WGS84 +no_defs'
)
ON CONFLICT (srid) DO NOTHING;
