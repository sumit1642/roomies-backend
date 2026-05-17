# Roomies — Location / Geospatial System Audit

_Continuation of `unimplemented-features-audit.md`_

---

## Part A — How Location Is Implemented in the Backend

### A1. Database Schema — Two Column Approach

Every row in `listings` and `properties` carries **three** location representations simultaneously:

```sql
-- From migration 001_initial_schema.sql
latitude  NUMERIC(10, 7),   -- raw decimal degrees, human-readable
longitude NUMERIC(10, 7),   -- raw decimal degrees
location  GEOMETRY(POINT, 4326)  -- PostGIS geometry, SRID 4326 (WGS84)
```

The `location` geometry column is kept automatically in sync with `latitude`/`longitude` via a
**`BEFORE INSERT OR UPDATE` trigger**:

```sql
CREATE OR REPLACE FUNCTION sync_location_geometry()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326);
    ELSE
        NEW.location = NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Critical detail:** `ST_MakePoint` takes `(longitude, latitude)` — not `(lat, lng)`. This matches the GeoJSON/WGS84
convention where X = longitude, Y = latitude. The trigger fires on updates to `latitude` or `longitude` columns only:

```sql
CREATE TRIGGER trg_listings_sync_location
BEFORE INSERT OR UPDATE OF latitude, longitude ON listings
FOR EACH ROW EXECUTE FUNCTION sync_location_geometry();
```

GiST spatial indexes are created on the `location` column:

```sql
CREATE INDEX IF NOT EXISTS idx_listings_location ON listings USING GIST (location)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_location ON properties USING GIST (location)
WHERE deleted_at IS NULL;
```

Both are **partial indexes** (`WHERE deleted_at IS NULL`) — this is correct and efficient since soft-deleted rows are
excluded from all spatial queries.

---

### A2. Proximity Search — `searchListings`

In `listing.service.js`, when `lat` and `lng` are provided:

```js
if (lat !== undefined && lng !== undefined) {
	const pointExpr = `ST_SetSRID(ST_MakePoint($${p + 1}, $${p}), 4326)::geography`;
	clauses.push(`(
    (l.location IS NOT NULL AND ST_DWithin(l.location::geography, ${pointExpr}, $${p + 2}))
    OR
    (l.location IS NULL AND p.location IS NOT NULL AND ST_DWithin(p.location::geography, ${pointExpr}, $${p + 2}))
  )`);
	params.push(lat, lng, radius);
	p += 3;
}
```

**What happens here, step by step:**

1. `ST_MakePoint($lng, $lat)` — creates a point. Note parameter order: `$${p+1}` = `lng`, `$${p}` = `lat`. The
   `params.push(lat, lng, radius)` pushes them as `[lat, lng, radius]` so `$p` = `lat`, `$p+1` = `lng`. This means
   `ST_MakePoint($p+1, $p)` = `ST_MakePoint(lng, lat)`. **This is correct.**

2. `ST_SetSRID(..., 4326)` — assigns WGS84 coordinate system.

3. `::geography` cast on **both** sides — this switches from planar geometry to spherical geography. Distance is now in
   **metres**, not degrees. This is the correct approach for real-world distance queries in India where distortion from
   flat projections is non-trivial at scale.

4. Listings without their own coordinates (pg_room / hostel_bed) fall back to the property's geometry via the separate
   `OR` branch.

5. The radius parameter accepts metres, default 5,000 (5 km), max 50,000 (50 km) — validated in `searchListingsSchema`.

**Index usage verification:**

The `GIST` index on `location GEOMETRY(POINT, 4326)` **will be used** for the `::geography` cast in `ST_DWithin` because
PostGIS's geography index is backed by the same GiST structure and the planner knows to use it. This is confirmed by the
PostGIS documentation: `ST_DWithin(geography, geography, distance_meters)` uses the geography index.

---

### A3. Rent Index — Location-Aware Aggregation

`rent_observations` stores `city`, `locality` (normalised to `LOWER(TRIM(...))`) and `room_type`. The `rent_index`
materialised table is refreshed nightly by a cron job with a 180-day rolling window. There is **no PostGIS geometry in
rent_index** — it's purely text-based city/locality matching.

The listing search joins rent_index by:

```sql
LEFT JOIN rent_index ri_loc
  ON ri_loc.city      = l.city
 AND ri_loc.locality  = NULLIF(LOWER(TRIM(COALESCE(l.locality, ''))), '')
 AND ri_loc.room_type = l.room_type
```

This is case-sensitive at the `=` level but both sides are already lowercased at insert time via the
`capture_rent_observation` trigger. Works correctly.

---

### A4. Property Location Cascade

When a property's address is updated (`updateProperty`), the backend **cascades location fields to all linked
listings**:

```js
const changedLocationColumns = setClauses
	.map((clause) => clause.split(" = ")[0].trim())
	.filter((col) => col in LOCATION_CASCADE_MAP);
```

If any of `city`, `address_line`, `locality`, `landmark`, `pincode`, `latitude`, `longitude` change on the property, the
same values are pushed to all `pg_room` and `hostel_bed` listings linked to that property. The geometry re-sync is
handled by the trigger on the listings table when `latitude`/`longitude` are updated.

---

### A5. Roommate Feed — City Text Filter (No Geometry)

The roommate feed in `roommate.service.js` uses a **text LIKE filter** on listings, not PostGIS:

```sql
EXISTS (
    SELECT 1 FROM listings l
    WHERE l.posted_by = sp.user_id
      AND l.deleted_at IS NULL
      AND l.status = 'active'
      AND LOWER(l.city) LIKE LOWER($p) ESCAPE '\'
)
```

There is no geometry/geography involved in roommate matching — it is purely city-name substring matching. This means a
search for "Pune" also matches "New Pune" or "Pune City".

---

### A6. Coordinate Validation

Input coordinates are validated via Zod in `listing.validators.js` and `property.validators.js`:

```js
const latitudeSchema = coordinateSchema(-90, 90, "Latitude");
const longitudeSchema = coordinateSchema(-180, 180, "Longitude");
```

Cross-field refinement ensures both or neither are provided:

```js
.refine(data => !(data.latitude !== undefined && data.longitude === undefined), {
    error: 'longitude is required when latitude is provided',
})
```

For pg_room / hostel_bed listings, coordinates are **explicitly blocked** at the API layer — the listing validator
rejects them entirely and relies on property coordinates instead:

```js
.refine(data =>
    data.listingType === 'student_room' ||
    (data.latitude === undefined && data.longitude === undefined),
    { error: 'Coordinates are not accepted for pg_room or hostel_bed listings' }
)
```

---

## Part B — Verification Against PostGIS Best Practices

| Practice                                                         | Backend Status                                                                       | Assessment                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use `geography` type (not raw `geometry`) for distance in metres | ✅ `::geography` cast in `ST_DWithin`                                                | Correct. `GEOMETRY(POINT, 4326)` stored, cast to `::geography` at query time. Saves storage vs native geography column while still getting metre-accurate distances. |
| GiST index on spatial column                                     | ✅ `USING GIST (location)`                                                           | Correct. Partial index (`WHERE deleted_at IS NULL`) is optimal.                                                                                                      |
| `ST_MakePoint(lng, lat)` order                                   | ✅ `ST_MakePoint($lng, $lat)`                                                        | Correct. X=longitude, Y=latitude per WGS84/GeoJSON convention.                                                                                                       |
| Assign SRID before spatial operations                            | ✅ `ST_SetSRID(..., 4326)`                                                           | Correct.                                                                                                                                                             |
| Trigger for geometry sync                                        | ✅ `sync_location_geometry()` fires `BEFORE INSERT OR UPDATE OF latitude, longitude` | Correct and efficient (only fires when coord columns change).                                                                                                        |
| Radius in metres for geography `ST_DWithin`                      | ✅ `radius` param validated 100–50,000 m                                             | Correct. With `::geography`, the third arg is metres.                                                                                                                |
| Avoid `ST_Distance` in WHERE clause (not index-safe)             | ✅ Not used in WHERE                                                                 | Correct. `ST_DWithin` uses the index; `ST_Distance` in WHERE would cause full scan.                                                                                  |

### B1. Missing `ORDER BY ST_Distance` for "Nearest First" Results

The current search sorts by `l.created_at DESC` always. When a user searches "within 5 km", results are sorted by
recency, not proximity. A listing 200 m away posted two weeks ago appears below one 4.9 km away posted today.

The `ST_Distance(..., $point)` expression could be added as a secondary sort but would require a consistent distance
expression for both listing and property locations.

This would also break cursor-based pagination (which currently uses `cursorTime` + `cursorId`) — a distance-based cursor
requires a different pagination strategy (e.g., `cursor_distance` + `cursor_id`).

### B2. Neon Serverless + PostGIS

Neon's serverless PostgreSQL includes PostGIS. The `CREATE EXTENSION IF NOT EXISTS postgis` in migration 001 works
correctly on Neon. However, Neon's auto-suspend feature (free tier: suspends after 5 minutes of inactivity) means the
first PostGIS query after a cold start may be slow while the extension re-initialises its internal state. This is not a
bug but worth noting for UX — the first proximity search after inactivity may take 2–5 seconds.

---

## Part C — Frontend: Current State (Nothing Implemented)

The location feature is **completely absent from the frontend**. Here is the current gap map:

| Feature                                          | Backend                            | Frontend                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Proximity search (`lat`, `lng`, `radius` params) | ✅ Fully implemented               | ❌ No UI. The `searchListingsSchema` on the frontend has `lat?`, `lng?`, `radius?` in `ListingSearchParams` but `browse.tsx` never passes them. |
| Coordinate input for `student_room` listings     | ✅ Accepted and stored             | ❌ The listing creation form in `listings.tsx` has no lat/lng fields                                                                            |
| "Near me" button                                 | ❌ Does not exist                  | ❌ Does not exist                                                                                                                               |
| Map display                                      | ❌ No map rendering                | ❌ No map rendering                                                                                                                             |
| Distance shown on card                           | ❌ Not returned in search response | ❌ Not rendered                                                                                                                                 |
| City-text search                                 | ✅ `LOWER(city) LIKE $city%`       | ✅ Wired to city input in browse.tsx                                                                                                            |
| Rent index context                               | ✅ `rentDeviation` in response     | ❌ Never rendered (covered in main audit)                                                                                                       |

---

## Part D — Frontend System Design: Full Location Implementation

Below is a complete, production-ready design for adding location features to the Roomies frontend. All components are
designed for SSR compatibility with TanStack Start, caching with TanStack Query, and graceful degradation for Android
clients.

---

### D1. Location State Hook

Create `src/hooks/useUserLocation.ts`:

```ts
// src/hooks/useUserLocation.ts
import { useState, useCallback, useRef } from "react";

type LocationState =
	| { status: "idle" }
	| { status: "requesting" }
	| { status: "granted"; lat: number; lng: number; accuracy: number }
	| { status: "denied"; reason: "permission" | "unavailable" | "timeout" }
	| { status: "unsupported" };

const GEOLOCATION_OPTIONS: PositionOptions = {
	enableHighAccuracy: false, // false = cell/wifi, faster & less battery drain
	timeout: 8000, // 8 s — generous for India mobile networks
	maximumAge: 5 * 60 * 1000, // reuse cached position up to 5 min old
};

export function useUserLocation() {
	const [state, setState] = useState<LocationState>({ status: "idle" });
	const hasRequested = useRef(false);

	const requestLocation = useCallback(async (): Promise<LocationState> => {
		// Guard: only one inflight request at a time
		if (state.status === "requesting") return state;

		if (typeof navigator === "undefined" || !navigator.geolocation) {
			const next: LocationState = { status: "unsupported" };
			setState(next);
			return next;
		}

		// Check permission status first — avoids surprising the user on second click
		if ("permissions" in navigator) {
			try {
				const perm = await navigator.permissions.query({ name: "geolocation" });
				if (perm.state === "denied") {
					const next: LocationState = { status: "denied", reason: "permission" };
					setState(next);
					return next;
				}
			} catch {
				// Permissions API not available in all browsers — proceed anyway
			}
		}

		setState({ status: "requesting" });
		hasRequested.current = true;

		return new Promise((resolve) => {
			navigator.geolocation.getCurrentPosition(
				(position) => {
					const next: LocationState = {
						status: "granted",
						lat: position.coords.latitude,
						lng: position.coords.longitude,
						accuracy: position.coords.accuracy, // metres
					};
					setState(next);
					resolve(next);
				},
				(error) => {
					const reason =
						error.code === GeolocationPositionError.PERMISSION_DENIED ? "permission"
						: error.code === GeolocationPositionError.TIMEOUT ? "timeout"
						: "unavailable";
					const next: LocationState = { status: "denied", reason };
					setState(next);
					resolve(next);
				},
				GEOLOCATION_OPTIONS,
			);
		});
	}, [state]);

	const clear = useCallback(() => setState({ status: "idle" }), []);

	return { locationState: state, requestLocation, clear };
}
```

**Why `enableHighAccuracy: false`?** On mobile networks in India, GPS lock can take 15–30 seconds. Cell/WiFi
triangulation is accurate to ~300 m — more than sufficient for a 5 km radius search. This avoids battery drain and the
long wait.

**Why `maximumAge: 5 * 60 * 1000`?** The browser caches the position for 5 minutes. If the user runs two searches, the
second request resolves instantly without a new GPS poll.

---

### D2. Location Persistence (Cross-Session)

Cache the last known location in `sessionStorage` so it survives a page refresh within the same tab:

```ts
// src/lib/locationStorage.ts

const KEY = "roomies_last_location";

export interface StoredLocation {
	lat: number;
	lng: number;
	accuracy: number;
	storedAt: number; // epoch ms
}

const MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

export const locationStorage = {
	save(lat: number, lng: number, accuracy: number) {
		try {
			const data: StoredLocation = { lat, lng, accuracy, storedAt: Date.now() };
			sessionStorage.setItem(KEY, JSON.stringify(data));
		} catch {
			/* sessionStorage blocked in private mode */
		}
	},

	load(): StoredLocation | null {
		try {
			const raw = sessionStorage.getItem(KEY);
			if (!raw) return null;
			const data: StoredLocation = JSON.parse(raw);
			if (Date.now() - data.storedAt > MAX_AGE_MS) {
				sessionStorage.removeItem(KEY);
				return null;
			}
			return data;
		} catch {
			return null;
		}
	},

	clear() {
		try {
			sessionStorage.removeItem(KEY);
		} catch {}
	},
};
```

Update `useUserLocation` to initialise from storage and save on success:

```ts
// Add to useUserLocation.ts
import { locationStorage } from '@/lib/locationStorage';

// In the hook body, initialise state from storage:
const [state, setState] = useState<LocationState>(() => {
  const stored = locationStorage.load();
  if (stored) {
    return { status: 'granted', lat: stored.lat, lng: stored.lng, accuracy: stored.accuracy };
  }
  return { status: 'idle' };
});

// In the success callback:
const next: LocationState = { status: 'granted', ... };
locationStorage.save(position.coords.latitude, position.coords.longitude, position.coords.accuracy);
setState(next);
```

---

### D3. "Near Me" Button Component

Create `src/components/NearMeButton.tsx`:

```tsx
// src/components/NearMeButton.tsx
import { MapPin, Loader2, MapPinOff } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useUserLocation } from "#/hooks/useUserLocation";
import { toast } from "#/components/ui/sonner";

interface NearMeButtonProps {
	/** Called with coordinates when location is granted */
	onLocation: (lat: number, lng: number) => void;
	/** Called when user clears location filter */
	onClear: () => void;
	isActive: boolean;
	radiusKm?: number;
}

export function NearMeButton({ onLocation, onClear, isActive, radiusKm = 5 }: NearMeButtonProps) {
	const { locationState, requestLocation, clear } = useUserLocation();

	const handleClick = async () => {
		if (isActive) {
			clear();
			onClear();
			return;
		}

		const result = await requestLocation();

		if (result.status === "granted") {
			onLocation(result.lat, result.lng);
		} else if (result.status === "denied" && result.reason === "permission") {
			toast.error("Location access denied", {
				description: "Enable location in your browser settings, or enter a city name manually.",
			});
		} else if (result.status === "denied" && result.reason === "timeout") {
			toast.error("Location request timed out", {
				description: "Try again or search by city name instead.",
			});
		} else if (result.status === "unsupported") {
			toast.error("Location not available", {
				description: "Your browser does not support location access. Search by city name instead.",
			});
		}
	};

	const isLoading = locationState.status === "requesting";

	return (
		<Button
			variant={isActive ? "default" : "outline"}
			size="sm"
			onClick={handleClick}
			disabled={isLoading}
			className="gap-2 shrink-0"
			title={
				isActive ?
					`Showing listings within ${radiusKm} km of your location. Click to clear.`
				:	"Search near my location"
			}>
			{isLoading ?
				<Loader2 className="size-4 animate-spin" />
			: isActive ?
				<MapPinOff className="size-4" />
			:	<MapPin className="size-4" />}
			{isLoading ?
				"Locating..."
			: isActive ?
				`Within ${radiusKm} km`
			:	"Near Me"}
		</Button>
	);
}
```

---

### D4. Browse Page Integration (`browse.tsx`)

The existing filter state needs three new fields:

```ts
// Add to ListingFilters or use a local extension:
interface GeoFilter {
	lat?: number;
	lng?: number;
	radius: number; // metres, default 5000
}
```

In `browse.tsx`, add `geoFilter` state and wire it to the search:

```tsx
// --- New state ---
const [geoFilter, setGeoFilter] = useState<GeoFilter>({ radius: 5000 });

// --- Pass to searchListings ---
queryFn: async ({ pageParam }) => {
  return searchListings({
    ...activeFiltersKey,
    lat: geoFilter.lat,
    lng: geoFilter.lng,
    radius: geoFilter.lat !== undefined ? geoFilter.radius : undefined,
    limit: 20,
    cursorTime: pageParam?.cursorTime,
    cursorId: pageParam?.cursorId,
  });
},

// --- Query key must include geoFilter to bust cache on location change ---
queryKey: queryKeys.listings({ ...activeFiltersKey, geo: geoFilter }),
```

Add the `NearMeButton` and a radius slider to the search bar row:

```tsx
<div className="flex flex-col sm:flex-row gap-3">
	{/* City search */}
	<div className="relative flex-1">
		<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
		<Input
			placeholder="Search by city..."
			value={tempFilters.city || ""}
			onChange={(e) => setTempFilters((prev) => ({ ...prev, city: e.target.value }))}
			onKeyDown={(e) => e.key === "Enter" && handleApplyFilters()}
			className="pl-10"
		/>
	</div>

	{/* Near Me — clears city filter when active (location and city are mutually exclusive) */}
	<NearMeButton
		isActive={geoFilter.lat !== undefined}
		onLocation={(lat, lng) => {
			setGeoFilter({ lat, lng, radius: 5000 });
			setFilters((prev) => ({ ...prev, city: "" })); // Clear city when using geo
			setTempFilters((prev) => ({ ...prev, city: "" }));
		}}
		onClear={() => setGeoFilter({ radius: 5000 })}
	/>

	{/* Radius selector (shown only when geo active) */}
	{geoFilter.lat !== undefined && (
		<Select
			value={String(geoFilter.radius)}
			onValueChange={(v) => setGeoFilter((prev) => ({ ...prev, radius: Number(v) }))}>
			<SelectTrigger className="w-28">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="1000">1 km</SelectItem>
				<SelectItem value="3000">3 km</SelectItem>
				<SelectItem value="5000">5 km</SelectItem>
				<SelectItem value="10000">10 km</SelectItem>
				<SelectItem value="20000">20 km</SelectItem>
			</SelectContent>
		</Select>
	)}

	<Button
		variant="outline"
		onClick={() => setShowFilters(!showFilters)}>
		<Filter className="mr-2 h-4 w-4" />
		Filters
	</Button>
	<Button onClick={handleApplyFilters}>Search</Button>
</div>
```

**City vs. Geo mutual exclusivity:** The backend accepts both `city` and `lat/lng` simultaneously, but the query would
be oddly restrictive. The UX convention for discovery apps is to use one or the other — clearing city when geo is
activated, and clearing geo when city is typed.

---

### D5. Listing Card — Distance Display

The backend does not currently return the computed distance in the search response. To show "2.3 km away" on cards,
either:

**Option A (recommended for Tier 0): Client-side calculation**

```ts
// src/lib/distance.ts
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const R = 6371; // Earth radius km
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLng = ((lng2 - lng1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
	return R * 2 * Math.asin(Math.sqrt(a));
}

export function formatDistance(km: number): string {
	if (km < 1) return `${Math.round(km * 1000)} m away`;
	return `${km.toFixed(1)} km away`;
}
```

In the listing card, when `geoFilter.lat` is defined and `listing.latitude`/`listing.longitude` are present:

```tsx
{
	geoFilter.lat !== undefined && listing.latitude && listing.longitude && (
		<div className="flex items-center gap-1 text-xs text-muted-foreground">
			<MapPin className="size-3" />
			{formatDistance(haversineKm(geoFilter.lat!, geoFilter.lng!, listing.latitude, listing.longitude))}
		</div>
	);
}
```

**Option B (future): Add `ST_Distance` to backend response**

```sql
-- Add to searchListings SELECT:
ROUND(
    ST_Distance(
        COALESCE(l.location, p.location)::geography,
        ST_SetSRID(ST_MakePoint($lng, $lat), 4326)::geography
    )
)::int AS distance_metres
```

This requires adding `distanceMetres` to the response type and only populates when a proximity search is active. Option
A avoids a backend change and works for all devices including Android.

---

### D6. Student Room Listing Creation — Coordinate Input

The `ListingForm` in `listings.tsx` needs lat/lng fields for `student_room` type listings. The cleanest UX is an
address-lookup field with a "Use My Location" button:

```tsx
{
	formData.listingType === "student_room" && (
		<div className="space-y-3">
			<Label>Location (Optional)</Label>
			<p className="text-xs text-muted-foreground">
				Adding coordinates lets students find you in proximity searches
			</p>

			<div className="flex gap-2">
				<Input
					placeholder="Latitude (e.g. 18.5204)"
					type="number"
					step="any"
					value={formData.latitude ?? ""}
					onChange={(e) =>
						onChange({
							...formData,
							latitude: e.target.value ? parseFloat(e.target.value) : undefined,
						})
					}
				/>
				<Input
					placeholder="Longitude (e.g. 73.8567)"
					type="number"
					step="any"
					value={formData.longitude ?? ""}
					onChange={(e) =>
						onChange({
							...formData,
							longitude: e.target.value ? parseFloat(e.target.value) : undefined,
						})
					}
				/>
			</div>

			<NearMeButton
				isActive={formData.latitude !== undefined}
				onLocation={(lat, lng) => onChange({ ...formData, latitude: lat, longitude: lng })}
				onClear={() => onChange({ ...formData, latitude: undefined, longitude: undefined })}
				radiusKm={0} // not a search, just setting point
			/>

			{formData.latitude && formData.longitude && (
				<p className="text-xs text-emerald-600">
					📍 {formData.latitude.toFixed(4)}, {formData.longitude.toFixed(4)}
				</p>
			)}
		</div>
	);
}
```

---

### D7. Listing Detail Page — Map Embed

Show a static map on the listing detail page. Since the app currently has no map library dependency, the cheapest
approach is an `<iframe>` embed from OpenStreetMap (no API key required):

```tsx
// In listing.$id.tsx, inside the property card:
{
	listing.latitude && listing.longitude && (
		<div className="mt-4 rounded-lg overflow-hidden border border-border">
			<iframe
				title="Listing location"
				width="100%"
				height="200"
				loading="lazy"
				referrerPolicy="no-referrer"
				src={`https://www.openstreetmap.org/export/embed.html?bbox=${
					listing.longitude - 0.005
				}%2C${listing.latitude - 0.005}%2C${
					listing.longitude + 0.005
				}%2C${listing.latitude + 0.005}&layer=mapnik&marker=${listing.latitude}%2C${listing.longitude}`}
			/>
			<a
				href={`https://www.openstreetmap.org/?mlat=${listing.latitude}&mlon=${listing.longitude}#map=15/${listing.latitude}/${listing.longitude}`}
				target="_blank"
				rel="noreferrer"
				className="block text-xs text-center text-muted-foreground py-1 hover:text-foreground">
				View larger map →
			</a>
		</div>
	);
}
```

This adds **zero JavaScript bundle cost** and works offline-first (OSM tiles cache in the browser). For production,
consider adding `<meta name="referrer" content="no-referrer">` to avoid leaking the user's session URL in the OSM
request.

---

### D8. Caching Strategy for Proximity Searches

Location-based queries must not be shared across different user locations. The query key structure already handles this
if `geoFilter` is included:

```ts
queryKey: queryKeys.listings({
  ...activeFiltersKey,
  geo: geoFilter.lat !== undefined
    ? { lat: Math.round(geoFilter.lat * 100) / 100,  // round to ~1 km precision
        lng: Math.round(geoFilter.lng! * 100) / 100,
        radius: geoFilter.radius }
    : undefined,
}),
```

**Why round coordinates?** `lat: 18.520412` and `lat: 18.520489` produce different cache keys but would return identical
results from a 5 km radius search. Rounding to 2 decimal places (~1 km precision) means the cache is reused when the
user moves a few metres between searches.

**staleTime for geo searches:** Use a shorter stale time than the default feed:

```ts
staleTime: geoFilter.lat !== undefined ? STALE.TRANSACTIONAL : STALE.FEED,
```

Location data can change (new listings posted nearby), and the user's intent when doing a proximity search is to see
current results.

---

### D9. Android Specific Implementation Notes

| Aspect                       | Guidance                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission request           | Must call `PermissionsAndroid.request(ACCESS_FINE_LOCATION)` before any geolocation call on Android 6+. Use `ACCESS_COARSE_LOCATION` first (cell/WiFi, faster) then upgrade to `ACCESS_FINE_LOCATION` only if user requests higher accuracy. |
| Coordinate order to API      | Send `lat` and `lng` as separate query params. Do **not** send GeoJSON `[lng, lat]` — the backend validates them individually as `z.coerce.number().min(-90).max(90)` for lat and `z.coerce.number().min(-180).max(180)` for lng.            |
| Radius param                 | Integer metres. Default 5000 if omitted. Max 50000 enforced by backend validator (`z.coerce.number().int().min(100).max(50_000)`). Send as string in query param — the validator uses `z.coerce.number()`.                                   |
| Null coordinates in response | `listing.latitude` and `listing.longitude` will be `null` for pg_room/hostel_bed listings (coordinates live on the property). Android must handle null coordinates gracefully — no crash, just skip the map pin.                             |
| `location` geometry field    | The `location` field from `GEOMETRY(POINT, 4326)` is **never returned in any API response** — it stays internal to PostGIS. Android only ever sees `latitude`/`longitude` as numeric decimals.                                               |
| Mock location                | Android API >= 18 adds `mocked: boolean` to position — log this in dev to detect emulator coordinates accidentally sent to production.                                                                                                       |
| Background location          | Do **not** request background location (`ACCESS_BACKGROUND_LOCATION`). The app only needs location during active search — use `whenInUse` equivalent.                                                                                        |

---

## Part E — Backend Fixes Required

The following backend changes are needed to fully support the frontend design above:

### E1. Add `distance_metres` to Search Response (Optional, Future)

When a proximity search is active, add the computed distance so clients don't have to compute it client-side:

```sql
CASE
    WHEN $lat IS NOT NULL THEN
        ROUND(ST_Distance(
            COALESCE(l.location, p.location)::geography,
            ST_SetSRID(ST_MakePoint($lng, $lat), 4326)::geography
        ))::int
    ELSE NULL
END AS distance_metres
```

### E2. Add `ORDER BY distance` Option

Add a `sortBy: 'distance'` option alongside the existing `'recent'` and `'compatibility'`. This requires a new cursor
strategy since `cursorTime` won't work for distance-sorted results — use `cursor_distance` (integer metres) +
`cursor_id` instead.

---

## Part F — Summary Priority Matrix (Location)

| Priority  | Item                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 🟠 High   | `lat`/`lng`/`radius` params are validated in backend and types but never passed from `browse.tsx` — implement `NearMeButton` + state |
| 🟠 High   | No map shown on listing detail page — add OSM iframe embed                                                                           |
| 🟠 High   | No coordinate input for `student_room` listing creation                                                                              |
| 🟡 Medium | Distance not displayed on listing cards — implement client-side Haversine when geo search is active                                  |
| 🟡 Medium | Roommate feed city filter is a text LIKE — no geo component, no proximity option                                                     |
| 🟡 Medium | No `sortBy: 'distance'` option — requires backend cursor strategy change                                                             |
| 🔵 Low    | `enableHighAccuracy: false` in `useUserLocation` — fine for discovery, document the decision                                         |
| 🔵 Low    | Neon cold-start latency on first PostGIS query after sleep — show skeleton/loading state                                             |
| 🔵 Low    | Android: document `lat`/`lng` param order and null coordinate handling                                                               |
