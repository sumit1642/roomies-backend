# PRD — Proximity Search v2: Pincode-Based Web Search + Native GPS on Android

**Status:** Draft for review — v3 (updated with real dataset profiling results)
**Owner:** Dev5
**Affects:** `src/services/listing.service.js`, `src/validators/listing.validators.js`, new `pincodes` table, new `pincodes` route/controller/service, web client, Android client
**Does not affect:** listing creation (`createListing`), roommate feed city filter, PG-owner vs. student listing logic (both already share the `listings` table)

---

## 0. Summary of changes from v2

v2 flagged the office-type tiering and coordinate-quality questions as open items blocking implementation. `profile_pincodes.py` has now been run against the real `AllIndiaPincodeDataSet.csv` (165,627 rows, 19,586 unique pincodes). This revision replaces every "pending confirmation" placeholder with the actual numbers and finalizes the seed algorithm and migration constraints accordingly. Three things changed materially as a result:

1. **The tiering blocker is resolved, and better than expected.** `officetype` is *not* only `{BO, PO}` as the earlier small sample suggested — the real file also has an `HO` value (811 rows), and combined with `officename` suffix parsing, **80.2% of pincodes (15,683 / 19,550) resolve via a real priority signal**, not a fallback average. §5.2 is now a finished spec, not an open question.
2. **A real coordinate-quality bug was found that v2 didn't anticipate: swapped lat/lng pairs.** 2,602 rows fail the India bounding-box check, but inspecting samples shows most of these aren't garbage — they're **latitude and longitude swapped** (e.g. `latitude=79.0, longitude=17.0` for a Telangana pincode, where `17°N, 79°E` is the correct, plausible coordinate). Silently dropping these under the original "exclude if out of bounds" rule would throw away recoverable data for hundreds of pincodes. §5.2 and §5.1 are updated to detect-and-correct swaps before falling back to exclusion.
3. **The accuracy-ceiling risk from §2.1 is now cited with real numbers** instead of external-source estimates: median 7 offices per pincode (up to 153 in one case), meaning a "centroid" is frequently an average over administratively-related but geographically dispersed points — reinforcing, not softening, the phase-1 confirmation-chip decision from v2.

Everything else from v2 (phase-1 confirmation chip, precedence rule, `searchListings` diff, non-goals) is unchanged and still holds.

---

## 1. Background

Today, `GET /api/v1/listings` accepts optional `lat` + `lng` + `radius` from **any** client and runs a PostGIS `ST_DWithin` proximity query against `listings.location` (falling back to the parent `properties.location` for `pg_room`/`hostel_bed` listings). The browser currently supplies `lat`/`lng` via the Geolocation API, same as a native app would.

This works, but browser geolocation on the web has real friction: permission prompts, inconsistent accuracy indoors, and users who simply decline. For a PG/roommate discovery product where the primary intent signal is often "near my college" or "near this locality," a **pincode** is a more natural, higher-completion-rate input for web users than a location permission prompt.

## 2. Goal

Give web users a pincode-first way to search nearby listings, while Android keeps using device GPS. Both paths converge on the exact same backend proximity query — only the *input* differs, and the web path trades some precision for a much lower-friction input.

### 2.1 Known accuracy ceiling — confirmed against the real dataset

Pincode-centroid search is **not** a precision substitute for GPS in the Indian context. This is no longer just an external-research concern — the profiling pass over our actual seed data confirms it directly:

- **Median offices per pincode: 7** (mean 8.46, max 153, from a single pincode with 153 separate post offices mapped to it). A "centroid" for a pincode is frequently the average of many administratively-grouped but geographically separate points, not a tight cluster around one real location.
- Independent research (cited in v1/v2) already established that the median Indian pincode covers ~90 sq km, and rural pincodes can be far larger and irregularly shaped. The 153-office outlier in our own data is consistent with that — a pincode that large plausibly spans a whole taluk or more.
- There is no official pincode boundary polygon data from India Post; every centroid-based approach (including this one) is a best-effort approximation, not a geometric truth.

**Product implication, unchanged from v2:** pincode search is an *approximate area* filter, not "your exact location." The phase-1 confirmation-chip UI (§6.1) remains a hard requirement, not optional polish, given these numbers.

## 3. Decisions Locked In

| Question | Decision |
|---|---|
| How to collapse ~8.46 offices/pincode into one coordinate | **Finalized** (was pending in v2) — see §5.2. Priority tier: `HO`/`GPO` > `SO` > `BO` > unranked, derived from a combination of `officetype` and `officename` suffix parsing. Falls back to full averaging only when no tier signal exists for a pincode (19.8% of pincodes, per §5.2). |
| Should browser geolocation be removed on web? | **No** — kept as a parallel "Use my location" path. Web supports *both* pincode entry and geolocation. |
| Should this also change listing creation? | **No** — `createListing`/`updateListing` keep their existing manual `addressLine`/`city`/`latitude`/`longitude` fields for `student_room` listings. This PRD is search-only. |
| Should the resolved-pincode confirmation UI ship in phase 1? | **Yes** (unchanged from v2) — reinforced by the offices-per-pincode distribution in §2.1. |
| How to handle rows with swapped lat/lng? | **New in v3** — detect and correct before falling back to exclusion. See §5.2 step 2a. Discarding these outright would silently drop coordinate data for a meaningful number of pincodes, most concentrated in Telangana and Andhra Pradesh per the sample seen so far. |

## 4. User-Facing Behavior

### Web
- **Primary path:** user types a 6-digit pincode into the search bar. Backend resolves it to a lat/lng centroid, the UI shows a confirmation chip with the resolved city/district (e.g. "Dehradun, Uttarakhand — not right? Try another pincode"), and on confirmation the same radius search used today runs against that centroid.
- **Secondary path:** a "Use my location" button remains available and calls the browser Geolocation API exactly as today, sending `lat`/`lng` directly — no behavior change on this path, and no confirmation-chip step (GPS coordinates don't need the same sanity-check).
- If both are present in a request somehow (e.g. stale form state), **lat/lng wins** over pincode — it's the more precise signal.
- If the pincode isn't recognized, the user gets a clear error ("We don't recognize that pincode") rather than a silent unfiltered search — silently ignoring an invalid pincode and returning all listings would be misleading.
- Copy anywhere near the pincode input should avoid language implying pinpoint accuracy ("find listings near you" is fine; "find your exact location" is not) — see §2.1.

### Android
- **Unchanged.** GPS → `lat`/`lng` → same `/listings` endpoint. No pincode UI on Android for this phase.

### Applies to both student and PG-owner postings
No change needed here — `listings` already stores both `student_room` and `pg_room`/`hostel_bed` rows in one table, and the existing `searchListings` query already unions them by `listing_type` filter, not by a separate table. Resolving `pincode → lat/lng` upstream of that query means both posting types are covered automatically.

## 5. Data Model

### 5.1 New reference table: `pincodes`

One row per pincode (not per post office). Read-only reference data, refreshed rarely (India Post pincode boundaries are effectively static, though new pincodes are occasionally introduced).

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
    resolution   VARCHAR(20) NOT NULL,    -- 'priority' | 'averaged' — see §5.2
    swap_corrected BOOLEAN NOT NULL DEFAULT FALSE,  -- see §5.2 step 2a
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_pincode_format CHECK (pincode ~ '^[0-9]{6}$'),
    -- Bounding box tightened to India's actual extent (vs. a generous world
    -- box) now that we've profiled the real data: this constraint is what
    -- will catch any future seed-script regression that reintroduces
    -- swapped or garbage coordinates, so it should be as tight as is safe.
    CONSTRAINT chk_pincode_latitude  CHECK (latitude  BETWEEN 6.0  AND 38.0),
    CONSTRAINT chk_pincode_longitude CHECK (longitude BETWEEN 68.0 AND 98.0),
    CONSTRAINT chk_pincode_office_count CHECK (office_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_pincodes_location ON pincodes USING GIST (location);

-- Reuse the existing sync_location_geometry() trigger function from migration 001
-- so `location` is always derived consistently, same as listings/properties.
CREATE OR REPLACE TRIGGER trg_pincodes_sync_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON pincodes
    FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();
```

Changes from v2's DDL:
- Bounding-box constraints tightened from a generic world box to India's actual bounds (`6–38°N`, `68–98°E`), the same box used by the profiling script — this is now something we've validated our seed data against, not a placeholder.
- Added `swap_corrected BOOLEAN` so any row whose coordinates were auto-corrected from a swap (§5.2 step 2a) is flagged for audit. If the accuracy of these corrected rows is ever questioned in production, this column lets us find them instantly rather than re-deriving which rows were affected.

`pincode` remains a `CHAR(6)` primary key rather than a UUID — natural key, exact-match lookups only, no surrogate key needed for static reference data.

### 5.2 Seed / ETL script — finalized algorithm

New file: `src/db/seeds/pincodes.js`, following the exact pattern established by `src/db/seeds/amenities.js` (`ENV_FILE=.env.local node src/db/seeds/pincodes.js`, added as an npm script `seed:pincodes`).

**Confirmed against the real 165,627-row / 19,586-unique-pincode dataset:**

| Metric | Value |
|---|---|
| Rows total | 165,627 |
| Unique pincodes | 19,586 |
| Pincode format validity | 100% (all 6-digit, no malformed values) |
| `officetype` distribution | `BO`: 140,270 · `PO`: 24,546 · `HO`: 811 |
| Rows with null lat or lng | 12,015 (7.3%) |
| Rows at `(0,0)` placeholder | 13 |
| Rows outside India bounding box | 2,602 — **many of these are lat/lng swaps, not garbage (see step 2a)** |
| Pincodes with zero valid coordinates anywhere | 36 (0.18%) — these are excluded, per original rule |
| Pincodes with exactly 1 office | 2,143 |
| Pincodes with 2+ offices | 17,443 |
| Offices per pincode | min 1, median 7, mean 8.46, max 153 |

**Finalized tier vocabulary** (resolved from `officetype` combined with `officename` suffix parsing, since neither signal alone is complete — `officetype='BO'` rows can still have an `S.O`-suffixed name in a small number of cases, and the reverse):

1. **Tier 0 (highest):** `officetype == 'HO'`, or `officename` ends in `H.O`/`HO`/`G.P.O`/`GPO` (case-insensitive, tolerant of a stray leading space as seen in the data, e.g. `" NDC Lucknow Chowk Ho"`).
2. **Tier 1:** `officename` ends in `S.O`/`SO`.
3. **Tier 2:** `officename` ends in `B.O`/`BO`, or `officetype == 'BO'` with no matching suffix.
4. **Tier 3 (unranked):** anything else — falls through to averaging.

For each pincode, take the valid-coordinate rows in the lowest-numbered (highest-priority) tier that has at least one valid coordinate, and average their coordinates. If only tier 3 rows have valid coordinates, or the top tier found has more than one row, average within that tier (averaging within a tier, not just picking one row, avoids arbitrarily preferring one `HO` over another when a pincode has more than one).

**Dry-run result of this exact algorithm against the real data:**
- **15,683 pincodes (80.2%) resolved via a real priority signal** — a tier 0/1/2 row existed with valid coordinates and narrowed the candidate set below the full pool for that pincode.
- **3,867 pincodes (19.8%) fell back to full averaging** — no usable tier signal, or the tier that was found didn't narrow anything.
- **36 pincodes excluded** — zero valid coordinates anywhere (rule unchanged from v2).
- **Total pincodes seeded: 19,550.**

This is a meaningfully better outcome than v2 assumed was likely (v2 treated "mostly falls back to averaging" as the realistic default). Tiering is doing real work for 4 out of 5 pincodes.

**Step 2a — swap detection and correction (new in v3):**

2,602 rows fail the India bounding-box check (`lat` outside 6–38, or `lng` outside 68–98). Inspecting samples shows this is **not uniformly garbage**:

```
pincode      statename   latitude  longitude
 506169      TELANGANA 79.0000000 17.0000000   <- swapped: 17°N,79°E is valid Telangana
 535557 ANDHRA PRADESH 83.5297000 18.6149000   <- swapped: 18.6°N,83.5°E is valid coastal AP
```

Before excluding an out-of-bounds row, the seed script must:
1. Check whether **swapping** `latitude` and `longitude` produces a pair that falls inside the India bounding box. If so, treat the swapped pair as the corrected coordinate, set `swap_corrected = TRUE` for that row's contribution, and proceed with tiering/averaging as normal using the corrected value.
2. Only exclude a row's coordinate as unusable if **neither** the original **nor** the swapped orientation falls inside the bounding box (true garbage, e.g. `(0,0)` placeholders, or values with no plausible correction).

This needs to run **before** the tiering/averaging step in §5.2's main algorithm, since a swapped-but-correctable row is a valid coordinate for tiering purposes once fixed, not a row to be discarded.

**Unchanged from v2:**
- If **no** office in the pincode has a valid coordinate at all (after swap correction), exclude the pincode from the table entirely and log it (36 pincodes, per the table above).
- Record `office_count` and `resolution` for auditability, plus the new `swap_corrected` flag.

This is a **one-time / rarely-rerun** script, not part of the request path — no runtime dependency on the CSV file.

## 6. API Changes

### 6.1 New endpoint: pincode lookup (phase 1)

```
GET /api/v1/pincodes/:pincode
```
- Public, unauthenticated (matches the existing `rentIndexRouter` pattern — public GETs for reference/context data).
- 200 → `{ pincode, city, district, state, latitude, longitude }`
- 404 → pincode not in the table (includes both genuinely unrecognized pincodes and the 36 excluded-for-no-coordinates pincodes — both cases are equally "we can't resolve this" from the caller's perspective).
- Used by the web client to show the confirmation chip before firing the proximity search. Required for phase 1 per §2.1/§3.

*(Phase 2, still optional)* `GET /api/v1/pincodes?q=248` — prefix search for a typeahead. Deferred unless there's a strong case for it at MVP.

### 6.2 `searchListingsSchema` (src/validators/listing.validators.js)

Add, alongside the existing `lat`/`lng`/`radius` fields inside `buildKeysetPaginationQuerySchema({...})`:

```js
pincode: z.string().regex(/^\d{6}$/, { error: "pincode must be exactly 6 digits" }).optional(),
```

No refinement is added forcing pincode/lat-lng mutual exclusivity — both are legal to send; the service layer decides precedence (§6.4). This keeps the browser's two search modes (pincode vs. "use my location") from needing to coordinate on which param to omit.

### 6.3 `searchListings` service (src/services/listing.service.js) — diff against current code

The current function destructures every filter, including `lat`/`lng`, as `const` in one block, then builds the WHERE clause with a running positional-parameter counter (`p`) shared across every optional filter. `lat`/`lng` need to become mutable and resolved *before* the existing geo-clause branch, without touching that branch itself:

```js
export const searchListings = async (userId, filters) => {
	const {
		sortBy = "recent",
		city,
		minRent,
		maxRent,
		roomType,
		bedType,
		preferredGender,
		listingType,
		availableFrom,
		radius,
		amenityIds = [],
		cursorTime,
		cursorScore,
		cursorId,
		limit = 20,
	} = filters;

	// lat/lng may come directly from the client (GPS) or be resolved from a
	// pincode (web pincode-search path). lat/lng wins if both are present —
	// see PRD §6.4. Pulled out separately (not part of the destructuring
	// above) because they may be reassigned below.
	let { lat, lng } = filters;

	if ((lat === undefined || lng === undefined) && filters.pincode !== undefined) {
		const { rows: pincodeRows } = await pool.query(
			`SELECT latitude, longitude FROM pincodes WHERE pincode = $1`,
			[filters.pincode],
		);
		if (!pincodeRows.length) {
			throw new AppError("We don't recognize that pincode", 404);
		}
		({ latitude: lat, longitude: lng } = pincodeRows[0]);
	}

	const clauses = [`l.status = 'active'`, `l.deleted_at IS NULL`, `l.expires_at > NOW()`];
	const params = [];
	let p = 1;

	if (lat !== undefined && lng !== undefined) {
		// unchanged — existing ST_DWithin clause, radius param, etc.
		...
	}
	// everything else in the function (city, minRent, maxRent, roomType, ...,
	// ORDER BY, cursor handling) is untouched.
```

No changes to the `ST_DWithin` clause, the `radius` param (100–50,000m, default 5,000, unchanged), the `property.location` fallback for PG listings, or any of the other ~10 optional filters in this function.

**Cost:** a pincode-driven search costs one extra sequential DB round-trip (an indexed PK lookup on a 19,550-row static table) before the main listings query runs. Low absolute cost, but real, and should be counted in any latency budget for `/listings`.

### 6.4 Precedence rule

If a request somehow includes both `lat`/`lng` and `pincode` (e.g., stale client state), **`lat`/`lng` wins** and `pincode` is ignored — GPS/device coordinates are strictly more precise than a pincode centroid. The diff in §6.3 implements this by only attempting pincode resolution when `lat` or `lng` is missing.

### 6.5 Guest (unauthenticated) access

`GET /api/v1/listings` is mounted with `optionalAuthenticate` today, and unauthenticated requests already work with `lat`/`lng`, subject to `guestListingGate` capping `limit` to 20. Pincode search follows the same path — no new gating is introduced, and no special-casing is needed for guests vs. authenticated users on this feature.

## 7. Non-Goals

- **Listing creation is untouched.** `createListingSchema` / `updateListingSchema` keep manual `addressLine`, `city`, `locality`, `latitude`, `longitude` fields for `student_room` listings. No pincode-driven autofill there in this phase.
- **Roommate feed is untouched.** `getRoommateFeed`'s `city` filter is a `LIKE`-based text match on `listings.city`, not a proximity query — this PRD doesn't extend proximity search to it.
- **No third-party geocoding API.** Android continues to hit our own `/listings` endpoint with GPS-derived `lat`/`lng`, exactly as today.
- **No PG-vs-student special-casing.** Both listing types already live in one `listings` table and flow through one query.
- **No per-result confidence/accuracy indicator in the listings response.** Mitigation for phase 1 is the confirmation chip at the *input* stage (§6.1), not an accuracy label on each output row.
- **No attempt to correct or flag pincodes with unusually high `office_count` (e.g. the 153-office outlier) beyond what's already stored.** The `office_count` column (§5.1) makes this queryable later if it turns out to matter in practice; no proactive UI treatment is in scope now.

## 8. Open Items / Risks — updated with real numbers

| Item | Status | Resolution |
|---|---|---|
| Exact `officetype` / `officename` vocabulary | **Resolved.** `officetype` has 3 values (`BO`/`PO`/`HO`), not 2 as the earlier small sample suggested. Full tier vocabulary finalized in §5.2. | No further action — implement per §5.2. |
| Pincode-centroid accuracy in large/rural pincodes | **Confirmed, not resolved (inherent to the data).** Median 7 offices/pincode, max 153. | Phase-1 confirmation chip (§6.1) remains the mitigation. No code change eliminates this — it's a property of Indian pincode geography. |
| Pincodes with zero valid coordinates | **Resolved.** 36 pincodes (0.18%), a small and expected minority. | Excluded and logged per §5.2, as originally planned. |
| **Swapped lat/lng pairs (new finding)** | **Open — needs implementation, not just documentation.** 2,602 rows fail the bounding-box check; a sample of these are confirmed swaps, not garbage. The exact split between "correctable swap" and "true garbage" within those 2,602 rows has not yet been fully quantified. | Implement swap-detection-and-correction (§5.2 step 2a) in the seed script itself, and log counts of `corrected` vs. `still-excluded-after-swap-check` so we know the real breakdown once the script actually runs, rather than estimating it now. |
| Geographic concentration of swap errors | Open, minor | The two states seen in the sample (Telangana, Andhra Pradesh) suggest this might not be uniformly distributed. Not blocking — the swap-correction logic in §5.2 is state-agnostic and will handle it wherever it occurs — but worth a one-line note in the seed script's log output if one or two states dominate the corrected-row count, in case it points to a batch data-entry issue worth flagging back to whoever sources CSV updates in the future. |
| Extra DB round-trip on pincode-driven searches | Unchanged from v2 | Single indexed PK lookup on a 19,550-row table — low cost, but real; include in latency budgeting. |
| Caching | Unchanged from v2 | Fine to rely on the Postgres index alone at current scale; revisit only if pincode lookups become a measurable share of DB load. |

## 9. Rollout Plan

1. ~~Get the actual CSV into the project~~ — **done**; profiled via `profile_pincodes.py` against the real 165,627-row file.
2. ~~Profile `officetype` and `officename` against the real CSV~~ — **done**, results in §5.2.
3. Implement swap-detection-and-correction (§5.2 step 2a) in the seed script — **new step, not in v2's plan**, needed before the tiering logic can trust its "valid coordinate" input.
4. Migration `012_pincodes.sql` (table + constraints + index + trigger reuse) — updated DDL in §5.1, including the tightened India-specific bounding box and the new `swap_corrected` column.
5. `src/db/seeds/pincodes.js` + `npm run seed:pincodes`, run against local/dev DB. Spot-check: at least one high-office-count pincode (ideally the 153-office outlier, to see what that centroid actually looks like on a map), one single-office pincode, and a handful of the swap-corrected rows once the script logs which ones those are.
6. Add `pincodeRouter` (`GET /pincodes/:pincode`) — ship as part of phase 1.
7. Extend `searchListingsSchema` + `searchListings` service per §6.2–6.4, using the diff in §6.3.
8. Web: add pincode input as the primary search control, wired to show the confirmation chip (§4, §6.1) before firing the search; keep the existing "Use my location" button wired to the unchanged lat/lng path.
9. Android: no changes required.
10. Run the seed script against Neon (prod) as part of the next deploy. Capture and review the seed script's summary log (pincodes seeded, excluded, swap-corrected, priority vs. averaged split) before considering the migration complete — this is now a script with real branching behavior worth a human glance at its output, not a purely mechanical bulk insert.