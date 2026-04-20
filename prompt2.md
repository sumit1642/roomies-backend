# Roomies Backend — Documentation Audit & Comprehensive Update Prompt

## Deployment Reality (Read This First — It Overrides All Doc References to Azure)

The live production API is hosted on **Render**, not Azure. Every doc section that references Azure App Service as the
hosting layer is describing a _planned future migration_, not the current live environment. The real service topology as
of today is:

| Component     | Actual service                                                          |
| ------------- | ----------------------------------------------------------------------- |
| API host      | Render free tier — `https://roomies-api.onrender.com`                   |
| API base URL  | `https://roomies-api.onrender.com/api/v1`                               |
| Health check  | `https://roomies-api.onrender.com/api/v1/health`                        |
| Database      | Neon PostgreSQL 16 + PostGIS (pooler endpoint, `ap-southeast-1`)        |
| Redis         | Upstash — `rediss://...upstash.io:6379` (TLS, port 6379 not 6380)       |
| Blob storage  | Azure Blob Storage — `roomiesblob` account, `roomies-uploads` container |
| Email (prod)  | `EMAIL_PROVIDER=brevo-api` (Brevo REST API, **not** SMTP relay)         |
| Email (local) | `EMAIL_PROVIDER=brevo` (Brevo SMTP) or `EMAIL_PROVIDER=ethereal`        |

### Critical env-to-code divergence (must be resolved before any docs are finalised)

The file `src/config/env.js` defines the `EMAIL_PROVIDER` enum as:

```js
EMAIL_PROVIDER: z.enum(["ethereal", "brevo"], { ... }).default("ethereal")
```

Both `.env` (the root file used for quick local runs) and `.env.render` (the exact env vars loaded by the live Render
service) set `EMAIL_PROVIDER=brevo-api`. This value is **not in the enum** — Zod `safeParse` will fail, the startup
guard will `process.exit(1)`, and the server will never start. One of the following must be true and must be determined
before this audit continues:

1. The server is crashing on startup on Render right now (most likely: the env var leaks past Zod because Render sets
   env vars natively without loading a `.env` file, and the `.env.render` file is for local reference only — meaning the
   Render dashboard vars may differ from the file). If so, document the dashboard values separately.
2. A code change has been made to `env.js` that accepts `"brevo-api"` but the change is not yet reflected in the
   codebase provided. If so, document the three-value enum and the new provider branch throughout the TechStack and
   Deployment docs.

Either way, **every doc that touches `EMAIL_PROVIDER` must be updated** once this is resolved. The enum is referenced in
`docs/TechStack.md`, `docs/deployment/tier0.md`, `docs/Deployment.md`, and the environment variable tables in
`docs/API.md`.

Additional env discrepancies that must be resolved:

- `.env.render` sets `TRUST_PROXY=false`. The running API is behind Render's reverse proxy, which means `req.ip`
  resolves to `::ffff:10.x.x.x` (Render's internal address) instead of the real client IP. The OTP IP-rate-limiter in
  `auth.service.js` becomes effectively a no-op because every request looks like it comes from the same internal IP. The
  correct value is `TRUST_PROXY=1`. Document this as both a security issue and a required configuration fix in the
  Render docs.

- `.env.render` sets `ALLOWED_ORIGINS=http://localhost:5173`. In production on Render, this means every credentialed
  cross-origin request from any frontend domain other than `localhost:5173` is rejected by the CORS middleware guard in
  `app.js`. Document the correct procedure for updating this when a frontend is deployed.

- `.env.render` sets `NODE_ENV=production` (correct). The old tier-0 Azure doc said the `.env.render` file uses
  `development` to allow local testing against live services. This is no longer accurate — the file is now the literal
  copy of what Render runs.

---

## How to Use This Prompt

This is a **chained instruction set with real-world grounding**. Every phase produces or corrects doc files that the
next phase depends on. Complete the phases in strict order. When a phase references a scenario, write it as though a
real developer is integrating against the live API at `https://roomies-api.onrender.com/api/v1` — use realistic request
bodies, realistic error messages verbatim from the source code, and realistic response shapes. Never paraphrase an error
string from the service layer; copy it exactly.

The source-of-truth hierarchy is:

1. The actual source files in `src/` — always wins.
2. The env files as described above — governs deployment docs.
3. The existing docs in `docs/` — to be corrected where they diverge from (1) and (2).

---

## Phase 0 — Governing Rules (Apply to Every Phase)

Before writing a single line of documentation, internalise these rules. They govern every decision in every phase that
follows.

**Rule 1 — Scenario-based JSON is the only acceptable format for endpoint documentation.** Every endpoint must be
documented as a series of named scenarios. Each scenario carries: a plain-English title that describes the real-world
situation triggering it; the full request contract (method, path, auth requirement, relevant headers, validated query
params, and exact body shape); and the response block showing the complete JSON. Response bodies must match what the
code actually returns — check the controller's `res.status().json()` call and the service's return value. Never say a
field "might" contain something; show what it actually contains.

**Rule 2 — Code is truth; docs are its shadow.** If `auth.service.js` throws
`new AppError("Incorrect OTP — 4 attempts remaining", 400)`, the doc shows `400` with
`{ "status": "error", "message": "Incorrect OTP — 4 attempts remaining" }`. The `4` is not a placeholder — it is the
actual string constructed by the service at runtime, and the doc must use the same template. The same applies to every
`AppError` in every service.

**Rule 3 — Gates are first-class endpoint outcomes.** When a route chain is
`optionalAuthenticate → validate → guestListingGate → controller`, the gate's short-circuit responses are as real as the
controller's success response. Document them as named scenarios with their own request context (e.g. "guest sends
request without a token") and response shape. Never hide gate behaviour in a footnote.

**Rule 4 — Status codes come from both the controller and the service.** The controller determines the success code
(`res.status(201).json(...)` vs `res.json(...)`). The service determines every error code via `AppError`. The global
error handler in `src/middleware/errorHandler.js` determines what PostgreSQL constraint codes map to: `23505 → 409`,
`23503 → 409`, `23514 → 400`. All three sources must be checked for every endpoint's full scenario list.

**Rule 5 — Real-world completeness means every path through the code is a scenario.** A service function that has three
different `throw new AppError(...)` calls represents three different failure scenarios. Each one gets its own named
scenario block. The scenario name should describe the real-world condition, not the technical mechanism — "Poster tries
to accept an already-accepted request" rather than "ON CONFLICT fires on interest_requests".

**Rule 6 — Cross-references must be hyperlinks, not prose.** Every time a doc says "see the auth flow" it must link to
`./auth.md`. Every time it references a pagination pattern it must link to the conventions doc or the pagination section
of `API.md`. Every time a new file is created it must be linked from `docs/README.md` and `docs/API.md`.
Cross-references are a navigability contract, not a stylistic choice.

**Rule 7 — Example values are canonical and must be consistent.** The file `docs/api/conventions.md` defines canonical
UUIDs. Every scenario in every feature doc uses those exact UUIDs. No scenario invents a new UUID. This rule exists so
that a developer reading multiple feature docs while building an integration flow sees the same identifiers everywhere
and can mentally compose the scenarios into a coherent sequence.

**Rule 8 — The paise rule is a documentation contract, not just an implementation detail.** Every endpoint that involves
`rentPerMonth` or `depositAmount` must explicitly state in its request contract table that values are accepted and
returned in rupees, even though the database stores paise. A developer who does not know this will send `850000`
expecting ₹8,500 and get ₹8.5M rent on a listing.

---

## Phase 1 — Audit Every Existing Feature Doc Against Current Source

For each subsection, open the doc file and the listed source files simultaneously. For every discrepancy, note it,
correct it in place, and add whatever scenarios are missing. The subsections below tell you exactly where to look and
what to verify.

### 1.1 — `docs/api/auth.md`

Source files: `src/routes/auth.js`, `src/validators/auth.validators.js`, `src/services/auth.service.js`,
`src/controllers/auth.controller.js`.

Verify and correct each of the following:

**Logout route asymmetry.** `POST /auth/logout` does not require `authenticate` middleware — it reads the refresh token
from `req.body.refreshToken ?? req.cookies?.refreshToken` and calls `logoutByRefreshToken`. `POST /auth/logout/current`
does require `authenticate` — it reads `req.user.sid` from the JWT to identify the exact session to revoke. The doc must
show both endpoints, and the `/logout/current` doc must clearly state the access-token requirement.

**Revoking the current session clears cookies.** In `auth.controller.js`, `revokeSession` calls `clearAuthCookies(res)`
when `req.user.sid === sid`. This means deleting your own session via `DELETE /auth/sessions/:sid` also clears the
browser's `accessToken` and `refreshToken` cookies. This side-effect is a real-world outcome that must appear as a named
scenario: "Caller revokes their current session — cookies are cleared in the same response."

**`parseTtlSeconds` accepts numeric values.** The function accepts `number`, digit-only string, and `"15m"`/`"7d"`
format strings. The doc's description of JWT expiry behaviour must reflect that `JWT_EXPIRES_IN=900` (a plain integer)
is valid and means 900 seconds, not 900 milliseconds.

**Legacy token migration.** `verifyRefreshTokenPayload` transparently migrates tokens that were issued before
per-session keys were introduced — they lack a `sid` field. When a legacy token arrives, the function generates a new
`sid`, writes the per-session key, deletes the legacy key, and returns normally. Callers never see a migration-related
error. The doc must include a note in the "Integrator Notes" section stating that legacy tokens are migrated
transparently on first use — callers do not need to handle this.

**Google OAuth three paths.** `POST /auth/google/callback` has three distinct internal branches with distinct real-world
meanings:

- Path 1 (returning user, found by `google_id`): user previously signed in with Google.
- Path 2 (account linking, found by email, `google_id IS NULL`): user has an existing email/password account and is
  linking it to Google for the first time.
- Path 3 (new registration): brand-new user, no existing account by email or Google ID.

All three must appear as named scenarios with the exact response shape. Path 2's scenario title should be "Existing
email/password account linked to Google for the first time." Path 3 has sub-scenarios for `student` and `pg_owner` roles
because the required body fields differ.

The failure scenarios for the Google callback endpoint that must all be present:

- `role` missing on new registration → `400`
- `fullName` missing on new registration → `400`
- `businessName` missing when role is `pg_owner` → `400`
- Google token invalid or expired → `401`
- Google account email not verified → `400`
- Google account already linked to a different user → `409`
- Local account already linked to a different Google account → `409`
- Google OAuth not configured on the server (no `GOOGLE_CLIENT_ID` env var) → `503`

**OTP verify scenarios are incomplete in most versions of this doc.** Verify all of these are present as distinct named
scenarios with exact message strings from `auth.service.js`:

- Correct OTP on first attempt → `200` with `"Email verified successfully"`
- Wrong OTP with attempts remaining → `400` with the dynamic `"Incorrect OTP — N attempts remaining"` string
- Wrong OTP on the fifth attempt → `429` with `"Too many incorrect attempts — request a new OTP"`
- OTP expired or never sent → `400` with `"OTP has expired or was never sent — request a new one"`
- IP rate limit tripped → `429` with `"Too many OTP verification attempts from this IP — please wait 15 minutes"`
- Redis unavailable (fail-closed) → `429` with `"OTP verification is temporarily unavailable"`

### 1.2 — `docs/api/profiles-and-contact.md`

Source files: `src/routes/student.js`, `src/routes/pgOwner.js`, `src/validators/student.validators.js`,
`src/validators/pgOwner.validators.js`, `src/services/student.service.js`, `src/services/pgOwner.service.js`,
`src/middleware/contactRevealGate.js`.

Verify and correct each of the following:

**HTTP method asymmetry.** The student contact reveal route is `GET /students/:userId/contact/reveal`. The PG owner
contact reveal route is `POST /pg-owners/:userId/contact/reveal`. This asymmetry is intentional — `POST` prevents
browser prefetch and intermediate proxy caching of PII responses. The doc must state this rationale explicitly, not just
note the difference.

**`Cache-Control: no-store` appears on all responses from these routes, not just successes.** In
`src/routes/student.js`, the `no-store` header middleware runs before `contactRevealGate`. In `src/routes/pgOwner.js`,
it also runs before the gate. This means the `429` limit-reached response also carries `Cache-Control: no-store`. Every
scenario for both reveal endpoints — including the `429` — must show `Cache-Control: no-store` in the response headers
section.

**Gate charges quota only on successful 2xx reveals.** The `contactRevealGate` uses a pre-response hook (wrapping
`res.json`, `res.send`, `res.end`) to increment the Redis counter only when the response status is 2xx. A `404` (user
not found) does not consume a reveal slot. The doc must state this clearly: "Quota is charged only when the reveal is
successful (2xx response). A 404 or 500 does not consume a free reveal."

**Two-tier model details.** Verified users (authenticated + `isEmailVerified === true`) get unlimited reveals and the
full contact bundle. Guests and unverified authenticated users get at most 10 reveals per 30-day rolling window and
receive only the email — never `whatsapp_phone`. The doc must show the exact response shape for both tiers, and the
shapes must differ only in the presence/absence of `whatsapp_phone`.

**Preferences routes are mounted in `student.js`.** `GET /students/:userId/preferences` and
`PUT /students/:userId/preferences` are on the student router, not a separate preferences router. Both are owner-only
(caller must match `:userId`). The `PUT` uses the `dedupePreferencesByKey` function from `src/config/preferences.js`,
which implements last-write- wins when duplicate `preferenceKey` values appear in the same request. The doc must include
a named scenario: "Request with duplicate preference keys — last value for each key wins, no error returned." The
example body should send `smoking` twice with different values.

### 1.3 — `docs/api/listings.api.md`

Source files: `src/routes/listing.js`, `src/validators/listing.validators.js`, `src/services/listing.service.js`,
`src/middleware/guestListingGate.js`, `src/services/listingLifecycle.js`.

Verify and correct each of the following:

**Guest access is a first-class policy that must be documented in a prominent table.** `GET /listings` and
`GET /listings/:listingId` are the only two endpoints that accept unauthenticated requests. All other listing endpoints
return `401` for guests. The doc must include a table at the top of the file that shows this policy at a glance:

| Caller        | `GET /listings`  | `GET /listings/:listingId` | Save            | Interest        | Compatibility       |
| ------------- | ---------------- | -------------------------- | --------------- | --------------- | ------------------- |
| Guest         | ✅ max 20 items  | ✅ full detail             | ❌ 401          | ❌ 401          | ❌ always 0         |
| Authenticated | ✅ max 100 items | ✅ full detail             | ✅ student only | ✅ student only | ✅ when prefs exist |

**`compatibilityAvailable` is missing from the existing doc.** The search result item shape now includes two related
fields: `compatibilityScore` (integer, the count of matching preference pairs) and `compatibilityAvailable` (boolean,
true only when both the requesting user has saved preferences AND the listing has at least one preference set). For
guests, both are always `0` and `false`. For authenticated users with no preferences, `compatibilityScore` is `0` and
`compatibilityAvailable` is `false`. Add `compatibilityAvailable` to every search result item shape in the doc.

**`guestListingGate` silently caps the `limit` param to 20 for guests.** The middleware in
`src/middleware/guestListingGate.js` rewrites `req.query.limit` to `20` if a guest requests more. The cap is silent — no
error, no warning header. Document this behaviour in the guest access table: "Guests receive at most 20 items per
request regardless of the `limit` query parameter."

**Lifecycle error message strings must be exact.** `src/services/listingLifecycle.js` exports:

```js
export const EXPIRED_LISTING_MESSAGE = "Listing has expired and is no longer available";
export const UNAVAILABLE_LISTING_MESSAGE = "Listing is no longer available";
```

These exact strings appear in `422` responses whenever an operation is attempted on an expired or non-active listing.
Verify every expired/unavailable scenario in the doc uses these exact strings, not paraphrases like "listing is expired"
or "listing unavailable".

**`PUT /listings/:listingId` location-field rejection message must be exact.** When a caller tries to update `city`,
`latitude`, or any other property-owned location field on a `pg_room` or `hostel_bed` listing, the service throws:

```
`Location fields (${forbiddenFields.join(", ")}) cannot be updated on a ${listingType} listing — ` +
`they are inherited from the parent property. Update the property's address instead.`
```

The doc's `422` scenario must use the exact interpolated format with actual field names. The example scenario should
show a request that sends both `city` and `latitude`, and the message should read:
`"Location fields (city, latitude) cannot be updated on a pg_room listing — they are inherited from the parent property. Update the property's address instead."`

**`PATCH /listings/:listingId/status` returns only `{ listingId, status }`.** The service function `updateListingStatus`
returns `{ listingId, status: newStatus }`. It does not return `rentPerMonth`, `title`, or any other listing field. The
existing doc may show a richer response shape — verify it is trimmed to match exactly.

**The status transition table must include the full terminal-state rules:**

- `active → filled` ✅
- `active → deactivated` ✅
- `deactivated → active` ✅ (only if listing has not expired)
- `filled → *` ❌ terminal, no transitions out
- `expired → *` ❌ terminal, set only by cron — not exposed as a valid target in `updateListingStatusSchema`

### 1.4 — `docs/api/interests.md`

Source files: `src/routes/interest.js`, `src/routes/listing.js`, `src/validators/interest.validators.js`,
`src/services/interest.service.js`.

Verify and correct each of the following:

**`POST /listings/:listingId/interests` is student-only.** The route applies `authorize("student")` middleware. The doc
must state this explicitly in the request contract and include a named failure scenario: "Non-student role (e.g. PG
owner) attempts to send interest" → `403` with `"Forbidden"`.

**Accept transition response must include both `whatsappLink` and `listingFilled`.** When a poster accepts an interest
request via `PATCH /interests/:interestId/status`, the `_acceptInterestRequest` service function returns:

```js
{ interestRequestId, studentId, listingId, status: "accepted", connectionId, whatsappLink, listingFilled }
```

The `whatsappLink` is `null` when the poster has no phone number on file. The `listingFilled` boolean is `true` when
this acceptance exhausted the listing's `total_capacity`. Both fields must appear in the scenario response with their
types and null-conditions documented.

**`GET /listings/:listingId/interests` has two distinct 403/404 scenarios.** In `getInterestRequestsForListing`, the
service first checks whether the listing exists at all, then whether the caller owns it. These produce different
responses:

- Listing exists, but caller is not the owner → `403` with `"You do not own this listing"`
- Listing does not exist → `404` with `"Listing not found"`

Both must be distinct named scenarios. The current doc may merge them or show only one.

**Re-sending after decline is allowed.** The `createInterestRequest` service uses
`ON CONFLICT (sender_id, listing_id) WHERE status IN ('pending', 'accepted') DO NOTHING`. This partial unique index only
blocks duplicate active requests. A student whose previous interest was `declined` or `withdrawn` can successfully send
a new request — the `ON CONFLICT` clause does not match those terminal states, so a fresh `INSERT` succeeds. The doc
must include a named scenario: "Student re-sends interest after their previous request was declined — new request is
created successfully."

### 1.5 — `docs/api/connections.md`

Source files: `src/routes/connection.js`, `src/validators/connection.validators.js`,
`src/services/connection.service.js`.

Verify and correct each of the following:

**`confirmConnection` uses a single atomic UPDATE.** The service does not perform two separate database operations (flip
flag, then check if both are true). It issues a single `UPDATE` with a `CASE WHEN` block that simultaneously flips the
caller's confirmation flag and conditionally promotes `confirmation_status` to `'confirmed'` if both flags are now true.
The doc must say: "The confirmation and the potential status promotion to `'confirmed'` happen in a single atomic
database operation." This matters for integrators who might worry about race conditions.

**`GET /connections/me` supports `confirmationStatus` and `connectionType` filters.** Verify the doc shows both filters
with their full enum values:

- `confirmationStatus`: `"pending"`, `"confirmed"`, `"denied"`, `"expired"`
- `connectionType`: `"student_roommate"`, `"pg_stay"`, `"hostel_stay"`, `"visit_only"`

Both are optional. The absence of a filter returns all connections regardless of that dimension.

### 1.6 — `docs/api/ratings-and-reports.md`

Source files: `src/routes/rating.js`, `src/validators/rating.validators.js`, `src/validators/report.validators.js`,
`src/services/rating.service.js`, `src/services/report.service.js`.

Verify and correct each of the following:

**`GET /ratings/user/:userId` and `GET /ratings/property/:propertyId` are public.** Both routes apply
`publicRatingsLimiter` but no `authenticate` middleware. The doc must not list any auth requirement for these two
endpoints, and must not say "Auth required."

**`submitRating` zero-rowCount discrimination.** When the atomic `INSERT ... SELECT ... WHERE EXISTS` returns zero rows,
the service performs a follow-up query to distinguish three cases:

1. Connection not found or caller not a party → `404` with `"Connection not found"`
2. Connection exists but `confirmation_status !== 'confirmed'` → `422` with
   `"Ratings can only be submitted for confirmed connections"`
3. Duplicate rating (ON CONFLICT fired) → `409` with
   `"You have already submitted a rating for this connection and reviewee"`

All three must be distinct named scenarios. The `422` and `409` cases are especially easy to conflate but represent
entirely different real-world situations.

**`resolveReport` cross-field constraint.** `adminNotes` is required when `resolution = "resolved_removed"` and optional
when `resolution = "resolved_kept"`. This is enforced both in `src/validators/report.validators.js` (Zod `.refine()`)
and in `src/services/report.service.js` (service-layer guard). The doc must show a named failure scenario: "Admin
submits `resolved_removed` without `adminNotes`" → `400` validation error with
`"adminNotes is required when resolution is resolved_removed"`.

**`submitReport` party-membership check exact error string.** The service uses:

```js
throw new AppError("Rating not found or you are not a party to this connection", 404);
```

This exact string must appear in the `404` scenario. The intentional vagueness of "or you are not a party" is the
privacy-preserving design — the response never confirms whether the rating exists to an unauthorised caller.

### 1.7 — `docs/api/notifications.md`

Source files: `src/routes/notification.js`, `src/validators/notification.validators.js`,
`src/services/notification.service.js`, `src/workers/notificationWorker.js`.

Verify and correct each of the following:

**`all: false` is a validation error, not a no-op.** The `markReadSchema` uses `z.literal(true)` for the `all` field.
Sending `{ "all": false }` fails Zod validation and returns `400` before the service is ever called. The doc must
include a named scenario: "Client sends `{ all: false }`" → `400` validation error. This is distinct from the "both
modes supplied simultaneously" scenario. The expected error body is a standard Zod validation error with a field error
on `body.all`.

**Notification type table must exactly match `NOTIFICATION_MESSAGES` in `notificationWorker.js`.** Cross-check every key
in the map against the table in the doc. The complete current list is: `interest_request_received`,
`interest_request_accepted`, `interest_request_declined`, `interest_request_withdrawn`, `connection_confirmed`,
`rating_received`, `listing_expiring`, `listing_expired`, `listing_filled`, `verification_approved`,
`verification_rejected`, `new_message`, `connection_requested`.

Note the distinction between `listing_expiring` (fired by the `expiryWarning` cron, 7 days before expiry) and
`listing_expired` (fired by the `listingExpiry` cron, at the moment of expiry). Both must be in the table with correct
trigger descriptions.

`connection_requested` is marked PLANNED in the worker — no emitter exists in the codebase. The doc must label it
PLANNED and state that no code currently enqueues this type.

### 1.8 — `docs/api/health.md`

Source file: `src/routes/health.js`.

Verify that the `503` degraded response shape uses `"timeout"` as the service status string for timed-out probes. The
`isTimeoutError()` function in `health.js` checks for `ETIMEDOUT`, `ECONNABORTED`, `ESOCKETTIMEDOUT`, `TimeoutError`,
`AbortError`, and a regex `/timed?\s*out/i` on the message. When any of those conditions match, the service status is
set to `"timeout"`. When they do not match, the service status is `"unhealthy"`. The doc must show scenarios for both
`"timeout"` and `"unhealthy"` for both database and Redis.

---

## Phase 2 — Document Missing or Incomplete Features

### 2.1 — `docs/api/admin.md`

This file is referenced from `docs/API.md` and `docs/README.md`. Verify it contains full scenario-based documentation
for all five admin endpoints, and add whatever is missing.

All five endpoints share `authenticate + authorize('admin')` enforced at the router level. Any request to any route
under `/admin` without a valid admin JWT short-circuits with `403` before the route handler runs. This gate response
must appear as a first-class scenario at the top of this file.

**Verification queue endpoints:**

`GET /admin/verification-queue` — paginated oldest-first. The anti-starvation ordering (oldest first, not newest) is
deliberate and must be noted in the doc. Success scenario shows the full item shape including `business_name`,
`owner_full_name`, `verification_status`, and `email`.

`POST /admin/verification-queue/:requestId/approve` — approves the request, sets `verification_status = 'verified'` on
the profile. The service uses `AND status = 'pending'` in the `UPDATE` as a concurrency guard. If a concurrent
approval/rejection already resolved the request, `rowCount === 0` and the service throws
`AppError("Verification request not found or already resolved", 409)`. This concurrent-resolution scenario must be a
named failure scenario. The success response is `{ requestId, status: "verified" }`.

`POST /admin/verification-queue/:requestId/reject` — requires `rejectionReason` in the body (enforced by
`rejectRequestSchema`). `adminNotes` is optional. Same concurrent-resolution `409` applies. Success response is
`{ requestId, status: "rejected" }`.

**Report queue endpoints:**

`GET /admin/report-queue` — paginated oldest-first. Each item carries the full rating content, reporter profile,
reviewer profile, and reviewee profile so the admin can decide without a second request. The response shape is complex —
document it fully.

`PATCH /admin/reports/:reportId/resolve` — two resolutions: `"resolved_removed"` (hides the rating, triggers the
`update_rating_aggregates` DB trigger) and `"resolved_kept"` (closes the report without touching the rating). Document:

- `adminNotes` is required for `"resolved_removed"` → `400` when missing
- Report not found or already resolved → `409`
- Successful resolution → `200` with `{ reportId, resolution, ratingId }`

**CDC pipeline link.** When a verification request is approved or rejected, the trigger
`trg_verification_status_changed` fires and writes to `verification_event_outbox`. The `verificationEventWorker` picks
this up and enqueues both an in-app notification and a transactional email. Document this chain in the admin doc as a
note: "Approval and rejection decisions trigger asynchronous side effects — an in-app notification and a transactional
email are enqueued within approximately 5 seconds via the CDC outbox worker."

### 2.2 — `docs/api/preferences.md`

Verify the file covers all three surfaces completely.

`GET /preferences/meta` — returns the `preferenceMetadata` object from `src/config/preferences.js`. The full current
catalog (7 keys: `smoking`, `food_habit`, `sleep_schedule`, `alcohol`, `cleanliness_level`, `noise_tolerance`,
`guest_policy`) must appear in the doc's success response so integrators do not need to call the endpoint just to learn
the valid values. When the catalog changes in `preferences.js`, this doc section must be updated in the same commit.

`GET /students/:userId/preferences` — owner-only (Zod params schema validates UUID; service enforces
`requestingUserId === targetUserId`). Returns an array of `{ preferenceKey, preferenceValue }` objects. Empty array for
users who have not set any preferences — not `null`, not `404`.

`PUT /students/:userId/preferences` — full-replace semantics. Empty array clears all preferences. The
`dedupePreferencesByKey` function applies last-write-wins when duplicate keys are submitted. A request body like:

```json
{
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "smoking", "preferenceValue": "smoker" }
	]
}
```

results in a single `smoking: smoker` row (last value wins), and the response returns only that one entry. Name this
scenario "Duplicate preference key submitted — last value wins, no error."

### 2.3 — Background Jobs in `docs/API.md`

The "Background Jobs That Affect API Behavior" section must describe all three cron jobs with exact schedule
expressions, overridable env var names, and the `SOFT_DELETE_RETENTION_DAYS` format constraint. Use the following
verified details from the source code:

`src/cron/listingExpiry.js` — schedule: `0 2 * * *` (02:00 daily server time), env override: `CRON_LISTING_EXPIRY`.
Transitions `active` listings where `expires_at < NOW()` to `expired` and bulk-expires pending interest requests on
those listings in the same transaction. Also enqueues `listing_expired` notifications for affected posters post-commit.

`src/cron/expiryWarning.js` — schedule: `0 1 * * *` (01:00 daily server time), env override: `CRON_EXPIRY_WARNING`.
Enqueues `listing_expiring` notifications for listings expiring within 7 days. Uses a durable INSERT with
`ON CONFLICT (idempotency_key) DO NOTHING` inside the transaction — the idempotency key format is
`expiry_warning:{listing_id}:{YYYY-MM-DD}` (UTC date). This guarantees exactly one notification per listing per calendar
day regardless of how many times the cron runs.

`src/cron/hardDeleteCleanup.js` — schedule: `0 4 * * 0` (04:00 every Sunday), env override: `CRON_HARD_DELETE`.
Hard-deletes rows with `deleted_at < NOW() - RETENTION_DAYS`. Retention overridable via `SOFT_DELETE_RETENTION_DAYS`.
Format requirement: must be a plain decimal integer with no prefix, suffix, or sign (e.g. `"90"`, not `"90days"`, not
`"-30"`, not `"1e2"`). The strict `/^[0-9]+$/` parse is intentional — `parseInt()` would silently accept `"90days"` as
90, and we want a warning log and fallback to 90 instead of silent misinterpretation.

---

## Phase 3 — Update `docs/TechStack.md`

### 3.1 — EMAIL_PROVIDER three-value enum

Once the `brevo-api` discrepancy described in the Deployment Reality section above is resolved, update `TechStack.md` to
describe all three valid `EMAIL_PROVIDER` values:

- `"ethereal"` — Nodemailer pointed at Ethereal's fake SMTP server (local dev only). Requires `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Prints a preview URL to the console instead of actually delivering email.
- `"brevo"` — Nodemailer pointed at `smtp-relay.brevo.com:587` (STARTTLS). Requires `BREVO_SMTP_LOGIN`,
  `BREVO_SMTP_KEY`, `BREVO_SMTP_FROM`. Real email delivery.
- `"brevo-api"` — Brevo REST API (`/v3/smtp/email`). Requires `BREVO_API_KEY` and `BREVO_SMTP_FROM`. Used on Render
  because Render's free tier blocks outbound SMTP connections.

The `BREVO_SMTP_KEY` vs `BREVO_API_KEY` distinction must be clearly stated: the SMTP key starts with `xsmtpsib-` and is
used only with `EMAIL_PROVIDER=brevo`; the API key starts with `xkeysib-` and is used only with
`EMAIL_PROVIDER=brevo-api`.

### 3.2 — BullMQ queue table

Update the BullMQ queues table to include all three current queues:

| Queue name              | Worker file             | Concurrency    | Used for                                                         |
| ----------------------- | ----------------------- | -------------- | ---------------------------------------------------------------- |
| `media-processing`      | `mediaProcessor.js`     | 1 (CPU-bound)  | Sharp compression, storage upload, DB URL update, cover election |
| `notification-delivery` | `notificationWorker.js` | 10 (I/O-bound) | Notification INSERT with idempotency key ON CONFLICT DO NOTHING  |
| `email-delivery`        | `emailWorker.js`        | 3 (I/O-bound)  | OTP emails, verification status emails via CDC outbox pipeline   |

### 3.3 — CDC outbox worker subsection

Add a new subsection under the Workers section for the verification event worker. It must explain:

- This is not a BullMQ worker. It is a `setInterval`-based polling loop (5-second interval).
- It reads from `verification_event_outbox`, which is populated by the Postgres trigger
  `trg_verification_status_changed` (defined in migration `002_verification_event_outbox.sql`).
- It uses `SELECT ... FOR UPDATE SKIP LOCKED` to allow safe concurrent operation across multiple instances without
  double-processing.
- On processing an event, it ensures `pg_owner_profiles.verification_status` is consistent with the event (a profile
  consistency guard for direct-SQL changes), enqueues an in-app notification, and enqueues a transactional email.
- Failed events are retried up to `MAX_ATTEMPTS = 5` times; permanently failed events have `processed_at` set so they no
  longer block the queue, and the error is recorded in `error_message` for operator inspection.
- It is started in `server.js` after Redis and Postgres are confirmed healthy, and stopped during graceful shutdown via
  `verificationEventWorker.close()`.

---

## Phase 4 — Update `docs/ImplementationPlan.md`

### 4.1 — Phase 5 status correction

`phase5/cron` is marked ✅ MERGED. `phase5/admin` remains ⏳ NOT STARTED.

Update the "What needs building" list under `phase5/admin` to reflect current reality:

- The email delivery worker (`emailWorker.js`, `emailQueue.js`) is **done** — remove it from the needs-building list.
  Mark it ✅ in the source file inventory.
- The verification event CDC worker (`verificationEventWorker.js`) is **done** — add it to the source file inventory if
  not present. It belongs between the cron files and the BullMQ workers.
- The admin user management endpoints (`GET /admin/users`, `PATCH /admin/users/:userId/status`) are **not started**.
- The admin analytics endpoint (`GET /admin/analytics/platform`) is **not started**.
- The admin rating visibility endpoints (`GET /admin/ratings`, `PATCH /admin/ratings/:ratingId/visibility`) are **not
  started**.

### 4.2 — Source file inventory additions

Add the following files to the inventory with appropriate status marks and one-line descriptions:

- `src/workers/emailWorker.js` — ✅ BullMQ worker for async email delivery; concurrency 3; handles `otp`,
  `verification_approved`, `verification_rejected`, `verification_pending` types
- `src/workers/emailQueue.js` — ✅ Fire-and-forget enqueue helper for `email-delivery` queue; mirrors
  `notificationQueue.js` pattern
- `src/workers/verificationEventWorker.js` — ✅ setInterval polling loop (5s); reads `verification_event_outbox`;
  dispatches notifications + emails for verification status changes; SELECT FOR UPDATE SKIP LOCKED for concurrency
  safety
- `src/middleware/guestListingGate.js` — ✅ Silently caps `limit` to 20 for unauthenticated requests on `GET /listings`
  and `GET /listings/:listingId`

### 4.3 — DB trigger reference table addition

Add the following trigger to the trigger reference table:

| Trigger                           | Table                   | Fires on                 | Action                                                                                                                                         |
| --------------------------------- | ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `trg_verification_status_changed` | `verification_requests` | AFTER UPDATE OF `status` | Inserts into `verification_event_outbox` for `verified`, `rejected`, or `pending` transitions; the `verificationEventWorker` polls this outbox |

---

## Phase 5 — Update Deployment Documentation

The current active deployment target is **Render**, not Azure. The deployment docs need to reflect this reality.
`docs/Deployment.md` covers the Azure migration plan (future state). `docs/deployment/tier0.md` covers the Render
deployment (current state). This phase focuses on tier0 since that is what is running right now.

### 5.1 — `docs/deployment/tier0.md` — Email provider

The Render free tier blocks outbound SMTP on port 587. This means `EMAIL_PROVIDER=brevo` (which uses Nodemailer SMTP)
will fail silently or with connection errors. The correct provider for Render is `EMAIL_PROVIDER=brevo-api`, which calls
the Brevo REST API over HTTPS. Verify this is reflected everywhere in the tier0 guide:

- The environment variable table in Phase 7.2 of the guide must list `EMAIL_PROVIDER=brevo-api`.
- Any section that references `BREVO_SMTP_KEY` or `BREVO_SMTP_LOGIN` for Render must be updated to reference
  `BREVO_API_KEY` instead — the API provider does not use SMTP credentials.
- `BREVO_SMTP_FROM` (the sender address) is still used by the API provider and must remain.

### 5.2 — `docs/deployment/tier0.md` — `TRUST_PROXY` setting

The Render environment variable table must include `TRUST_PROXY=1`. Without this, `req.ip` resolves to Render's internal
load balancer IP rather than the real client IP, which breaks:

- The OTP verify IP-level rate limiter (all users appear to come from the same IP)
- The contact reveal gate fingerprinting (all guest fingerprints collide)
- The `express-rate-limit` auth limiter IP keying

This is a security-relevant misconfiguration, not a cosmetic issue. The doc must explain why `TRUST_PROXY=1` is
required, not just list it as a table row.

The current `.env.render` file sets `TRUST_PROXY=false`. The tier0 guide must add a callout: "The `.env.render` file is
provided as a reference of what is currently deployed and has `TRUST_PROXY=false` — **this is a misconfiguration that
must be corrected** in the Render dashboard. The correct value for Render's proxy architecture is `TRUST_PROXY=1`."

### 5.3 — `docs/deployment/tier0.md` — `NODE_ENV` clarification

The `.env.render` file now has `NODE_ENV=production` (not `development`). Update any tier0 doc language that previously
said the file uses `development` for local testing. The current state is: both the local reference file and the Render
dashboard should use `NODE_ENV=production`. If you want a local file for testing against live Render services, that is a
separate `.env.render.local` file that you create manually and never commit.

### 5.4 — `docs/deployment/tier0.md` — `ALLOWED_ORIGINS` production value

The current `.env.render` file sets `ALLOWED_ORIGINS=http://localhost:5173`. This means no frontend other than a local
dev server can make credentialed cross-origin requests to the live API. The tier0 guide must include a callout
explaining:

- The placeholder value `http://localhost:5173` is intentional for the initial deployment phase when no frontend is yet
  deployed.
- When a frontend is deployed (e.g. to Vercel or Netlify), this value must be updated in the Render dashboard to the
  production frontend URL (e.g. `https://roomies.vercel.app`).
- The value is a comma-separated list for multiple origins: `https://roomies.vercel.app,https://www.roomies.in`.

### 5.5 — `docs/deployment/tier0.md` — Database and Redis reality

The tier0 guide must document the actual service providers being used:

- Database is **Neon PostgreSQL** (not Azure PostgreSQL). The connection string uses the pooler endpoint (`-pooler.` in
  the hostname) which is required for Render's serverless-like instances to avoid exhausting connection limits. Direct
  connections without `-pooler` may work locally but will exhaust Neon's connection quota under load.
- Redis is **Upstash** on port **6379** (not 6380). The `rediss://` scheme indicates TLS. The Upstash free tier is
  sufficient for development but will hit the 500K command/month ceiling under sustained BullMQ polling. For production
  load, upgrade to a paid Upstash plan.

### 5.6 — Live API base URL in all deployment docs

Add a banner at the top of `docs/deployment/tier0.md` and a note in `docs/API.md`:

```
Live API base URL: https://roomies-api.onrender.com/api/v1
Health check:      https://roomies-api.onrender.com/api/v1/health
```

This is the URL integrators should use when testing against the live deployment. The local development URL remains
`http://localhost:3000/api/v1`.

---

## Phase 6 — Final Consistency Pass

After completing all phases above, perform the following cross-cutting checks in order.

### 6.1 — Hyperlink audit

Every cross-reference in every doc file must be a working relative hyperlink. Specifically:

- Every feature doc must have a link back to `./conventions.md` at or near the top.
- `docs/README.md` must link to every file in `docs/api/`.
- `docs/API.md` feature docs list must include every file in `docs/api/` and all links must resolve.
- Phase 5.6 live URL banners must be present.

### 6.2 — UUID consistency audit

The canonical UUIDs from `docs/api/conventions.md` must be used in every scenario in every feature doc. Verify no doc
invents a UUID that is not in the conventions file. If a new entity type needs a canonical example UUID (e.g. a report
ID or a session ID), add it to conventions.md and use it everywhere.

The current canonical set:

- Student: `11111111-1111-4111-8111-111111111111`
- PG owner: `22222222-2222-4222-8222-222222222222`
- Admin: `33333333-3333-4333-8333-333333333333`
- Property: `44444444-4444-4444-8444-444444444444`
- Listing: `55555555-5555-4555-8555-555555555555`
- Interest request: `66666666-6666-4666-8666-666666666666`
- Connection: `77777777-7777-4777-8777-777777777777`
- Rating: `88888888-8888-4888-8888-888888888888`
- Report: `99999999-9999-4999-8999-999999999999`
- Session ID: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`

### 6.3 — HTTP status code table in `docs/API.md`

Section 20 of `docs/API.md` must include these entries (add or correct as needed):

- `202` — Accepted: async processing started (photo upload `POST /listings/:listingId/photos`)
- `503` — Service unavailable: dependency unhealthy (health endpoint degraded response) AND photo processing queue
  temporarily unavailable (from `photo.service.js` when BullMQ enqueue fails)

### 6.4 — Pagination constraint in `docs/API.md`

Section 19 must explicitly state: "`cursorTime` and `cursorId` must be provided together or both omitted. Providing
exactly one of the two returns a `400` validation error." Include the exact validation error shape:

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [{ "field": "query.cursorTime", "message": "cursorTime and cursorId must be provided together" }]
}
```

### 6.5 — Paise rule consistency

Every endpoint that involves `rentPerMonth` or `depositAmount` must include a note in its request contract table:
"Values are in rupees. The API accepts and returns rupees; internal storage uses paise (multiply by 100)." Verify this
note is present in `POST /listings`, `PUT /listings/:listingId`, `GET /listings` (search results),
`GET /listings/:listingId`, and `GET /listings/me/saved`.

### 6.6 — `docs/API.md` stale inline content

`docs/API.md` contains several inline endpoint descriptions that duplicate or contradict the feature docs (e.g. an
inline `POST /auth/google/callback` section, inline student/PG owner profile sections). These should be removed and
replaced with links to the feature docs. The API.md file's role is the "front door" — transport rules, shared response
envelopes, pagination, status codes, and links to feature docs. It is not a second copy of the feature docs.

---

## Deliverables Checklist

When all phases are complete, each of these statements must be true:

- [ ] Every endpoint in `src/routes/` has at least one named success scenario and a named scenario for every
      `throw new AppError(...)` and every PostgreSQL constraint code path in the service.
- [ ] The `EMAIL_PROVIDER=brevo-api` discrepancy is resolved in both code and docs.
- [ ] `docs/deployment/tier0.md` documents `EMAIL_PROVIDER=brevo-api`, `TRUST_PROXY=1` with explanation, the Neon
      PostgreSQL connection requirements, and the live API URL.
- [ ] The `TRUST_PROXY=false` misconfiguration in `.env.render` is called out as a known issue requiring correction in
      the Render dashboard.
- [ ] `docs/TechStack.md` BullMQ queue table includes all three queues.
- [ ] `docs/TechStack.md` describes the `verificationEventWorker` as a CDC outbox drainer.
- [ ] `docs/ImplementationPlan.md` source file inventory includes `emailWorker.js`, `emailQueue.js`,
      `verificationEventWorker.js`, and `guestListingGate.js`.
- [ ] The `trg_verification_status_changed` trigger is in the DB trigger reference table.
- [ ] `docs/README.md` links to every file in `docs/api/`.
- [ ] All hyperlinks between doc files resolve correctly.
- [ ] All scenario response bodies use the exact error strings from the source code, not paraphrases.
- [ ] All scenarios use canonical UUIDs from `docs/api/conventions.md`.
- [ ] Every scenario involving rent/deposit states that values are in rupees.
- [ ] The live API URL `https://roomies-api.onrender.com/api/v1` appears in the appropriate deployment docs and is
      consistent across all files that reference it.

---

## Source File Quick-Reference Table

| Feature                  | Routes                                       | Validators                              | Service                                                                       | Controller                                     |
| ------------------------ | -------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Auth                     | `routes/auth.js`                             | `validators/auth.validators.js`         | `services/auth.service.js`                                                    | `controllers/auth.controller.js`               |
| Student profiles & prefs | `routes/student.js`                          | `validators/student.validators.js`      | `services/student.service.js`                                                 | `controllers/student.controller.js`            |
| PG owner profiles        | `routes/pgOwner.js`                          | `validators/pgOwner.validators.js`      | `services/pgOwner.service.js`                                                 | `controllers/pgOwner.controller.js`            |
| Properties               | `routes/property.js`                         | `validators/property.validators.js`     | `services/property.service.js`                                                | `controllers/property.controller.js`           |
| Listings                 | `routes/listing.js`                          | `validators/listing.validators.js`      | `services/listing.service.js`                                                 | `controllers/listing.controller.js`            |
| Photos                   | `routes/listing.js`                          | `validators/photo.validators.js`        | `services/photo.service.js`                                                   | `controllers/photo.controller.js`              |
| Interests                | `routes/interest.js`, `routes/listing.js`    | `validators/interest.validators.js`     | `services/interest.service.js`                                                | `controllers/interest.controller.js`           |
| Connections              | `routes/connection.js`                       | `validators/connection.validators.js`   | `services/connection.service.js`                                              | `controllers/connection.controller.js`         |
| Notifications            | `routes/notification.js`                     | `validators/notification.validators.js` | `services/notification.service.js`                                            | `controllers/notification.controller.js`       |
| Ratings                  | `routes/rating.js`                           | `validators/rating.validators.js`       | `services/rating.service.js`                                                  | `controllers/rating.controller.js`             |
| Reports                  | `routes/rating.js`                           | `validators/report.validators.js`       | `services/report.service.js`                                                  | `controllers/report.controller.js`             |
| Verification (admin)     | `routes/admin.js`                            | `validators/verification.validators.js` | `services/verification.service.js`                                            | `controllers/verification.controller.js`       |
| Preferences              | `routes/preferences.js`, `routes/student.js` | `validators/preferences.validators.js`  | `services/preferences.service.js`                                             | `controllers/preferences.controller.js`        |
| Contact reveal gate      | `routes/student.js`, `routes/pgOwner.js`     | —                                       | `services/student.service.js`, `services/pgOwner.service.js`                  | `middleware/contactRevealGate.js`              |
| Health                   | `routes/health.js`                           | —                                       | —                                                                             | —                                              |
| Error shapes             | —                                            | —                                       | —                                                                             | `middleware/errorHandler.js`                   |
| Cron behaviour           | —                                            | —                                       | `cron/listingExpiry.js`, `cron/expiryWarning.js`, `cron/hardDeleteCleanup.js` | —                                              |
| Email delivery           | —                                            | —                                       | `services/email.service.js`                                                   | `workers/emailWorker.js`                       |
| CDC outbox               | —                                            | —                                       | `workers/verificationEventWorker.js`                                          | Trigger in `002_verification_event_outbox.sql` |
