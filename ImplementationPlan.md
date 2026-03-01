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
      ├── phase1/foundation   ✅ MERGED
      ├── phase1/auth         ✅ MERGED
      ├── phase1/institutions (next — depends on auth merged)
      └── phase1/verification (depends on institutions merged)
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

**What the next branch (`phase1/auth`) inherits from this:**
- `config` object with all validated env vars
- `pool` for all database queries
- `redis` client for OTP TTL storage
- `logger` for structured logging
- `AppError` for throwing known errors
- `validate(schema)` for request validation on every route
- `rootRouter` — import and mount auth routes here

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

**Verified:**
- `POST /api/v1/auth/register` → 201 with `accessToken`, `refreshToken`, `user` shape
- `POST /api/v1/auth/login` → 200 tokens; same "Invalid credentials" error for missing email and wrong password (anti-enumeration)
- `POST /api/v1/auth/logout` → deletes `refreshToken:{userId}` from Redis; subsequent refresh rejected
- `POST /api/v1/auth/refresh` → issues new access token; rejects revoked tokens and inactive accounts
- `POST /api/v1/auth/otp/send` → OTP bcrypt-hashed in Redis at `otp:{userId}`, TTL 600s; Ethereal preview URL logged
- `POST /api/v1/auth/otp/verify` → flips `is_email_verified = TRUE`; 5-attempt lockout returns 429
- `GET /api/v1/auth/me` → returns `req.user` shape only, no password hash or sensitive fields
- `GET /api/v1/students/:userId/profile` → 400 on invalid UUID, 404 on missing profile, 200 with joined record
- `PUT /api/v1/students/:userId/profile` → 403 when `requestingUserId !== targetUserId`; partial updates work
- `GET /api/v1/pg-owners/:userId/profile` → same UUID validation and join pattern as student
- `PUT /api/v1/pg-owners/:userId/profile` → ownership check + dynamic SET clause from provided fields only
- `authorize('admin')` called with undefined/empty string → throws `Error` at route registration time, not per-request
- Rate limiters hit → `RateLimit-*` headers returned; `X-RateLimit-*` headers absent

**Post-merge hardening applied to this level (all changes are in the merged code):**

1. **`findUserById` correlated subquery** (`src/db/utils/auth.js`) — PostgreSQL does not permit `ORDER BY` inside `ARRAY_AGG(DISTINCT ...)` in the same clause; roles are deduplicated via an inner `SELECT DISTINCT` subquery and sorted by the outer `ARRAY_AGG(... ORDER BY ...)`. The old JOIN + GROUP BY is removed entirely.
2. **`authorize` call-time role validation** (`src/middleware/authorize.js`) — the factory now validates the `role` argument when `authorize(role)` is called (at module load / route registration), throwing a plain `Error` immediately if the role is missing or not a non-empty string. A silent per-request 403 on every route was unacceptable.
3. **Concurrent registration race hardened** (`src/services/auth.service.js`) — the `users` INSERT is wrapped in its own try/catch inside the transaction; `err.code === "23505"` maps to `AppError(409)`. The pre-check remains as the cheap common-case early exit; this is the second line of defence for the narrow concurrent window.
4. **Login timing side-channel closed** (`src/services/auth.service.js`) — `DUMMY_HASH` (a pre-computed bcrypt hash) is used when `findUserByEmail` returns null, ensuring `bcrypt.compare` always runs regardless of whether the email exists. The `account_status` check is moved to after a successful password comparison so response time is equalized across all 401 paths.
5. **Refresh path enforces `account_status`** (`src/services/auth.service.js`) — the `SELECT` that reloads the user now includes `account_status`; suspended/banned/deactivated accounts receive `AppError("Account inactive", 401)` and cannot obtain new access tokens even with a cryptographically valid refresh token.
6. **OTP exhaustion returns 429 on final attempt** (`src/services/auth.service.js`) — the `AppError` status is now `remaining > 0 ? 400 : 429`, aligning the call that causes lockout with all subsequent calls after lockout.
7. **OTP format guard in email service** (`src/services/email.service.js`) — `/^[0-9]{6}$/.test(otp)` added after the typeof check; `sendOtpEmail` is safe to call from any future context regardless of upstream validation.
8. **`maskEmail` empty-local guard** (`src/services/email.service.js`) — `local[0]` is only accessed when `local.length > 0`; an input of `"@domain.com"` no longer produces `"undefined****@domain.com"` in log output.
9. **`INACTIVE_STATUSES` hoisted to module scope** (`src/middleware/authenticate.js`) — the `Set` is allocated once at module load rather than on every authenticated request; named `INACTIVE_STATUSES` in screaming snake case to signal it is a process-lifetime constant.
10. **`crypto.randomInt` upper bound corrected** (`src/services/auth.service.js`) — changed from `999999` (exclusive, never reached) to `1000000` so the full six-digit range `100000–999999` is reachable.
11. **`otpVerifySchema` digit-only constraint** (`src/validators/auth.validators.js`) — `z.string().regex(/^\d{6}$/)` instead of length-only check; rejects inputs like `"ab1234"`.
12. **Params UUID validation on GET profile routes** (`src/validators/`) — `getStudentParamsSchema` and `getPgOwnerParamsSchema` reject non-UUID `:userId` params with a structured 400 before the controller runs, preventing PostgreSQL parse errors.

**Security decisions documented (carry these forward):**

The `DUMMY_HASH` constant in `auth.service.js` is a bcrypt hash of the string `"dummy"` at 10 rounds. It exists solely to equalise response timing for the login path — never to authenticate anything. Do not remove it. Do not replace it with a fresh `bcrypt.hash()` call at runtime (that would create a new timing variance). The value is hardcoded intentionally.

The OTP verify route (`POST /api/v1/auth/otp/verify`) deliberately has no `otpLimiter` applied. The route requires a valid JWT (`authenticate` middleware), and the service-layer attempt counter at `otpAttempts:{userId}` (5 wrong → 429 lockout, same TTL as the OTP itself) provides the relevant throttle at the OTP level rather than the IP level. Adding an IP-based rate limiter here would create a confusing dual-throttle with different semantics and different Redis keys.

GET profile routes for both `/students/:userId/profile` and `/pg-owners/:userId/profile` are intentionally readable by any authenticated user — not scoped to the profile owner. Students must be able to view each other's profiles for roommate compatibility evaluation and must be able to view PG owner profiles to evaluate listing credibility. PUT ownership is enforced in the service layer. This is not an IDOR — it is the core product read model.

**What the next branch (`phase1/institutions`) inherits from this:**
- `authenticate` and `authorize` middleware stable and in use on every protected route
- `req.user` shape locked: `{ userId, email, roles, isEmailVerified, accountStatus }`
- `findUserById` and `findUserByEmail` are the canonical identity query functions — do not duplicate them
- The `register` transaction in `auth.service.js` is the exact insertion point for institution domain lookup — `client` is already in scope at `await client.query("BEGIN")`, and `institution_id` can be written to `student_profiles` in the same `BEGIN / COMMIT` block without restructuring anything
- `authorize('admin')` is ready to gate the verification queue endpoint — no further middleware work needed
- `rateLimiter.js` is the single source for all rate limiter instances — add new limiters here, never inline on routes

---

### Level 2 — Institution + Verification `phase1/institutions` (not started)

**Blocked by:** `phase1/auth` merged into `Phase1` ✅

**What gets built:**

`src/db/utils/institutions.js` with `findInstitutionByDomain(domain, client?)` — called at every student registration. The registration flow is completed here: extract domain from email, call `findInstitutionByDomain()`, on match set `is_email_verified = TRUE` and write `institution_id` to `student_profiles` in the same transaction as the user insert.

The PG owner document upload endpoint writes rows to `verification_requests` with `status = pending` and `document_type` from the upload. The admin verification queue endpoint — protected by `authorize('admin')` — returns pending requests sorted oldest-first using the `(status, submitted_at)` composite index.

**What you can test when this level is done:**

Register a student with a college email domain — `is_email_verified` is `TRUE` automatically and `institution_id` is populated. Register a student with a non-college email — `is_email_verified` stays `FALSE`. Upload a document as a PG owner — `verification_requests` row appears. Hit the admin queue as a non-admin — `403`. Hit it as an admin — pending requests appear oldest-first.

**Phase 1 is the most important phase to get completely right.** Every subsequent feature depends on the token, the user shape, and the role system being airtight. A subtle bug here — a missing role check, a token that doesn't expire, a user query that returns the wrong shape — will silently corrupt every feature built on top of it.

---

## Phase 2 — Listings & Search

**Build order levels covered:** 3, 4

**Entry condition:** Phase 1 is stable and tested. A verified PG owner exists in the database. A verified student exists in the database.

**Goal:** A PG owner can create a property and attach listings to it. A student can search for listings by city, rent range, room type, and proximity to a location. Photos upload and get compressed. Compatibility scores appear on search results. A student can save listings.

**What gets built:**

The listings layer (`Level 3`) is the largest single build level in the project. It starts with amenity seeding — inserting the master amenity list into the database so that listings can reference them. Property CRUD comes next, gated behind `authorize('pg_owner')` and a secondary ownership check (a PG owner cannot edit another owner's property). Listing CRUD follows, with the student versus PG owner branching logic: when `property_id` is provided, the listing belongs to a property; when it is `NULL`, the listing is a student room posting.

The search endpoint combines two query types that must be merged. The dynamic parameterised `WHERE` clause handles city, rent range, room type, gender preference, available_from, listing_type, and amenity filters — all optional. The PostGIS proximity component calls `findListingsNearPoint(lat, lng, radiusMeters, client)` in `src/db/utils/spatial.js`, returning listing IDs within the radius using `ST_DWithin`. Those IDs are merged with the filter results. `scoreListingsForUser(userId, listingIds, client)` in `src/db/utils/compatibility.js` appends a compatibility percentage to each listing card by JOINing `listing_preferences` against `user_preferences`. All search parameters are Zod-validated before the first query runs.

The media layer (`Level 4`) introduces the `StorageService` interface with two implementations: `LocalDiskAdapter` for development (writes to `/uploads/`, served via Express static middleware already wired in `app.js`) and `AzureBlobStorageAdapter` for production. The Sharp compression pipeline moves into the `media-processing-queue` BullMQ worker — HTTP response returns immediately, compressed WebP replaces the original asynchronously. `STORAGE_ADAPTER` env var (already in Zod schema) controls which adapter is active.

**What you can test when Phase 2 is done:**

A PG owner can create a property with lat/lng and see the `location` geometry column populated automatically by the trigger. A student can search by city and receive active listings. A student with preferences set receives compatibility scores. A photo uploads and the compressed WebP version appears.

---

## Phase 3 — Interaction Pipeline & Contact

**Build order levels covered:** 5, 6

**Entry condition:** Phase 2 is stable and tested. At least one active listing exists posted by a verified PG owner. At least one verified student exists with preferences set.

**Goal:** A student can express interest in a listing. A PG owner can accept or decline. On acceptance, a connection is created and the student receives the poster's WhatsApp deep-link. Both parties can confirm the interaction happened. The notification feed works.

**What gets built:**

The interest and connections layer (`Level 5`) — every state transition in the interest request state machine must be atomic. Interest request insert + notification for the poster go in one `BEGIN / COMMIT`. When a PG owner accepts, the status update on `interest_requests` and the creation of the `connections` row go in one transaction — if either fails, both roll back. Post-commit: notification dispatched via `notification-queue`, PG owner's WhatsApp number returned as `wa.me/91XXXXXXXXXX` deep-link.

Two-sided confirmation: either party flips their own confirmed flag. After each flip, the service checks whether both are `TRUE` — if so, `confirmation_status = confirmed` in the same transaction as the flag update.

The notifications layer (`Level 6`) adds HTTP endpoints: unread count, paginated feed, mark-as-read. The `notification-queue` BullMQ worker is wired here.

**What you can test when Phase 3 is done:**

Student sends interest → PG owner gets notification. PG owner accepts → `connections` row with `confirmation_status = pending`, student gets WhatsApp deep-link. Both flip confirmed flags → `confirmation_status = confirmed`. Notification bell shows correct unread count.

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
| 1 — Foundation & Identity | 0, 1, 2 | Levels 0 + 1 ✅ | Register, log in, verify, upload documents | Schema applied, `.env.local` valid |
| 2 — Listings & Search | 3, 4 | Not started | Post listings, search by filters + proximity, photos, compatibility scores | Phase 1 stable |
| 3 — Interaction Pipeline | 5, 6 | Not started | Send interest, accept/decline, WhatsApp contact, confirm interactions, notification feed | Phase 2 stable |
| 4 — Reputation System | 7 | Not started | Rate users and properties, report ratings, admin moderation, cached averages | Phase 3 stable |
| 5 — Operations & Admin | 8, 9 | Not started | Auto-expiry, cleanup cron, full admin control panel, analytics | Phase 4 stable |
| 6 — Real-Time (Future) | 10 | Deferred | Push notifications via WebSocket, replaces polling | Phase 3 polling confirmed, real users exist |

---

*— Last updated: phase1/auth merged (post-review hardening applied) —*