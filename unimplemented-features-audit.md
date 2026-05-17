# Roomies — Unimplemented / Partially-Implemented Features Audit

**Stack:** TanStack Start (React, TanStack Router, TanStack Query) · Express backend · PostgreSQL (Neon) · Redis
(Upstash) · Azure Blob · Render (Tier 0)

---

## 1. Backend Endpoints with Zero Frontend Coverage

These routes exist, are fully implemented in the backend, and are never called from the frontend codebase.

| Endpoint                                                                | Backend File                  | Issue                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /rent-index`                                                       | `rentIndex.service.js`        | `rentIndex.ts` client exists, but no component ever calls it. The listing detail page shows `rentDeviation` and `rentIndex` from the detail response but never fetches the dedicated endpoint for comparison context.                                                                                    |
| `GET /listings/:id/analytics`                                           | `listingAnalytics.service.js` | Client function `getListingAnalytics` exists in `listings.ts` but is never rendered anywhere. PG owners have no analytics view.                                                                                                                                                                          |
| `POST /listings/:id/renew`                                              | `listingRenewal.service.js`   | Client function `renewListing` exists but no UI calls it. Listings expire after 60 days with no way for owners to renew from the frontend.                                                                                                                                                               |
| `GET /ratings/me/given`                                                 | `rating.service.js`           | `getMyGivenRatings` client exists, never rendered. No "My Reviews" page.                                                                                                                                                                                                                                 |
| `GET /ratings/user/:userId`                                             | `rating.service.js`           | `getPublicUserRatings` exists but is only used in the connection detail for the student's own rating — not for a standalone public profile page.                                                                                                                                                         |
| `GET /students/roommates` (with `city` filter)                          | `roommate.service.js`         | The feed is fetched but the city filter param is built in `RoommateFeedParams` and passed as `sortBy`/cursor — **the `city` param is never wired to a UI input**. The filter silently does nothing.                                                                                                      |
| `DELETE /students/:userId/block/:targetUserId`                          | `roommate.service.js`         | `unblockUser` client function exists but is never called. There is no "manage blocks" or "unblock" UI anywhere.                                                                                                                                                                                          |
| `PUT /students/:userId/roommate-profile` (roommateBio field)            | same                          | The `roommateBio` field in the request body is accepted by the backend but the profile edit form never surfaces a text area for it.                                                                                                                                                                      |
| `GET /auth/sessions` → `DELETE /auth/sessions/:sid`                     | `auth.service.js`             | Partially implemented (sessions page exists) but `sessions.tsx` uses `useQuery` without a mutation for the `revokeMutation` — it calls `revokeSession` directly inside `useMutation` correctly, so this is fine. ✅                                                                                      |
| `GET /students/:userId/contact/reveal`                                  | `student.service.js`          | Only called inside `StudentDetailModal` in `listings.tsx` and `connections.tsx` — not on any public-facing student profile page.                                                                                                                                                                         |
| `POST /pg-owners/:userId/contact/reveal`                                | `pgOwner.service.js`          | `revealPgOwnerContact` client exists but is **never called** from any component.                                                                                                                                                                                                                         |
| `GET /amenities`                                                        | `amenities.js` route          | Fetched by `AmenityPicker` and `PreferencePicker` components but **never cached via TanStack Query** — each component mounts a bare `useEffect` + `useState`, so every remount triggers a fresh network call. There is a `queryKeys.amenities()` key defined but `useQuery` is never used for amenities. |
| `GET /preferences/meta`                                                 | `preferences.js` route        | Same issue as amenities — `PreferencePicker` uses raw `useEffect` instead of `useQuery`, losing all caching.                                                                                                                                                                                             |
| `GET /ratings/connection/:connectionId`                                 | `rating.service.js`           | `queryKeys.connectionRatings(id)` is defined but `useQuery` is never called with it. The connections page fetches ratings inside a `Promise.all` inside a `useEffect` inside the detail modal — no cache, no deduplication.                                                                              |
| `POST /auth/google/callback`                                            | `auth.service.js`             | `googleCallback` client is implemented but the register and login pages only show a toast "Google Sign-In coming soon" — the actual OAuth flow is stubbed out.                                                                                                                                           |
| `GET /rent-index` (listing search)                                      | `listing.service.js`          | `rentDeviation` is returned in the search response and the field is in the TypeScript type, but **the browse page never renders it**. The listing detail page also has it in `ListingDetail` type but no UI component displays it to the user.                                                           |
| Admin routes (`/verification/queue`, `/reports/queue`, `resolveReport`) | multiple controllers          | No admin panel exists in the frontend at all.                                                                                                                                                                                                                                                            |

---

## 2. Frontend Fetch Correctness Issues

### 2a. Data Not Updating After Mutations

| Location                                               | What Happens                                                                                                                                                                                                                                                                                                                          | What Should Happen                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `properties.tsx` — create/update/delete property       | Calls `fetchProperties()` directly (a plain async fn re-assigning state) — not tied to TanStack Query at all.                                                                                                                                                                                                                         | Should use `useMutation` + `qc.invalidateQueries({ queryKey: queryKeys.properties() })` so the dashboard active-listing counts also stay in sync.                                         |
| `listings.tsx` — create listing, toggle status, delete | Same pattern — raw `fetchData()` re-fetch. No query cache involvement.                                                                                                                                                                                                                                                                | Should use `useMutation` + invalidate `queryKeys.listings(...)` and `queryKeys.properties()` (because `active_listing_count` changes).                                                    |
| `listing.$id.tsx` — save/unsave                        | Calls `saveListing`/`unsaveListing` directly, then `setIsSaved` locally.                                                                                                                                                                                                                                                              | Should invalidate `queryKeys.savedListings()` so browse page and dashboard counts stay consistent. Currently browse page and this page can show opposite saved states after a navigation. |
| `browse.tsx` — save/unsave                             | Correctly invalidates `queryKeys.savedListings()` via `useMutation` ✅                                                                                                                                                                                                                                                                | —                                                                                                                                                                                         |
| `profile.tsx` — update student/pg owner profile        | Calls `updateStudentProfile` directly, sets local `profile` state, but **never** invalidates `queryKeys.studentProfile(userId)` or `queryKeys.pgOwnerProfile(userId)`. Dashboard's `useQuery` for the same profile will remain stale.                                                                                                 | Should call `qc.invalidateQueries({ queryKey: queryKeys.studentProfile(userId) })` on success.                                                                                            |
| `preferences.tsx` — update preferences                 | Calls `updateStudentPreferences` with no cache invalidation. Compatibility scores shown in browse and listing detail depend on preferences but won't re-compute client-side.                                                                                                                                                          | Invalidate the listings feed queries on preference update so scores refresh.                                                                                                              |
| `interests.tsx` — withdraw interest                    | Updates local state correctly but doesn't invalidate `queryKeys.interests(...)`. If user navigates away and back, the count in dashboard will be wrong.                                                                                                                                                                               | Add `qc.invalidateQueries({ queryKey: queryKeys.interests() })`.                                                                                                                          |
| `connections.tsx` — confirm connection                 | `confirmMutation` correctly invalidates connections ✅. But the rating dialog calls `submitRating` without invalidating `queryKeys.connectionRatings(connectionId)` or `queryKeys.connections()`. After rating, the "You have rated this connection" guard relies only on local `ratedConnectionIds` state — cleared on page refresh. | Persist rated state via query cache or re-fetch connection detail after rating.                                                                                                           |

### 2b. Wrong or Missing Data Displayed

| Location                                 | Problem                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listing.$id.tsx` — `isSaved` state      | Initialised to `false`, never hydrated from the saved-listings cache. A user who has already saved a listing and navigates to it will see an empty heart until they save/unsave again. Should initialise from `savedIds` (already available in browse page logic).                                                                                    |
| `saved.tsx` — `listing.rentPerMonth`     | Correctly uses the camelCase field from `SavedListingItem` ✅.                                                                                                                                                                                                                                                                                        |
| `connections.tsx` — `ratedConnectionIds` | Pure local state — wiped on refresh. No persistence. After a page reload the "Rate" button re-appears even if the user already rated.                                                                                                                                                                                                                 |
| `dashboard.tsx` — active listing count   | Reads `active_listing_count` from `propertiesData` which is fetched fresh. But property mutations (in `properties.tsx`) don't invalidate the `queryKeys.properties()` query on the dashboard because both pages use separate component-level state. After adding a listing in `listings.tsx` the dashboard count doesn't update until manual refresh. |
| `browse.tsx` — `rentDeviation`           | The field exists in `ListingSearchItem` but is never rendered anywhere in the card. Users have no indication of whether a price is above or below market.                                                                                                                                                                                             |
| `roommates.tsx` — `roommateBio`          | Backend returns `roommateBio` in the feed items but `RoommateProfile` type and the `RoommateCard` component never render it — only `bio` (regular bio) is shown.                                                                                                                                                                                      |

---

## 3. Cache Architecture Problems

### 3a. Bypassing TanStack Query Entirely

The following pages/components use raw `useEffect` + `useState` for data fetching and therefore get **zero** caching,
deduplication, background refetch, or stale-while-revalidate:

- `src/routes/_auth/_pgowner/properties.tsx` — all data
- `src/routes/_auth/_pgowner/listings.tsx` — all data
- `AmenityPicker.tsx` — amenity catalog (fetched fresh on every mount, e.g., listing form re-opens)
- `PreferencePicker.tsx` — preference metadata (same)
- `profile.tsx` — profile data, sessions list
- `listing.$id.tsx` — listing detail, property ratings

**Fix pattern for all of the above:**

```ts
const { data, isLoading } = useQuery({
	queryKey: queryKeys.amenities(),
	queryFn: getAmenities,
	staleTime: STALE.STATIC, // amenities basically never change
});
```

This eliminates redundant network calls when a user opens and closes a form multiple times in a session.

### 3b. Missing Query Key Hierarchy Entries

`queryKeys.ts` is missing keys for several resources that are fetched in multiple places:

```ts
// Missing from queryKeys.ts:
listingInterests: (listingId: string, status?: string) => [...],
roommateProfile: (userId: string) => [...],
listingAnalytics: (listingId: string) => [...],
amenities: ()  => ['amenities'],          // exists ✅ but never used in useQuery
preferenceMeta: () => ['preference-meta'],
publicUserRatings: (userId: string) => [...],
```

Without hierarchy, `invalidateQueries({ queryKey: ['interests'] })` won't match `getListingInterests` calls that use
ad-hoc keys inside `InterestsPanelDialog`.

### 3c. Infinite Re-Render Risk

`roommates.tsx`:

```tsx
const fetchFeed = useCallback(async (cursor?, append?) => { ... }, [sortBy]);

useEffect(() => {
  setIsLoading(true);
  fetchFeed().finally(() => setIsLoading(false));
}, [fetchFeed]);   // fetchFeed changes when sortBy changes → re-fetches ✅
```

This is correct because `fetchFeed` is memoised. However, `getRoommateFeed` is called with a plain object
`{ sortBy, cursorTime, cursorId }` every call — if this were in a `useQuery`, a new object reference every render would
cause infinite refetches. **Current pattern is safe** only because it's manually managed, but migrating to
`useInfiniteQuery` (as browse page uses) would be cleaner.

`connections.tsx` — `useEffect` inside `InterestsPanelDialog` depends on `[open, listingId, activeTab]`. When
`activeTab` changes, `fetchInterests` re-runs correctly. No infinite loop detected. ✅

`dashboard.tsx` — four separate `useQuery` calls all trigger on mount. They are independent and correctly deduplicated.
✅

### 3d. sessionStorage Persistence Leaks PII

`queryClient.ts` uses `persistQueryClient` with `sessionStorage`. The `shouldDehydrateQuery` filter allows keys starting
with `"profile"`:

```ts
const PERSIST_KEY_PREFIXES = ["amenities", "profile"];
```

The `studentProfile(userId)` key starts with `"profile"` — so the entire student profile (including `email`,
`date_of_birth`, `gender`, `bio`) is written to `sessionStorage`. On a shared/public computer, `sessionStorage` survives
until the tab closes but not page reloads — still risky if the user duplicates the tab. Consider excluding profile from
persistence or encrypting.

---

## 4. Android / Mobile API Consumer Flags

The backend is consumed by both the web frontend and a future Android client. The following are flags the Android team
should be aware of:

### 4a. Auth Token Delivery

The backend supports two auth modes:

1. **Cookie mode** (default, development/web): `Set-Cookie: accessToken=...; HttpOnly; SameSite=Lax`
2. **Bearer mode** (production cross-domain): send `X-Client-Transport: bearer` header → tokens returned in JSON body
   `{ data: { accessToken, refreshToken } }`

Android must always send `X-Client-Transport: bearer` on every request (including `/auth/refresh`). The web frontend
does this via `IS_PROD` flag — Android should do it unconditionally.

### 4b. Token Refresh Race Condition

The backend's `casRefreshToken` uses a Lua CAS script to prevent replay. If Android fires two requests simultaneously
and both 401, the first refresh will succeed and invalidate the old token; the second refresh attempt will fail
with 401. Android must implement a **single-flight refresh** (mutex/semaphore), exactly as the web client does in
`silentRefresh()` with `_refreshPromise`.

### 4c. Contact Reveal Rate Limiting

`GET /students/:userId/contact/reveal` and `POST /pg-owners/:userId/contact/reveal` are rate-limited by both cookie
counter (`contactRevealAnonCount`) and Redis fingerprint. Since Android can't use cookies, the backend falls back to
IP+UA fingerprinting only. This means:

- All users behind a corporate NAT sharing the same IP will share a 10-reveal quota.
- The backend logs a warning when count > 50 (possible NAT collision) but doesn't increase the limit.
- Android should send authenticated requests (`Authorization: Bearer`) so the gate is bypassed for verified users
  (`req.user.isEmailVerified === true`).

### 4d. File Uploads

Photo uploads (`PUT /students/:userId/photo`, `POST /listings/:id/photos`) require `multipart/form-data` with field name
`"photo"` (from `UPLOAD_FIELD_NAME` constant). Accepted MIME types: `image/jpeg`, `image/png`, `image/webp`. Max size:
10 MB. The backend returns **202 Accepted** (not 200) for listing photo uploads because processing is async — Android
must poll or listen for the `processing:` placeholder URL to be replaced.

### 4e. Pagination — Keyset Cursor

All list endpoints use keyset pagination with `{ cursorTime: ISO8601, cursorId: UUID }`. Both fields must be sent
together or neither. The `cursorTime` must include timezone offset (validated as `z.iso.datetime({ offset: true })`).
Android should use `toISOString()` equivalent (UTC `Z` suffix is fine).

### 4f. Rent Storage Unit

`rent_per_month` and `deposit_amount` are stored in **paise (×100)** in the database. The backend's `toRupees()`
transform divides by 100 before returning from listing endpoints — but this transform is only applied in
`searchListings` and `getListing`. The `getMyInterests` / `getMyConnections` responses also divide by 100 in their
respective service mappers. Android should verify each endpoint individually rather than assuming a consistent unit.

### 4g. Processing Photos

Listing photos are uploaded asynchronously. The `photoUrl` field in any listing detail response may start with
`processing:` (e.g., `processing:some-uuid`). Android must filter these out before rendering and ideally show a loading
placeholder. The web frontend does this with `.filter(p => !p.photoUrl.startsWith("processing:"))`.

### 4h. Notification Types

The `notification_type_enum` has 14 values split across migrations 001 and 002. `verification_pending` was added in
migration 002. Android should not hard-code an exhaustive switch — use a default fallback for unknown types to handle
future additions gracefully.

### 4i. Soft-Delete Pattern

Listings, properties, profiles, and connections all use `deleted_at IS NULL` filters. There is no "trash" or "archive"
API — once soft-deleted, records are invisible to all queries. Hard deletion runs on a weekly cron (`CRON_HARD_DELETE`,
defaults to Sundays at 04:00). Android should not cache entity IDs expecting them to remain indefinitely fetchable.

---

## 5. Render / Upstash / Neon Tier-0 Specific Concerns

### 5a. Upstash Redis Cold Start

Upstash free/starter tier connections are serverless (HTTP under the hood). The `bullmq` workers use
`ioredis`-compatible connections via `bullConnection.js`. On Render's free tier the server **sleeps after 15 minutes of
inactivity** — when it wakes, BullMQ workers restart and drain any queued jobs, but:

- Any email or notification job enqueued during the sleep window will sit in Redis until workers restart.
- The `verificationEventWorker` uses `setInterval(drainOutbox, 5000)` — it will start draining immediately on wake but
  the first interval fires on startup (guarded by `draining` flag).

### 5b. Rate Limiter Redis Client

`rateLimiter.js` creates a **second** Redis client (`rateLimitRedisClient`) separate from the main `redis` client in
`cache/client.js`. On Upstash free tier there is a connection count limit. Two clients + BullMQ connection = 3
simultaneous connections minimum. Monitor this.

### 5c. Azure Blob — UPLOAD_TIMEOUT_MS

`AzureBlobAdapter` has a 30-second upload timeout via `AbortController`. Render free tier has **a 30-second request
timeout** as well. If an upload takes >25 seconds the HTTP response may time out before the abort fires, leaving the
BullMQ worker in a bad state. Consider reducing `UPLOAD_TIMEOUT_MS` to 20 seconds.

---

## 6. Summary Priority Matrix

| Priority  | Item                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| 🟠 High   | `listing.$id.tsx` — `isSaved` not hydrated from cache; `AmenityPicker`/`PreferencePicker` bypass TanStack Query |
| 🟠 High   | Profile mutations don't invalidate `queryKeys.studentProfile` / `queryKeys.pgOwnerProfile`                      |
| 🟠 High   | No listing renewal UI — listings silently expire with no user action possible                                   |
| 🟠 High   | No listing analytics UI — owners cannot see views/conversion rate                                               |
| 🟡 Medium | `rentDeviation` field never rendered on browse or detail pages                                                  |
| 🟡 Medium | `roommateBio` returned by backend, never shown in frontend                                                      |
| 🟡 Medium | Google OAuth flow stubbed — shows toast only                                                                    |
| 🟡 Medium | `revealPgOwnerContact` never called from any component                                                          |
| 🟡 Medium | `ratedConnectionIds` is ephemeral — lost on refresh                                                             |
| 🟡 Medium | `unblockUser` never surfaced in UI                                                                              |
| 🔵 Low    | Admin panel (verification queue, report queue) entirely absent                                                  |
| 🔵 Low    | sessionStorage persistence includes `email` / `date_of_birth` in profile cache                                  |
| 🔵 Low    | Android: no documented guidance on `processing:` photo URL handling                                             |
