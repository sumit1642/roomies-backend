# Roomies — Phased Build Plan

**Derived from the Project Plan & System Design**
Each phase delivers a working, testable slice of the platform. No phase begins until the previous one is stable. Every level number refers directly to the build order in the main project plan.

---

## How to Read This Document

Each phase has a clear **entry condition** (what must be true before you start), a **goal** (what the platform can do when the phase is done), and a precise list of what gets built. The phases are not arbitrary time-boxes — they are dependency-driven. You cannot meaningfully test Phase 2 without Phase 1 being solid, and you cannot generate the confirmed connections that Phase 4 depends on without Phase 3 being complete.

The rule for moving between phases is simple: every endpoint built in a phase must be manually testable with real HTTP requests before the next phase begins. If something is broken and you move forward anyway, the next phase inherits that brokenness and the problem compounds.

---

## Branching Strategy

Each phase is broken into sub-branches that merge sequentially into the phase branch before anything goes to `main`:

```
main
 └── Phase1
      ├── phase1/foundation       ✅ MERGED
      ├── phase1/auth             ✅ MERGED
      ├── phase1/institutions     ✅ MERGED
      ├── phase1/auth-transport   ✅ MERGED
      └── phase1/verification     ← NEXT (unblocked)
```

**Rule:** Each branch depends on the previous being merged into `Phase1` first. No parallel work — each imports from what the previous produced.

---

## Established Conventions (Set in phase1/foundation — must be followed in all future phases)

These decisions were made during `phase1/foundation` and apply to every file written from this point forward.

### File Path Comment
Every file must have its relative path as the first comment line:
```js
// src/routes/auth.js
```

### Environment Files
- `.env.local` — local development (PostgreSQL + Redis on host)
- `.env.azure` — Azure connectivity check only, never for day-to-day dev
- `ENV_FILE` environment variable controls which file is loaded, set by npm scripts
- `src/config/env.js` reads `process.env.ENV_FILE` first, falls back to `.env.local` then `.env`
- **All new env variables must be added to the Zod schema in `src/config/env.js` before use** — the server refuses to start if any required variable is missing

### npm Scripts
```bash
npm run dev          # ENV_FILE=.env.local — daily development
npm run dev:azure    # ENV_FILE=.env.azure — Azure connectivity check only
npm start            # ENV_FILE=.env.local — production start
npm run start:azure  # ENV_FILE=.env.azure — production start on Azure
```

### Config Object
`config` is the single source of truth for all environment variables. **Never read `process.env` directly in application code** — always import `config` from `src/config/env.js`. `ALLOWED_ORIGINS` is pre-parsed into an array at startup.

### CORS
- Development: `origin: true` (reflects incoming Origin, works with credentials)
- Production: `origin: config.ALLOWED_ORIGINS` (whitelist array parsed from `ALLOWED_ORIGINS` env var)
- `credentials: true` always set — never use `origin: '*'` with credentials

### Validation Middleware
`validate(schema)` from `src/middleware/validate.js` wraps any Zod schema and returns Express middleware. After successful parse, `result.data` is written back to `req.body`, `req.query`, and `req.params` — downstream handlers always see coerced types and Zod defaults.

Usage on every route:
```js
router.post('/register', validate(registerSchema), authController.register)
```

Schema structure:
```js
const registerSchema = z.object({
  body: z.object({ ... }),
  query: z.object({ ... }).optional(),
  params: z.object({ ... }).optional(),
})
```

### Error Handling
- Throw `new AppError(message, statusCode)` for all known, intentional errors — imported from `src/middleware/errorHandler.js`
- Pass unknown errors to `next(err)` — the global handler covers Zod, AppError, PostgreSQL constraint errors (`23505`, `23503`, `23514`), and JWT errors
- `res.headersSent` is checked at the top of the error handler — never causes a double-response crash
- **Never expose stack traces or raw error objects in responses**

### Zod v4 API (used throughout — not v3)
| Feature | Correct (v4) | Deprecated (v3) |
|---|---|---|
| Email validation | `z.email()` | `z.string().email()` |
| URL validation | `z.url()` | `z.string().url()` |
| UUID validation | `z.uuid()` | `z.string().uuid()` |
| Error list property | `error.issues` | `error.errors` |
| Error message param | `{ error: '...' }` | `{ message: '...' }` |

`z.url()` in v4 uses the native `URL()` constructor and accepts `postgresql://` and `redis://` — no custom refine needed.

### Health Check
`GET /api/v1/health` — returns `200` with both services `ok`, or `503` with `degraded` status and the specific error message per service. Each probe has a 3-second timeout via `Promise.race`. Always keep this endpoint passing before merging any branch.

### Graceful Shutdown
`server.js` handles `SIGINT` and `SIGTERM` — stops accepting connections, drains in-flight requests via `server.close()`, closes the pg pool via `pool.end()`, and force-exits after 10 seconds. This is already in place; future phases do not need to touch `server.js` unless adding new cleanup targets (e.g. Redis disconnect, BullMQ worker shutdown).

### Database Queries
- Import `pool` from `src/db/client.js` for one-shot queries: `pool.query(text, params)`
- For transactions, check out a client: `const client = await pool.connect()` then `BEGIN / COMMIT / ROLLBACK` manually, always `client.release()` in a `finally` block
- Stable, reused queries go in `src/db/utils/` — one file per concern
- One-off or evolving queries live inline in the service file with a comment

### Logging
Import `logger` from `src/logger/index.js`. Use structured logging: `logger.info({ userId, listingId }, 'Interest request created')`. Never `console.log` in application code.

### Auth Transport (Set in phase1/auth-transport — must be followed in all future phases)

These decisions were made during `phase1/auth-transport` and apply to every authentication entry point added from this point forward.

**Dual-delivery on every auth response.** Login, register, and any future OAuth callback must always do both: set `accessToken` and `refreshToken` as HttpOnly cookies on the response AND include both tokens in the JSON body. Browser clients use the cookies (ignore the body); Android clients use the body (ignore the cookies). Never do only one or the other.

**Cookie options are fixed.** Every `res.cookie()` call for auth tokens must use `httpOnly: true`, `secure: config.NODE_ENV === 'production'`, `sameSite: 'strict'`, and `maxAge` derived from `parseTtlSeconds()` (exported from `auth.service.js`) multiplied by 1000 for milliseconds. These options must be identical between the set call and the clear call — a mismatch causes browsers to treat them as different cookies.

**`parseTtlSeconds` is the single TTL source of truth.** It is exported from `src/services/auth.service.js`. Import it when any code needs to compute a duration from `JWT_EXPIRES_IN` or `JWT_REFRESH_EXPIRES_IN`. Never hardcode TTL values or duplicate the parsing logic.

**Silent refresh is cookie-only.** The `authenticate` middleware attempts silent refresh exclusively when the expired token came from `req.cookies.accessToken`. An expired token in an `Authorization: Bearer` header always returns a 401 immediately — the Android client handles refresh explicitly. This rule must not be changed; violating it would stale Android's stored token with no recovery path.

**`buildTokenResponse` is the canonical token-issuing function** in `auth.service.js`. All future authentication paths (OAuth, magic link, etc.) must go through it to ensure consistent token shape and Redis storage.

---

## Phase 1 — Foundation & Identity

**Build order levels covered:** 0, 1, 2

**Entry condition:** PostgreSQL running locally with the schema applied from `roomies_db_setup.sql`. Redis running locally. A `.env.local` file present with all required variables. The Zod env validation at startup must pass cleanly before any other work begins.

**Goal:** A person can register as a student or PG owner, log in with email/password or Google OAuth, receive an OTP, and the server correctly identifies who they are on every subsequent request. Institution auto-verification works. PG owner document upload creates a `verification_requests` row. An admin can see the verification queue.

---

### Level 0 — Foundation `phase1/foundation` ✅ COMPLETE

**Branch:** `phase1/foundation` → merged into `Phase1`

**What was built:**

```
src/
  server.js             — entry point: DB connect → Redis connect → listen → graceful shutdown
  app.js                — Express app, all global middleware in order
  config/
    env.js              — Zod v4 env validation at startup, ENV_FILE support, config export
  db/
    client.js           — pg.Pool singleton (max 20, idle 30s, connect timeout 5s)
  cache/
    client.js           — Redis client singleton via official redis package
  logger/
    index.js            — Pino logger, pino-pretty in dev, raw JSON in prod
  middleware/
    errorHandler.js     — AppError class + global error handler (Zod, PG constraints, JWT)
    validate.js         — Zod validation middleware factory, writes result.data back to req
  routes/
    index.js            — rootRouter mounted at /api/v1
    health.js           — GET /api/v1/health with 3s timeout probes per service
.env.example            — all required variables documented, safe to commit
.gitignore              — covers .env.local, .env.azure, uploads/, logs/
package.json            — final dependency list, env-aware npm scripts
```

**Verified:**
- `GET /api/v1/health` → `200` with PostgreSQL and Redis both `ok`
- Missing env variable at startup → process exits with clear Zod error naming the exact variable
- `GET /` → `404` JSON (correct — no root route)
- `npm run dev` loads `.env.local`, `npm run dev:azure` loads `.env.azure`

---

### Level 1 — Auth + Identity `phase1/auth` ✅ COMPLETE

**Branch:** `phase1/auth` → merged into `Phase1`

**What was built:**

```
src/
  db/utils/
    auth.js               — findUserById, findUserByEmail; OAuth placeholder stub
  middleware/
    authenticate.js       — JWT Bearer verification + req.user attachment
    authorize.js          — role gate factory; validates role arg at call time, not per-request
    rateLimiter.js        — authLimiter (10/15min), otpLimiter (5/15min); RFC 6585 headers
  validators/
    auth.validators.js    — registerSchema, loginSchema, refreshSchema, otpVerifySchema
    student.validators.js — getStudentParamsSchema, updateStudentSchema
    pgOwner.validators.js — getPgOwnerParamsSchema, updatePgOwnerSchema
  services/
    auth.service.js       — register, login, logout, refresh, sendOtp, verifyOtp
    email.service.js      — Nodemailer transport (Ethereal in dev); OTP email dispatch
    student.service.js    — getStudentProfile, updateStudentProfile
    pgOwner.service.js    — getPgOwnerProfile, updatePgOwnerProfile
  controllers/
    auth.controller.js    — thin wrappers: register, login, logout, refresh, sendOtp, verifyOtp, me
    student.controller.js — getProfile, updateProfile
    pgOwner.controller.js — getProfile, updateProfile
  routes/
    auth.js               — 7 auth endpoints with rate limiters at router edge
    student.js            — GET + PUT /:userId/profile
    pgOwner.js            — GET + PUT /:userId/profile
    index.js              — mounts /auth, /students, /pg-owners (updated from foundation)
```

**Post-merge hardening applied (all in merged code):** `findUserById` correlated subquery for ARRAY_AGG; `authorize` call-time role validation; concurrent registration race handled with inner try/catch on 23505; login timing side-channel closed with `DUMMY_HASH`; refresh path enforces `account_status`; OTP exhaustion returns 429 on final attempt; OTP format guard in email service; `maskEmail` empty-local guard; `INACTIVE_STATUSES` hoisted to module scope; `crypto.randomInt` upper bound corrected to 1000000; `otpVerifySchema` digit-only regex; UUID validation on GET profile param routes.

**Security decisions (carry forward):** `DUMMY_HASH` is hardcoded intentionally — never replace with a runtime `bcrypt.hash()` call. OTP verify route deliberately has no `otpLimiter` — service-layer attempt counter provides the throttle. GET profile routes are intentionally world-readable by any authenticated user; this is the core product read model, not an IDOR.

---

### Level 2 — Institution + Verification `phase1/institutions` ✅ COMPLETE

**Branch:** `phase1/institutions` → merged into `Phase1`

**Sub-system 1 — Institution Auto-Verification:** `src/db/utils/institutions.js` exports `findInstitutionByDomain(domain, client?)`. Called inside the registration transaction after the `student_profiles` INSERT. On a domain match: updates `institution_id` on `student_profiles` and flips `is_email_verified = TRUE` on `users`, both in the same `BEGIN/COMMIT` block. The `effectivelyVerified` variable tracks the post-UPDATE state separately from the stale `RETURNING` value.

**Sub-system 2 — PG Owner Verification Pipeline:** Four service functions in `src/services/verification.service.js`: `submitDocument`, `getVerificationQueue`, `approveRequest`, `rejectRequest`. Admin router at `src/routes/admin.js` with router-level `authenticate` + `authorize('admin')`. Keyset pagination on the queue (compound cursor on `submitted_at + request_id`). Concurrency safety on approve/reject via `AND status = 'pending'` conditional update — `rowCount === 0` returns 409.

**Files built:** `src/db/utils/institutions.js` (new), `src/services/verification.service.js` (new), `src/controllers/verification.controller.js` (new), `src/validators/verification.validators.js` (new), `src/routes/admin.js` (new), `src/services/auth.service.js` (modified), `src/routes/pgOwner.js` (modified), `src/routes/index.js` (modified).

---

### Level 2.5 — Dual-Client Auth Transport `phase1/auth-transport` ✅ COMPLETE

**Branch:** `phase1/auth-transport` → merged into `Phase1`

**The problem solved:** The backend previously returned tokens only in the JSON body and read the access token only from `Authorization: Bearer`. This is correct for Android but incomplete for browsers, where HttpOnly cookies are required to eliminate XSS token theft.

**The solution:** Three files changed. No other files were touched.

`src/services/auth.service.js` — `parseTtlSeconds` promoted from a private `const` to a named export. This is the single source of truth for TTL arithmetic; the controller imports it to calculate cookie `maxAge` so the cookie and the JWT always expire together.

`src/controllers/auth.controller.js` — `setAuthCookies(res, accessToken, refreshToken)` called at the end of both `register` and `login`, before the `res.json()` call. `clearAuthCookies(res)` called in `logout`. The JSON body response is kept fully intact in all three handlers — this is purely additive. Cookie options (`ACCESS_COOKIE_OPTIONS`, `REFRESH_COOKIE_OPTIONS`) are defined as module-level constants using `parseTtlSeconds` so they are computed once at startup and are guaranteed consistent between set and clear calls.

`src/middleware/authenticate.js` — restructured around two new private functions. `extractToken(req)` implements the priority chain: checks `req.cookies.accessToken` first and returns `{ token, source: 'cookie' }`; falls through to `Authorization: Bearer` and returns `{ token, source: 'header' }`; returns `null` if neither is present. `attemptSilentRefresh(req, res)` is called only when `jwt.verify` throws `TokenExpiredError` and `source === 'cookie'`. It validates the refresh token cookie against both the JWT secret and the Redis-stored value, loads fresh roles and email from the DB (never trusts the potentially 7-day-old refresh token payload), signs a new access token, sets it as a replacement `accessToken` cookie on `res`, and returns the `userId`. The main middleware then loads the user from the DB normally using that `userId`. If silent refresh fails for any reason (expired refresh token, Redis mismatch, deleted user), it returns `null` and the middleware issues a 401. An expired token arriving via `Authorization: Bearer` always goes directly to `next(err)` without touching the silent refresh path.

**How each client experiences the system:** A browser client logs in, receives cookies automatically, and never thinks about tokens again — expiry is invisible, sessions self-renew. An Android client logs in, reads tokens from the body, sends `Authorization: Bearer` on every request, receives 401 on expiry, calls `POST /auth/refresh` explicitly, and retries. Nothing changed for Android.

**Regression tests that must still pass:** All seven auth endpoints. All profile GET and PUT routes. Verification queue and resolution endpoints. Health check.

---

### Level 2.6 — Google OAuth + Verification Hardening `phase1/verification` ← NEXT

**Branch:** `phase1/verification` → merges into `Phase1`

**Unblocked by:** `phase1/auth-transport` ✅ merged

**What this branch builds:**

This branch has two independent deliverables that share a branch because both are small and both depend on the now-complete auth transport layer.

**Deliverable 1 — Google OAuth registration and login.** The `findUserByGoogleId` stub in `src/db/utils/auth.js` is completed. A new route `POST /api/v1/auth/google/callback` is added to `src/routes/auth.js`. The controller receives the Google ID token from the request body, verifies it using `google-auth-library`'s `OAuth2Client.verifyIdToken()`, and extracts the verified email and `google_id` from the payload. The service function branches on whether a user with that `google_id` already exists (login path) or not (registration path).

For the registration path, the service runs the same institution domain lookup as the email/password registration: extract the domain from the Google-verified email, call `findInstitutionByDomain(domain, client)` inside the transaction, and apply the same auto-verification logic. The key difference from email/password registration is that `password_hash` is `NULL` and `is_email_verified` starts as `TRUE` (Google has already verified the email). The transaction inserts `users`, the appropriate profile row, and `user_roles` — identical structure to the existing registration transaction.

For the login path, the service loads the existing user, checks `account_status`, loads roles, and calls `buildTokenResponse`. Both paths end at `buildTokenResponse` and the controller applies the dual-delivery pattern (`setAuthCookies` + JSON body) established in `phase1/auth-transport`.

The `refreshSchema` validator is updated to make `refreshToken` optional in the body, since browser clients calling `POST /auth/refresh` may send no body at all — they expect the middleware to read `req.cookies.refreshToken` instead. The refresh service function is updated to accept the refresh token from either source.

**Deliverable 2 — Verification pipeline hardening.** Any issues identified during review of `phase1/institutions` that were deferred are addressed here. The specific items are documented during that review and tracked as open items. At minimum this includes: ensuring the document submission endpoint validates that the authenticated user holds the `pg_owner` role (currently it only checks profile existence), and confirming the verification queue returns `user_id` alongside each request so the admin UI can deep-link to the owner's profile.

**Files that will change:**

| File | Change |
|------|--------|
| `src/db/utils/auth.js` | Complete `findUserByGoogleId` stub |
| `src/services/auth.service.js` | Add `googleOAuth` service function |
| `src/controllers/auth.controller.js` | Add `googleCallback` controller |
| `src/routes/auth.js` | Add `POST /google/callback` route |
| `src/validators/auth.validators.js` | Add `googleCallbackSchema`; update `refreshSchema` for optional body token |
| `src/services/verification.service.js` | Hardening items |
| `src/validators/verification.validators.js` | Hardening items |

---

## Phase 2 — Listings & Search

**Build order levels covered:** 3, 4

**Entry condition:** Phase 1 is fully stable and all sub-branches merged. A verified PG owner exists in the database. A verified student exists in the database.

**Goal:** A PG owner can create a property and attach listings to it. A student can search for listings by city, rent range, room type, and proximity to a location. Photos upload and get compressed. Compatibility scores appear on search results. A student can save listings.

**What gets built:**

The listings layer (`Level 3`) is the largest single build level in the project. It starts with amenity seeding — inserting the master amenity list into the database so that listings can reference them. Property CRUD comes next, gated behind `authorize('pg_owner')` and a secondary ownership check (a PG owner cannot edit another owner's property). Listing CRUD follows, with the student versus PG owner branching logic: when `property_id` is provided, the listing belongs to a property; when it is `NULL`, the listing is a student room posting.

The search endpoint combines two query types that must be merged. The dynamic parameterised `WHERE` clause handles city, rent range, room type, gender preference, available_from, listing_type, and amenity filters — all optional. The PostGIS proximity component calls `findListingsNearPoint(lat, lng, radiusMeters, client)` in `src/db/utils/spatial.js`, returning listing IDs within the radius using `ST_DWithin`. Those IDs are merged with the filter results. `scoreListingsForUser(userId, listingIds, client)` in `src/db/utils/compatibility.js` appends a compatibility percentage to each listing card by JOINing `listing_preferences` against `user_preferences`. All search parameters are Zod-validated before the first query runs.

The media layer (`Level 4`) introduces the `StorageService` interface with two implementations: `LocalDiskAdapter` for development (writes to `/uploads/`, served via Express static middleware already wired in `app.js`) and `AzureBlobStorageAdapter` for production. The Sharp compression pipeline moves into the `media-processing-queue` BullMQ worker — HTTP response returns immediately, compressed WebP replaces the original asynchronously. `STORAGE_ADAPTER` env var (already in Zod schema) controls which adapter is active.

---

## Phase 3 — Interaction Pipeline & Contact

**Build order levels covered:** 5, 6

**Entry condition:** Phase 2 is stable and tested. At least one active listing exists posted by a verified PG owner. At least one verified student exists with preferences set.

**Goal:** A student can express interest in a listing. A PG owner can accept or decline. On acceptance, a connection is created and the student receives the poster's WhatsApp deep-link. Both parties can confirm the interaction happened. The notification feed works.

**What gets built:**

The interest and connections layer (`Level 5`) — every state transition in the interest request state machine must be atomic. Interest request insert + notification for the poster go in one `BEGIN / COMMIT`. When a PG owner accepts, the status update on `interest_requests` and the creation of the `connections` row go in one transaction — if either fails, both roll back. Post-commit: notification dispatched via `notification-queue`, PG owner's WhatsApp number returned as `wa.me/91XXXXXXXXXX` deep-link.

Two-sided confirmation: either party flips their own confirmed flag. After each flip, the service checks whether both are `TRUE` — if so, `confirmation_status = confirmed` in the same transaction as the flag update.

The notifications layer (`Level 6`) adds HTTP endpoints: unread count, paginated feed, mark-as-read. The `notification-queue` BullMQ worker is wired here.

---

## Phase 4 — Reputation System

**Build order levels covered:** 7

**Entry condition:** Phase 3 stable. At least one `connections` row with `confirmation_status = confirmed` exists.

**Goal:** A participant in a confirmed connection can rate the other party or the property. Cached average updates automatically. Ratings can be reported. Admins can moderate.

**What gets built:**

Eligibility check before every rating INSERT: submitting user must be `initiator_id` or `counterpart_id` in the referenced connection and `confirmation_status = confirmed`. Polymorphic reviewee check: `reviewee_type = 'user'` → verify `reviewee_id` exists in `users`; `reviewee_type = 'property'` → verify in `properties`. Then INSERT the `ratings` row — `update_rating_aggregates` trigger fires automatically, no application code needed to update the cache.

Report submission, partial unique index prevents duplicate open reports. Admin endpoints to resolve `resolved_removed` (sets `is_visible = FALSE`, trigger recalculates average) or `resolved_kept`.

---

## Phase 5 — Operations & Admin

**Build order levels covered:** 8, 9

**Entry condition:** Phase 4 stable. Full trust pipeline works end to end.

**Goal:** Platform maintains itself without manual intervention. Full admin control panel.

**What gets built:**

`node-cron` scheduled tasks: listing expiry (daily 02:00), connection expiry (daily 03:00), expiry warning (daily 01:00), hard-delete cleanup (weekly Sunday 04:00). `email-queue` BullMQ worker wired here, consuming jobs dispatched since Level 1.

Admin-only router at `/api/v1/admin`, `authorize('admin')` on every route. Verification queue management, user account management (suspend, ban, reactivate), rating moderation, platform analytics (aggregate counts across all zones).

---

## Phase 6 — Real-Time (Future Phase)

**Build order levels covered:** 10

**Entry condition:** Phase 3 polling confirmed working. Real users exist. This phase is explicitly deferred until the core platform is live.

**Goal:** Replace polling-based notification delivery with push delivery over persistent WebSocket connections. No schema changes needed.

**What gets built:**

`ws` WebSocket server attached to the same HTTP server instance (same port as Express — the `server` instance is already captured in `server.js` and can be passed to the WebSocket server at that time). JWT from `?token=` query param on handshake. Connections tracked in a `Map` keyed by `user_id`. `NotificationService` checks the map before emitting. Redis pub/sub layer for cross-instance broadcast on Azure App Service.

---

## Phase Summary

| Phase | Levels | Status | What Becomes Possible | Hard Dependency |
|-------|--------|--------|----------------------|-----------------|
| 1 — Foundation & Identity | 0, 1, 2 | Levels 0 + 1 + 2 + 2.5 ✅, 2.6 next | Register, log in, verify, upload documents | Schema applied, `.env.local` valid |
| 2 — Listings & Search | 3, 4 | Not started | Post listings, search by filters + proximity, photos, compatibility scores | Phase 1 fully stable |
| 3 — Interaction Pipeline | 5, 6 | Not started | Send interest, accept/decline, WhatsApp contact, confirm interactions, notification feed | Phase 2 stable |
| 4 — Reputation System | 7 | Not started | Rate users and properties, report ratings, admin moderation, cached averages | Phase 3 stable |
| 5 — Operations & Admin | 8, 9 | Not started | Auto-expiry, cleanup cron, full admin control panel, analytics | Phase 4 stable |
| 6 — Real-Time (Future) | 10 | Deferred | Push notifications via WebSocket, replaces polling | Phase 3 polling confirmed, real users exist |

---

*— Last updated: phase1/auth-transport merged; phase1/verification is next (unblocked) —*