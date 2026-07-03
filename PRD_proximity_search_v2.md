# PRD — Proximity Search v2: Pincode-Based Web Search + Native GPS on Android

**Status:** Draft for review
**Owner:** Dev5
**Affects:** `src/services/listing.service.js`, `src/validators/listing.validators.js`, new `pincodes` table, new `pincodes` route/controller/service, web client, Android client
**Does not affect:** listing creation (`createListing`), roommate feed city filter, PG-owner vs. student listing logic (both already share the `listings` table)

---

## 1. Background

Today, `GET /api/v1/listings` accepts optional `lat` + `lng` + `radius` from **any** client and runs a PostGIS `ST_DWithin` proximity query against `listings.location` (falling back to the parent `properties.location` for `pg_room`/`hostel_bed` listings). The browser currently supplies `lat`/`lng` via the Geolocation API, same as a native app would.

This works, but browser geolocation on the web has real friction: permission prompts, inconsistent accuracy indoors, and users who simply decline. For a PG/roommate discovery product where the primary intent signal is often "near my college" or "near this locality," a **pincode** is a more natural, higher-completion-rate input for web users than a location permission prompt.

## 2. Goal

Give web users a pincode-first way to search nearby listings, while Android keeps using device GPS. Both paths converge on the exact same backend proximity query — only the *input* differs.

## 3. Decisions Locked In

| Question | Decision |
|---|---|
| How to collapse ~8.45 offices/pincode into one coordinate | **Priority-weighted**: Head Office (H.O) > Sub Office (S.O) > Branch Office (B.O). If the top-priority tier has no valid coordinate, average all valid coordinates for that pincode. |
| Should browser geolocation be removed on web? | **No** — kept as a parallel "Use my location" path. Web supports *both* pincode entry and geolocation. |
| Should this also change listing creation? | **No** — `createListing`/`updateListing` keep their existing manual `addressLine`/`city`/`latitude`/`longitude` fields for `student_room` listings. This PRD is search-only. |

## 4. User-Facing Behavior

### Web
- **Primary path:** user types a 6-digit pincode into the search bar. Backend resolves it to a lat/lng centroid and runs the same radius search used today.
- **Secondary path:** a "Use my location" button remains available and calls the browser Geolocation API exactly as today, sending `lat`/`lng` directly — no behavior change on this path.
- If both are present in a request somehow (e.g. stale form state), **lat/lng wins** over pincode — it's the more precise signal.
- If the pincode isn't recognized, the user gets a clear error ("We don't recognize that pincode") rather than a silent unfiltered search — silently ignoring an invalid pincode and returning all listings would be misleading.

### Android
- **Unchanged.** GPS → `lat`/`lng` → same `/listings` endpoint. No pincode UI on Android for this phase.

### Applies to both student and PG-owner postings
No change needed here — `listings` already stores both `student_room` and `pg_room`/`hostel_bed` rows in one table, and the existing `searchListings` query already unions them by `listing_type` filter, not by a separate table. Resolving `pincode → lat/lng` upstream of that query means both posting types are covered automatically.

## 5. Data Model

### 5.1 New reference table: `pincodes`

One row per pincode (not per post office). Read-only reference data, refreshed rarely (India Post pincode boundaries are effectively static).

```sql
-- migrations/012_pincodes.sql
CREATE TABLE IF NOT EXISTS pincodes (
    pincode      CHAR(6) PRIMARY KEY,
    city         VARCHAR(100) NOT NULL,   -- representative office name / locality
    district     VARCHAR(100),
    state        VARCHAR(100) NOT NULL,
    latitude     NUMERIC(10, 7) NOT NULL,
    longitude    NUMERIC(10, 7) NOT NULL,
    location     GEOMETRY(POINT, 4326),
    office_count INTEGER NOT NULL,        -- how many CSV rows collapsed into this row
    resolution   VARCHAR(20) NOT NULL,    -- 'ho' | 'so' | 'bo' | 'averaged'
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pincodes_location ON pincodes USING GIST (location);

-- Reuse the existing sync_location_geometry() trigger function from migration 001
-- so `location` is always derived consistently, same as listings/properties.
CREATE OR REPLACE TRIGGER trg_pincodes_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON pincodes
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();
```

`pincode` is a `CHAR(6)` primary key rather than a UUID — it's a natural key, lookups are always by exact pincode, and there's no reason to add a surrogate key for static reference data (same reasoning already applied to `amenities.name` being unique, just taken one step further here).

### 5.2 Seed / ETL script

New file: `src/db/seeds/pincodes.js`, following the exact pattern already established by `src/db/seeds/amenities.js` (`ENV_FILE=.env.local node src/db/seeds/pincodes.js`, added as an npm script `seed:pincodes`).

Algorithm per pincode group:
1. Bucket the group's rows by office-type priority tier (H.O → S.O → B.O — **exact string values in `officetype` must be confirmed against the real CSV before implementation**; the 5-row sample we've seen only shows `"BO"` and `"PO"`, so the actual tier vocabulary needs a `SELECT DISTINCT officetype` pass first).
2. Within the highest non-empty tier, if there are multiple rows with valid (non-null) coordinates, average them. If that tier has zero valid coordinates, drop to the next tier.
3. If **no** office in the pincode has a valid coordinate at all, exclude the pincode from the table entirely and log it — do not guess. (Expected to be a small minority of the ~7% rows missing coordinates, since most pincodes have several offices and only need one valid one.)
4. Record `office_count` and `resolution` for auditability — if a pincode's centroid ever looks wrong in production, we can tell at a glance whether it came from an H.O row, an average, etc.

This is a **one-time / rarely-rerun** script, not part of the request path — no runtime dependency on the CSV file.

## 6. API Changes

### 6.1 New endpoint: pincode lookup

```
GET /api/v1/pincodes/:pincode
```
- Public, unauthenticated (matches the existing `rentIndexRouter` pattern — public GETs for reference/context data).
- 200 → `{ pincode, city, district, state, latitude, longitude }`
- 404 → pincode not in the table.
- Used by the web client to show a confirmation chip ("Dehradun, Uttarakhand") before firing the search — this can ship in a later phase; the search endpoint below works standalone without it.

*(Phase 2, optional)* `GET /api/v1/pincodes?q=248` — prefix search for a typeahead. Deferred unless you want it for MVP.

### 6.2 `searchListingsSchema` (src/validators/listing.validators.js)

Add:
```js
pincode: z.string().regex(/^\d{6}$/, { error: "pincode must be exactly 6 digits" }).optional(),
```
No refinement is added forcing pincode/lat-lng mutual exclusivity — both are legal to send; the service layer decides precedence (§6.3). This keeps the browser's two search modes (pincode vs. "use my location") from needing to coordinate on which param to omit.

### 6.3 `searchListings` service (src/services/listing.service.js)

Before the existing `lat/lng` branch that builds the `ST_DWithin` clause:

```js
let { lat, lng } = filters;
if (lat === undefined && lng === undefined && filters.pincode !== undefined) {
  const resolved = await pool.query(
    `SELECT latitude, longitude FROM pincodes WHERE pincode = $1`,
    [filters.pincode],
  );
  if (!resolved.rows.length) {
    throw new AppError("We don't recognize that pincode", 404);
  }
  ({ latitude: lat, longitude: lng } = resolved.rows[0]);
}
```

Everything downstream — the `ST_DWithin` clause, the `radius` param (100–50,000m, default 5,000, unchanged), the `property.location` fallback for PG listings — is **untouched**. This is intentionally a small, additive diff: one lookup query gates entry into logic that already exists and is already tested in production.

No backend branching on "is this Android or web" — the server doesn't need to know or care which client sent the request. It just accepts whichever of `{lat,lng}` or `{pincode}` is present. This avoids fragile user-agent sniffing and keeps the contract simple: *the client decides its own input mode.*

### 6.4 Precedence rule

If a request somehow includes both `lat`/`lng` and `pincode` (e.g., stale client state), **`lat`/`lng` wins** and `pincode` is ignored — GPS/device coordinates are strictly more precise than a pincode centroid.

## 7. Non-Goals (explicit, per decisions above)

- **Listing creation is untouched.** `createListingSchema` / `updateListingSchema` keep manual `addressLine`, `city`, `locality`, `latitude`, `longitude` fields for `student_room` listings. No pincode-driven autofill there in this phase.
- **Roommate feed is untouched.** `getRoommateFeed`'s `city` filter is a `LIKE`-based text match on `listings.city`, not a proximity query — this PRD doesn't extend proximity search to it. (Flag as a natural future extension, not in scope now.)
- **No third-party geocoding API.** Android continues to hit our own `/listings` endpoint with GPS-derived `lat`/`lng`, exactly as today — nothing changes on that path.
- **No PG-vs-student special-casing.** Both listing types already live in one `listings` table and flow through one query.

## 8. Open Items / Risks

| Item | Why it matters | Suggested resolution |
|---|---|---|
| Exact `officetype` vocabulary in the real CSV | The H.O/S.O/B.O priority mapping needs real string values, not assumed ones | Run `SELECT DISTINCT officetype, COUNT(*) FROM staging_pincodes GROUP BY 1` once the CSV is actually uploaded to this project, before writing the seed script's tier map |
| Pincodes with zero valid coordinates across *all* their offices | These pincodes can't be seeded at all under the "don't guess" rule | Log excluded pincodes at seed time; decide later whether a one-off manual backfill or third-party geocode pass is worth it (likely a very small number given multiple offices per pincode) |
| Web UX for invalid/incomplete pincode entry | A raw 404 mid-typing is a bad experience | Debounce + validate format client-side (6 digits) before calling search; consider the phase-2 `/pincodes/:pincode` confirmation lookup to catch "valid format, wrong pincode" before firing a full listings search |
| Caching | `pincodes` never changes at request time | Fine to rely on the Postgres index alone at current scale (19.5k rows); revisit only if pincode lookups become a measurable share of DB load |

## 9. Rollout Plan

1. Get the actual CSV into the project (`AllIndiaPincodeDataSet.csv` isn't present in this repo/container yet — needed before the seed script can be finalized).
2. Migration `012_pincodes.sql` (table + index + trigger reuse).
3. `src/db/seeds/pincodes.js` + `npm run seed:pincodes`, run against local/dev DB, spot-check a handful of known pincodes against Google Maps.
4. Add `pincodeRouter` (`GET /pincodes/:pincode`) — small, isolated, easy to test independently.
5. Extend `searchListingsSchema` + `searchListings` service per §6.2–6.4.
6. Web: add pincode input as the primary search control; keep the existing "Use my location" button wired to the unchanged lat/lng path.
7. Android: no changes required.
8. Run the seed script against Neon (prod) as part of the next deploy, same as any other one-time data migration in this project's existing playbook.
