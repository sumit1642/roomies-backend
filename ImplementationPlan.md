# Roomies — Phased Build Plan

**Derived from the Project Plan & System Design**
Each phase delivers a working, testable slice of the platform. No phase begins until the previous one is stable.

---

## Project Identity

**Roomies** is a trust-first PG and roommate discovery platform for Indian college students.

| Item | Detail |
|------|--------|
| Runtime | Node.js + Express, JavaScript ES modules (`"type": "module"`) |
| Database | PostgreSQL 16 + PostGIS — raw SQL via `pg`, no ORM |
| Cache / Queue | Redis (`redis` v5) + BullMQ |
| Auth | JWT + bcryptjs + Google OAuth via `google-auth-library` |
| Validation | Zod v4 — request bodies, query params, route params, env vars at startup |
| Logging | Pino + pino-http + pino-pretty |
| Target cloud | Microsoft Azure |
| Local dev | PostgreSQL 16 + Redis installed directly on host — no Docker |

Every file begins with a path comment (`// src/routes/auth.js`). `config` from `src/config/env.js` is the single source of truth for env vars — `process.env` is never read directly in application code.

---

## How to Read This Document

Each phase has a clear **entry condition**, a **goal**, and a precise list of what gets built. The phases are dependency-driven — you cannot meaningfully test Phase 2 without Phase 1 being solid.

The rule for moving between phases: every endpoint built in a phase must be manually testable with real HTTP requests before the next phase begins.

---

## Branching Strategy

```
main
 └── Phase1
      ├── phase1/foundation       ✅ MERGED
      ├── phase1/auth             ✅ MERGED
      ├── phase1/institutions     ✅ MERGED
      ├── phase1/auth-transport   ✅ MERGED
      └── phase1/verification     ← NEXT (unblocked)
```

**Rule:** Each branch depends on the previous being merged into `Phase1` first. No parallel work.

---

## Established Conventions

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
- **All new env variables must be added to the Zod schema in `src/config/env.js` before use**

### npm Scripts
```bash
npm run dev          # ENV_FILE=.env.local — daily development
npm run dev:azure    # ENV_FILE=.env.azure — Azure connectivity check only
npm start            # ENV_FILE=.env.local — production start
npm run start:azure  # ENV_FILE=.env.azure — production start on Azure
```

### Config Object
`config` is the single source of truth for all environment variables. **Never read `process.env` directly** — always import `config` from `src/config/env.js`. `ALLOWED_ORIGINS` is pre-parsed into an array at startup.

### CORS
- Development: `origin: true` (reflects incoming Origin, works with credentials)
- Production: `origin: config.ALLOWED_ORIGINS` (whitelist array)
- `credentials: true` always set — never use `origin: '*'` with credentials

### Validation Middleware
`validate(schema)` from `src/middleware/validate.js`. After successful parse, `result.data` is written back to `req.body`, `req.query`, and `req.params` — downstream handlers always see coerced types and Zod defaults.

```js
router.post('/register', validate(registerSchema), authController.register)
```

Schema structure:
```js
z.object({ body: z.object({ ... }), query: z.object({ ... }).optional(), params: z.object({ ... }).optional() })
```

### Error Handling
- Throw `new AppError(message, statusCode)` for all known, intentional errors
- Pass unknown errors to `next(err)` — the global handler covers Zod, AppError, PostgreSQL constraint errors (`23505`, `23503`, `23514`), and JWT errors
- `res.headersSent` is checked at the top of the error handler — never causes a double-response crash
- **Never expose stack traces or raw error objects in responses**

### Zod v4 API (used throughout — not v3)
| Feature | Correct (v4) | Deprecated (v3) |
|---|---|---|
| Email | `z.email()` | `z.string().email()` |
| URL | `z.url()` | `z.string().url()` |
| UUID | `z.uuid()` | `z.string().uuid()` |
| Error list | `error.issues` | `error.errors` |
| Error message param | `{ error: '...' }` | `{ message: '...' }` |

### Health Check
`GET /api/v1/health` — returns `200` with both services `ok`, or `503` with `degraded` status. Each probe has a 3-second timeout via `Promise.race` (with `clearTimeout` in `.finally()` to prevent timer leak). Always keep this endpoint passing before merging any branch.

### Graceful Shutdown
`server.js` handles `SIGINT` and `SIGTERM` — stops accepting connections, drains in-flight requests, closes `pool` and `redis` connection. Force-exits after 10 seconds. Redis uses `redis.close()` (not `redis.quit()` — deprecated in node-redis v5).

### Database Queries
- Import `pool` from `src/db/client.js` for one-shot queries
- For transactions: `pool.connect()` → `BEGIN / COMMIT / ROLLBACK` manually, always `client.release()` in `finally`
- Stable, reused queries go in `src/db/utils/` — one file per concern
- One-off or evolving queries live inline in the service file with a comment

### Logging
Import `logger` from `src/logger/index.js`. Structured logging: `logger.info({ userId }, 'message')`. Never `console.log`.

### Auth Transport Conventions (Set in phase1/auth-transport — must be followed in all future phases)

**Dual-delivery on every auth response.** Login, register, and any future OAuth callback must always: set `accessToken` and `refreshToken` as HttpOnly cookies AND include both tokens in the JSON body. Browser clients use cookies; Android clients use the body. Never do only one.

**Cookie options are fixed.** Every `res.cookie()` call for auth tokens must use `httpOnly: true`, `secure: config.NODE_ENV === 'production'`, `sameSite: 'strict'`, and `maxAge` derived from `parseTtlSeconds()` × 1000. Options must be identical between set and clear calls.

**`parseTtlSeconds` is the single TTL source of truth.** Exported from `src/services/auth.service.js`. Import it wherever cookie `maxAge` or Redis TTL needs to be computed from a JWT expiry string.

**Silent refresh is cookie-only.** The `authenticate` middleware attempts silent refresh exclusively when the expired token came from `req.cookies.accessToken`. An expired Bearer header token always returns 401 immediately.

**`buildTokenResponse` is the canonical token-issuing function.** All future authentication paths must go through it.

---

## Current State of Every Source File

```
src/
  server.js                      ← stable — graceful shutdown handles SIGINT/SIGTERM
  app.js                         ← stable — middleware order fixed, CORS guard at startup
  config/env.js                  ← stable — add new vars to Zod schema here before use
  db/
    client.js                    ← stable — pg.Pool singleton; fatalCodes for ECONNREFUSED/ENOTFOUND
    utils/
      auth.js                    ← findUserById (correlated subquery ARRAY_AGG), findUserByEmail;
                                    findUserByGoogleId STUB (commented out — phase1/verification)
      institutions.js            ← findInstitutionByDomain(domain, client?)
  cache/client.js                ← stable — exponential backoff, MAX_RETRY_ATTEMPTS=10
  logger/index.js                ← stable
  middleware/
    authenticate.js              ← UPDATED in auth-transport: extractToken (cookie→header),
                                    attemptSilentRefresh (cookie-only), INACTIVE_STATUSES at module scope
    authorize.js                 ← stable — call-time role validation throws Error at route registration
    errorHandler.js              ← stable — AppError + ZodError + PG constraint codes + JWT errors
    rateLimiter.js               ← stable — authLimiter (10/15min), otpLimiter (5/15min)
    validate.js                  ← stable — writes result.data back to req
  services/
    auth.service.js              ← UPDATED in auth-transport: parseTtlSeconds exported;
                                    DUMMY_HASH hardcoded, register transaction with institution lookup,
                                    OTP attempt counter, refresh enforces account_status
    email.service.js             ← stable — maskEmail guard, OTP format guard, transport at module level
    student.service.js           ← stable — dynamic SET clause, ownership check
    pgOwner.service.js           ← stable — same pattern as student
    verification.service.js      ← stable — submitDocument, getVerificationQueue (keyset pagination),
                                    approveRequest, rejectRequest (both with AND status='pending')
  controllers/
    auth.controller.js           ← UPDATED in auth-transport: setAuthCookies/clearAuthCookies,
                                    ACCESS_COOKIE_OPTIONS/REFRESH_COOKIE_OPTIONS at module scope
    student.controller.js        ← stable
    pgOwner.controller.js        ← stable
    verification.controller.js   ← stable
  routes/
    index.js                     ← stable — mounts /health, /auth, /students, /pg-owners, /admin
    auth.js                      ← stable (google/callback route added in phase1/verification)
    student.js                   ← stable
    pgOwner.js                   ← stable
    admin.js                     ← stable — router-level authenticate + authorize('admin')
  validators/
    auth.validators.js           ← stable (googleCallbackSchema + refreshSchema update in next branch)
    student.validators.js        ← stable
    pgOwner.validators.js        ← stable
    verification.validators.js   ← stable
```

---

## Phase 1 — Foundation & Identity

**Build order levels covered:** 0, 1, 2

**Entry condition:** PostgreSQL running locally with schema from `roomies_db_setup.sql`. Redis running. `.env.local` present with all required variables. Zod env validation passes cleanly at startup.

**Goal:** A person can register as a student or PG owner, log in, receive an OTP, and the server correctly identifies them on every subsequent request. Institution auto-verification works. PG owner document upload creates a `verification_requests` row. An admin can see the verification queue.

---

### Level 0 — Foundation `phase1/foundation` ✅ COMPLETE

**What was built:**

```
src/
  server.js             — entry point: DB connect → Redis connect → listen → graceful shutdown
  app.js                — Express app, all global middleware in correct order
  config/env.js         — Zod v4 env validation at startup, ENV_FILE support, config export
  db/client.js          — pg.Pool singleton (max 20, idle 30s, connect timeout 5s)
  cache/client.js       — Redis singleton, exponential backoff, MAX_RETRY_ATTEMPTS=10
  logger/index.js       — Pino logger, pino-pretty in dev, raw JSON in prod
  middleware/
    errorHandler.js     — AppError class + global error handler
    validate.js         — Zod validation middleware factory
  routes/
    index.js            — rootRouter at /api/v1
    health.js           — GET /api/v1/health with 3s timeout probes
.env.example, .gitignore, package.json
```

**Verified:** health 200, missing env var exits with clear error, `GET /` returns 404 JSON.

---

### Level 1 — Auth + Identity `phase1/auth` ✅ COMPLETE

**What was built:**

```
src/
  db/utils/auth.js         — findUserById, findUserByEmail
  middleware/
    authenticate.js        — JWT Bearer verification + req.user attachment
    authorize.js           — role gate factory; call-time role validation
    rateLimiter.js         — authLimiter, otpLimiter
  validators/
    auth.validators.js     — registerSchema, loginSchema, refreshSchema, otpVerifySchema
    student.validators.js  — getStudentParamsSchema, updateStudentSchema
    pgOwner.validators.js  — getPgOwnerParamsSchema, updatePgOwnerSchema
  services/
    auth.service.js        — register, login, logout, refresh, sendOtp, verifyOtp
    email.service.js       — Nodemailer transport (Ethereal in dev)
    student.service.js     — getStudentProfile, updateStudentProfile
    pgOwner.service.js     — getPgOwnerProfile, updatePgOwnerProfile
  controllers/
    auth.controller.js     — register, login, logout, refresh, sendOtp, verifyOtp, me
    student.controller.js  — getProfile, updateProfile
    pgOwner.controller.js  — getProfile, updateProfile
  routes/
    auth.js               — 7 auth endpoints with rate limiters at router edge
    student.js            — GET + PUT /:userId/profile
    pgOwner.js            — GET + PUT /:userId/profile
    index.js              — mounts /auth, /students, /pg-owners
```

**Post-merge hardening (all in merged code):**
- `findUserById` — correlated subquery for ARRAY_AGG (ORDER BY + DISTINCT cannot coexist in same clause)
- `authorize` — call-time validation throws `Error` at route registration, not per-request 403
- Concurrent registration race — inner try/catch on `err.code === '23505'` as second line of defence
- Login timing side-channel — `DUMMY_HASH` (pre-computed bcrypt of `"dummy"`) runs always
- Refresh — enforces `account_status` check after Redis validation
- OTP exhaustion — returns 429 on the final (5th) wrong attempt, not just after
- OTP format guard — `/^[0-9]{6}$/` in email service, independent of upstream validation
- `maskEmail` — guards against empty local part (`"@domain.com"` edge case)
- `INACTIVE_STATUSES` — hoisted to module scope, allocated once
- `crypto.randomInt` — upper bound `1000000` (exclusive), giving full `100000–999999` range
- `otpVerifySchema` — digit-only regex, not just length check

**Security decisions (carry forward permanently):**

`DUMMY_HASH` in `auth.service.js` is `$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi` — bcrypt of `"dummy"` at 10 rounds. **Never remove it. Never replace it with a runtime `bcrypt.hash()` call.** It exists solely to equalise timing; a runtime hash call would reintroduce timing variance.

OTP verify route (`POST /api/v1/auth/otp/verify`) deliberately has **no `otpLimiter`**. The route requires a valid JWT, and the service-layer attempt counter at `otpAttempts:{userId}` is the throttle. An IP rate limiter here would create a confusing dual-throttle.

GET profile routes for both students and PG owners are **intentionally world-readable** by any authenticated user. This is the core product read model, not an IDOR. PUT ownership is enforced in the service layer.

---

### Level 2 — Institution + Verification `phase1/institutions` ✅ COMPLETE

**Two independent sub-systems in one branch.**

**Sub-system 1 — Institution Auto-Verification**

`src/db/utils/institutions.js` exports `findInstitutionByDomain(domain, client?)`. Accepts a clean domain string (domain extraction is the service layer's responsibility). Queries with `deleted_at IS NULL` — matches the partial unique index predicate, forces index scan. The `client?` parameter defaults to pool, consistent with `findUserById` and `findUserByEmail`.

`src/services/auth.service.js` — registration transaction extended, not restructured. After `student_profiles` INSERT: calls `findInstitutionByDomain(email.split('@')[1], client)`. On match: `UPDATE student_profiles SET institution_id` and `UPDATE users SET is_email_verified = TRUE`, both in the same transaction. `effectivelyVerified` tracks the post-UPDATE state — the RETURNING value from the INSERT is always FALSE and cannot be trusted here.

**Sub-system 2 — PG Owner Verification Pipeline**

`src/services/verification.service.js` — four functions:
- `submitDocument` — ownership check + profile existence check + single INSERT into `verification_requests`
- `getVerificationQueue` — keyset pagination with compound cursor `(submitted_at, request_id)`. Oldest-first to prevent starvation. Fetches `limit + 1` rows to detect next page without a COUNT.
- `approveRequest` — transaction: UPDATE `verification_requests` with `AND status = 'pending'` concurrency guard + UPDATE `pg_owner_profiles`. `rowCount === 0` on either → 409.
- `rejectRequest` — same transaction pattern, writes `rejection_reason` to profile.

Admin router at `src/routes/admin.js` — `authenticate + authorize('admin')` applied at router level, not per-route. Architecturally impossible to add an unprotected route here.

**Files built:**

| File | Type |
|------|------|
| `src/db/utils/institutions.js` | New |
| `src/services/verification.service.js` | New |
| `src/controllers/verification.controller.js` | New |
| `src/validators/verification.validators.js` | New |
| `src/routes/admin.js` | New |
| `src/services/auth.service.js` | Modified (registration transaction extended) |
| `src/routes/pgOwner.js` | Modified (document submission route added) |
| `src/routes/index.js` | Modified (admin router mounted) |

---

### Level 2.5 — Dual-Client Auth Transport `phase1/auth-transport` ✅ COMPLETE

**The problem solved:** Tokens were returned only in the JSON body and read only from `Authorization: Bearer`. Correct for Android, incomplete for browsers where HttpOnly cookies are required to eliminate XSS token theft.

**Three files changed. Nothing else.**

**`src/services/auth.service.js`** — `parseTtlSeconds` promoted to named export. Single source of truth for TTL arithmetic. The controller imports it to calculate cookie `maxAge` so cookie lifetime and JWT lifetime are always in sync.

**`src/controllers/auth.controller.js`** — `setAuthCookies(res, accessToken, refreshToken)` called in `register` and `login` before `res.json()`. `clearAuthCookies(res)` called in `logout`. JSON body kept fully intact. `ACCESS_COOKIE_OPTIONS` and `REFRESH_COOKIE_OPTIONS` defined as module-level constants (computed once at startup from `parseTtlSeconds`, guaranteed consistent between set and clear).

Cookie options: `httpOnly: true`, `secure: config.NODE_ENV === 'production'`, `sameSite: 'strict'`, `maxAge: parseTtlSeconds(...) * 1000`.

**`src/middleware/authenticate.js`** — restructured around two private functions:

`extractToken(req)` — priority chain: `req.cookies.accessToken` first (returns `{ token, source: 'cookie' }`), falls through to `Authorization: Bearer` (returns `{ token, source: 'header' }`), returns `null` if neither present.

`attemptSilentRefresh(req, res)` — called only when `jwt.verify` throws `TokenExpiredError` AND `source === 'cookie'`. Validates refresh cookie against JWT secret then Redis. Loads fresh roles and email from DB (never trusts the 7-day-old refresh payload). Signs a new access token. Sets replacement `accessToken` cookie on `res`. Returns `userId` on success, `null` on any failure. The main middleware continues with the returned `userId`.

An expired token arriving via `Authorization: Bearer` goes directly to `next(err)` — silent refresh is never attempted. This is critical: silently rotating an Android Bearer token would stale Android's stored token with no recovery path except re-login.

**How each client experiences the system:**
- Browser: logs in, receives cookies automatically, expiry is invisible, sessions self-renew for 7 days of inactivity
- Android: reads tokens from body, sends `Authorization: Bearer`, receives 401 on expiry, calls `POST /auth/refresh` explicitly, retries

---

### Level 2.6 — Google OAuth + Verification Hardening `phase1/verification` ← NEXT

**Unblocked by:** `phase1/auth-transport` ✅ merged

**Two deliverables in one branch.**

**Deliverable 1 — Google OAuth**

Complete `findUserByGoogleId` stub in `src/db/utils/auth.js`. Add `POST /api/v1/auth/google/callback` to `src/routes/auth.js`. Controller receives Google ID token from body, verifies with `google-auth-library`'s `OAuth2Client.verifyIdToken()`, extracts verified email and `google_id`.

Service branches: existing `google_id` → login path; new → registration path. Registration runs the same institution domain lookup transaction as email/password register. `password_hash` is `NULL`; `is_email_verified` starts `TRUE`. Both paths end at `buildTokenResponse` + `setAuthCookies` + JSON body (dual-delivery).

`refreshSchema` — make `refreshToken` optional in body. Browser clients calling `POST /auth/refresh` send no body. The refresh service reads from `req.body.refreshToken ?? req.cookies?.refreshToken`.

**Deliverable 2 — Verification hardening**

At minimum: `submitDocument` must verify the authenticated user holds the `pg_owner` role (currently only checks profile existence — a student who somehow had a profile row would pass). Confirm `getVerificationQueue` returns `user_id` in each item so the admin UI can deep-link to the owner profile.

**Files that will change:**

| File | Change |
|------|--------|
| `src/db/utils/auth.js` | Complete `findUserByGoogleId` |
| `src/services/auth.service.js` | Add `googleOAuth` service function |
| `src/controllers/auth.controller.js` | Add `googleCallback` controller |
| `src/routes/auth.js` | Add `POST /google/callback` route |
| `src/validators/auth.validators.js` | Add `googleCallbackSchema`; update `refreshSchema` for optional body token |
| `src/services/verification.service.js` | Hardening items |
| `src/validators/verification.validators.js` | Hardening items if needed |

---

## Phase 2 — Listings & Search

**Build order levels covered:** 3, 4

**Entry condition:** Phase 1 fully stable and all sub-branches merged. A verified PG owner exists in the database. A verified student exists.

**Goal:** A PG owner can create a property and attach listings to it. A student can search by city, rent range, room type, and proximity. Photos upload and get compressed. Compatibility scores appear on search results. A student can save listings.

**Branch structure:**
```
Phase2
 ├── phase2/amenities    ← seed data + property CRUD
 ├── phase2/listings     ← listing CRUD + search + compatibility
 ├── phase2/media        ← photo upload + Sharp compression via BullMQ
 └── phase2/saved        ← saved listings
```

**DB note:** The schema does not enforce `verification_status = 'verified'` before a property INSERT — that gate lives purely in application code. `phase2/amenities` adds the service-layer check.

**What gets built:**

`phase2/amenities` — `src/db/seeds/amenities.js` script (idempotent, `ON CONFLICT DO NOTHING`). Property CRUD with `authorize('pg_owner')` + verification status check in service. Amenity junction table managed in same transaction as property INSERT. Soft-delete blocked if active listings exist.

`phase2/listings` — Listing CRUD with student vs PG owner branching logic on `property_id`. `expires_at = NOW() + INTERVAL '60 days'` set at creation, never from request body. Search endpoint: dynamic parameterised WHERE clause (city, rent, room type, gender, available_from, listing type, amenity filter) + PostGIS proximity via `findListingsNearPoint` in `src/db/utils/spatial.js` using `ST_DWithin` with geography cast (meters, handles Earth's curvature). Compatibility scoring via `scoreListingsForUser` in `src/db/utils/compatibility.js` — JOIN on `(preference_key, preference_value)`. Score is never stored, always computed fresh. Rent stored in paise in DB, divided by 100 before returning.

`phase2/media` — `StorageService` interface with `LocalDiskAdapter` (dev) and `AzureBlobAdapter` (stub, throws 501). `STORAGE_ADAPTER` env var controls which. Photo upload returns `202 Accepted` immediately; BullMQ `media-processing-queue` worker runs Sharp: resize to 1200px max, WebP, quality 80. First photo auto-set as cover if none exists. Worker started in `server.js`, shut down gracefully on SIGTERM.

`phase2/saved` — `POST/DELETE /listings/:listingId/save`, `GET /users/me/saved-listings`. Save is idempotent (`ON CONFLICT DO NOTHING`). Feed silently omits deleted/expired listings.

```
Phase2
 ├── phase2/amenities    ← seed data + property CRUD
 ├── phase2/listings     ← listing CRUD + search + compatibility
 ├── phase2/media        ← photo upload + Sharp compression via BullMQ
 ├── phase2/saved        ← saved listings
 └── phase2/interests    ← BLOCKED: interest request CRUD depends on Phase 3 connection creation
 ```

---

## Phase 3 — Interaction Pipeline & Contact

**Build order levels covered:** 5, 6

**Entry condition:** Phase 2 stable. At least one active listing by a verified PG owner. At least one verified student with preferences set.

**Goal:** A student can express interest. A PG owner can accept or decline. On acceptance, a connection is created and the student receives the poster's WhatsApp deep-link. Both parties can confirm the interaction. Notification feed works.

**What gets built:**

Interest request INSERT + notification INSERT in one `BEGIN/COMMIT`. Acceptance: `interest_requests` status update + `connections` row creation in one transaction — if either fails, both roll back. Post-commit: notification dispatched via `notification-queue`, WhatsApp `wa.me/91XXXXXXXXXX` deep-link returned.

Two-sided confirmation: each party flips their own flag. After each flip, service checks both `TRUE` → sets `confirmation_status = confirmed` in same transaction. Notifications layer: unread count, paginated feed, mark-as-read. `notification-queue` BullMQ worker wired here.

Let me re-read the relevant sections of both remaining files carefully before planning anything.Good. Now I have the full picture from both planning docs and the codebase. Let me reason through this carefully before writing anything.

---

# Roomies — Phase 3 Implementation Plan
## Interaction Pipeline & Contact

**Author perspective:** Senior backend engineer planning from the database up.
**Entry condition:** Phase 2 fully merged and stable. At least one active listing by a verified PG owner. At least one verified student with preferences set.
**No code in this document — only architecture, reasoning, and decisions.**

---

## The Mental Model Before Writing Anything

Phase 1 answered "who are you?" Phase 2 answered "what is being offered?" Phase 3 answers "how do two strangers reach a confirmed real-world meeting?"

The pipeline has three sequential stages and they are not interchangeable — each one is a prerequisite for the next:

```
interest_requests  →  connections  →  notifications
     (intent)           (proof)        (awareness)
```

A student signals intent by sending an interest request. A poster signals willingness by accepting it — and at the moment of acceptance, a `connections` row is born. That row is the trust anchor for everything in Phase 4 (ratings require it). Notifications exist purely to make both parties aware that something happened — they are side effects of state transitions, never the transition itself.

This ordering has one important consequence for branch planning: you cannot build `connections` without `interest_requests` being done, and you cannot build the full notification system without both. The branch dependency is strict.

---

## Branch Structure

```
Phase3
 ├── phase3/interests        ← completes deferred phase2/interests + accept→connections atomic transaction
 ├── phase3/connections      ← two-sided confirmation, WhatsApp deep-link
 └── phase3/notifications    ← HTTP feed, unread count, mark-read, notification-queue worker
```

**Rule:** Each branch must be merged and manually verified before the next begins. No parallel work.

---

## Branch 1 — `phase3/interests`

### What This Branch Actually Is

This is not new territory — the full architecture was planned in the Phase 2 deferred section. What this branch does is complete that work and add the one piece that was blocking it: the `accepted` transition must atomically create a `connections` row in the same `BEGIN/COMMIT`. Now that Phase 3 owns `connections`, that blocker is gone.

Everything from the deferred plan carries forward unchanged. The state machine, the actor resolution logic, the endpoint surface, the pagination pattern — all of it was already reasoned through. This section focuses only on what is new or non-obvious.

### The `accepted` Transition — The Critical Atomic Block

This is the most important transaction in the entire Phase 3 codebase. When a poster calls `PATCH /interests/:interestId/status` with `{ status: "accepted" }`, the service must do three things inside a single `BEGIN/COMMIT`:

1. `UPDATE interest_requests SET status = 'accepted' WHERE interest_id = $1 AND status = 'pending'`
2. `INSERT INTO connections (initiator_id, counterpart_id, listing_id, interest_request_id, connection_type)` — derived from the interest request row
3. Neither succeeds unless both succeed.

If the connection INSERT fails after the status UPDATE commits, you have an accepted interest request with no connection — a broken state that Phase 4 ratings cannot reference and that the UI has no way to represent. The atomicity is non-negotiable.

The `connection_type` is derived from `listing.listing_type`:
- `student_room` → `student_roommate`
- `pg_room` → `pg_stay`
- `hostel_bed` → `hostel_stay`

This derivation happens inside the transaction — the listing row is already fetched for actor resolution, so the `listing_type` is available at zero extra query cost.

### The `connections` Row at Birth

When created, a `connections` row has:
- `initiator_id` = `interest_request.sender_id` (the student who expressed interest)
- `counterpart_id` = `listing.posted_by` (the poster who accepted)
- `listing_id` = from the interest request
- `interest_request_id` = the interest request that triggered it
- `connection_type` = derived from listing type
- `initiator_confirmed = FALSE`, `counterpart_confirmed = FALSE`
- `confirmation_status = 'pending'`
- `status = 'active'`

The confirmation flags start `FALSE` intentionally — the acceptance of an interest request does not mean either party has confirmed the real-world interaction happened. That is a separate, later action.

### WhatsApp Deep-Link — Returned at Accept Time

When the `accepted` transition succeeds, the response includes the poster's WhatsApp deep-link. The format is `https://wa.me/91${posterPhoneNumber}` where the phone number comes from `pg_owner_profiles.whatsapp_number` (for PG owners) or `student_profiles.phone_number` (for students posting their own room).

This is returned in the response body of the `PATCH /interests/:interestId/status` call — not via a notification, not via a separate endpoint. The student's app receives `{ status: "accepted", connectionId: "...", whatsappLink: "https://wa.me/91..." }` and can render the deep-link immediately. This is the correct place: the student just got accepted and wants the contact info right now, in the same response.

One important guard: if the poster has no phone number on their profile, `whatsappLink` is `null` in the response — not an error. Missing phone number is a data quality problem, not a transaction failure. The connection is still created. The student can always find contact info by viewing the poster's profile.

### Notification Hook Points in This Branch

Every transition fires a notification. In this branch, the notification is inserted via a direct `pool.query` call **after the transaction commits** — never inside it. This is the pattern established in the project conventions. The notification INSERT is fire-and-forget: if it fails (which is rare), the state machine transition is not rolled back. A missed notification is a UX problem; a rolled-back state machine transition is a data integrity problem. These have different severity levels.

The notification types fired in this branch:
- `new_interest_request` → to poster, when a student creates a request
- `interest_request_accepted` → to student, when poster accepts
- `interest_request_declined` → to student, when poster declines
- `interest_request_withdrawn` → to poster, when student withdraws

The notification row shape: `(recipient_id, type, entity_type='interest_request', entity_id=interest_id, is_read=FALSE)`.

The `notification-queue` BullMQ worker does not yet exist in this branch — the direct `pool.query` is the delivery mechanism here. The worker is `phase3/notifications`'s job. This means in this branch, notification INSERT failures are silent. That is acceptable — the worker in the next branch makes delivery reliable and decoupled.

### `expirePendingRequestsForListing` — Where It Gets Called

This function already exists in `interest.service.js` (implemented in the Phase 2 bug fix). In this branch, it gets wired into the listing service. Specifically: when a listing's `status` is updated to anything other than `active` (filled, deactivated, deleted), the listing service calls `expirePendingRequestsForListing(listingId, client)` **inside the same transaction** as the listing status update. This ensures that if the listing status update rolls back, the interest request expiry also rolls back. Atomicity here matters — you do not want expired interest requests pointing at a listing that is still technically active.

### Files Changed or Created

| File | Change |
|------|--------|
| `src/validators/interest.validators.js` | New |
| `src/services/interest.service.js` | Already exists (Phase 2 bug fix) — add `accepted` transition with connection INSERT |
| `src/controllers/interest.controller.js` | New |
| `src/routes/interest.js` | New — mounts at `/api/v1/interests` |
| `src/routes/listing.js` | Add `POST /:listingId/interests` and `GET /:listingId/interests` |
| `src/routes/index.js` | Mount interest router |
| `src/services/listing.service.js` | Wire `expirePendingRequestsForListing` into status-update path |

No new `db/utils/` file needed — all queries are listing-specific and live inline in the service.

---

## Branch 2 — `phase3/connections`

### What a Connection Actually Represents

A `connections` row is proof that two people agreed to interact. It is not proof that the interaction happened. That distinction is the entire point of the two-sided confirmation system — the connection is created at acceptance (agreement to interact), and `confirmation_status` only reaches `confirmed` after both parties independently say "yes, this actually happened."

This matters because ratings (Phase 4) are anchored to confirmed connections. If you allowed ratings on any accepted connection, a poster could accept a hundred interest requests, generate a hundred connection rows, and solicit a hundred ratings from collaborators — without a single real interaction. The two-sided confirmation makes this impractical: both parties must confirm, and a student confirming a stay that never happened is visible in the audit trail.

### The Two-Sided Confirmation — The Atomicity Requirement

Each party flips their own flag independently. The endpoints are:
- `POST /connections/:connectionId/confirm` — called by either party (service detects which flag to flip based on `req.user.userId`)

The service logic for each confirmation flip:

1. Fetch the connection row: `SELECT initiator_id, counterpart_id, initiator_confirmed, counterpart_confirmed, confirmation_status WHERE connection_id = $1 AND deleted_at IS NULL`
2. Determine which flag belongs to the caller. If neither `initiator_id` nor `counterpart_id` matches, throw 404 (don't leak that the connection exists).
3. Open a transaction.
4. `UPDATE connections SET initiator_confirmed = TRUE WHERE connection_id = $1` (or `counterpart_confirmed`, depending on caller).
5. **In the same transaction**, check if both flags are now true: `SELECT initiator_confirmed AND counterpart_confirmed AS both_confirmed FROM connections WHERE connection_id = $1`.
6. If `both_confirmed`, also `UPDATE connections SET confirmation_status = 'confirmed'` in the same statement — or combine steps 4–6 into one atomic UPDATE:

```sql
UPDATE connections
SET
  initiator_confirmed  = CASE WHEN initiator_id  = $2 THEN TRUE ELSE initiator_confirmed  END,
  counterpart_confirmed = CASE WHEN counterpart_id = $2 THEN TRUE ELSE counterpart_confirmed END,
  confirmation_status  = CASE
    WHEN (initiator_confirmed  OR initiator_id  = $2)
     AND (counterpart_confirmed OR counterpart_id = $2)
    THEN 'confirmed'
    ELSE confirmation_status
  END,
  updated_at = NOW()
WHERE connection_id = $1
  AND (initiator_id = $2 OR counterpart_id = $2)
  AND deleted_at IS NULL
RETURNING *
```

This single UPDATE atomically flips the correct flag and sets `confirmation_status = 'confirmed'` if and only if both flags are now true — with no gap between check and write. `rowCount === 0` means "not your connection or doesn't exist" → 404.

After the transaction commits, if `confirmation_status` just became `confirmed`, fire a `connection_confirmed` notification to both parties (two notification INSERTs, both fire-and-forget post-commit).

### What Confirmation Unlocks

Once `confirmation_status = 'confirmed'`:
- Both parties are eligible to submit ratings referencing this `connection_id` (Phase 4 enforces this)
- The connection appears in each party's public interaction history
- The listing can be marked as `filled` if the poster chooses (not automatic — the poster decides)

### The Connection Read Endpoints

Two read endpoints:

`GET /connections/me` — returns all connections the authenticated user is party to (either `initiator_id` or `counterpart_id`). Supports filtering by `confirmation_status`. Keyset pagination on `(created_at, connection_id)`. Each row includes the other party's public profile (name, photo, rating) and the listing summary. This is the "my connections" dashboard for both students and posters.

`GET /connections/:connectionId` — single connection detail. Only accessible by the two parties — `WHERE (initiator_id = $2 OR counterpart_id = $2)` enforced in the WHERE clause. Returns full detail including both confirmation flags, so each party can see whether the other has confirmed yet.

### Files Changed or Created

| File | Change |
|------|--------|
| `src/validators/connection.validators.js` | New |
| `src/services/connection.service.js` | New |
| `src/controllers/connection.controller.js` | New |
| `src/routes/connection.js` | New — mounts at `/api/v1/connections` |
| `src/routes/index.js` | Mount connection router |

---

## Branch 3 — `phase3/notifications`

### The Two-Layer Notification Architecture

Notifications have two concerns that must be kept separate:

**Layer 1 — Storage:** Writing a `notifications` row to the database. This is what makes the notification durable and queryable. It already happens (fire-and-forget `pool.query`) in branches 1 and 2.

**Layer 2 — Delivery:** Ensuring the write actually happens reliably, even if the database was momentarily slow or the Node process restarted between the state transition and the notification INSERT. This is what the `notification-queue` BullMQ worker provides.

In branches 1 and 2, the notification INSERT is fire-and-forget inline. In this branch, it gets promoted: instead of calling `pool.query` directly, the service calls `notificationQueue.add('send-notification', payload)`. The BullMQ worker picks it up and does the INSERT with retry logic. If the worker fails after 3 attempts, the notification lands in the BullMQ dead-letter queue for inspection — the state transition that triggered it is completely unaffected.

This promotion is a **refactor of the existing notification calls** in branches 1 and 2. The state machine code does not change — only the line that was `await pool.query(INSERT INTO notifications...)` becomes `await notificationQueue.add(...)`. This is the entire scope of the notification queue wiring.

### The HTTP Notification Endpoints

Three endpoints, all on a new `src/routes/notification.js` router mounted at `/api/v1/notifications`:

**`GET /notifications`** — the paginated notification feed for the authenticated user. Keyset pagination on `(created_at DESC, notification_id)`. Each row includes `type`, `entity_type`, `entity_id`, `is_read`, `created_at`, and a human-readable `message` string generated from the type and entity. The `message` is assembled in the service from a type→template map — never stored in the DB, always computed at read time so wording can be changed without a migration.

The query hits the partial index `(recipient_id, created_at DESC) WHERE is_read = FALSE` for the unread-first sort, then falls back to the full index for read notifications. The `LIMIT + 1` cursor pattern applies here too.

**`GET /notifications/unread-count`** — returns `{ count: N }`. This is the bell badge number. The query is `SELECT COUNT(*) FROM notifications WHERE recipient_id = $1 AND is_read = FALSE AND deleted_at IS NULL`. This query must be fast — it runs on every page load. The partial index `WHERE is_read = FALSE` keeps the index small (read notifications fall out of it automatically), so this is an index scan on a small set regardless of total notification history size.

**`POST /notifications/mark-read`** — accepts `{ notificationIds: [uuid, uuid, ...] }` or `{ all: true }`. The bulk mark-read case uses `UPDATE notifications SET is_read = TRUE WHERE recipient_id = $1 AND notification_id = ANY($2::uuid[]) AND is_read = FALSE`. The `all: true` case uses `UPDATE notifications SET is_read = TRUE WHERE recipient_id = $1 AND is_read = FALSE`. Both are safe bulk updates — no looping, no N+1. The `AND is_read = FALSE` guard means re-marking already-read notifications is a no-op (correct idempotent behaviour).

### The `notification-queue` Worker

Lives in `src/workers/notificationWorker.js`. Exported as `startNotificationWorker()` — same factory function pattern as `startMediaWorker()`. Started in `server.js` after Redis connects, shut down before Redis disconnects.

The worker concurrency is `10` (from the project plan). Unlike Sharp processing, notification delivery is pure I/O (a single `INSERT` into PostgreSQL) — it is fast and non-CPU-bound, so running 10 concurrent jobs is safe and desirable.

Job payload shape: `{ recipientId, type, entityType, entityId }`. The worker does one thing: `INSERT INTO notifications (recipient_id, type, entity_type, entity_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`. The `ON CONFLICT DO NOTHING` handles the case where a job is retried after a partial failure — the notification may have already been inserted on the first attempt. There is no unique constraint to define "duplicate" precisely here, so this is more of a belt-and-suspenders guard than a strict deduplication. True deduplication would require a composite unique index on `(recipient_id, type, entity_id)` — reasonable to add if duplicate notifications become a real problem.

Retry policy: `{ attempts: 5, backoff: { type: 'exponential', delay: 1000 } }`. Five attempts because notification delivery is important but not life-critical. After five failures, the notification lands in the failed set — a Phase 5 admin tool can replay or inspect it.

### Refactoring the Inline Notification Calls

In branches 1 and 2, notifications are inserted inline as fire-and-forget `pool.query` calls. This branch refactors those call sites to enqueue instead. The change at each call site is minimal:

**Before (branch 1/2 pattern):**
```js
// fire-and-forget post-commit
pool.query(`INSERT INTO notifications ...`, [recipientId, type, entityType, entityId]);
```

**After (this branch):**
```js
// enqueue post-commit — worker handles INSERT with retry
notificationQueue.add('send-notification', { recipientId, type, entityType, entityId });
```

The `notificationQueue` is the singleton from `getQueue(NOTIFICATION_QUEUE_NAME)` in `src/workers/notificationWorker.js`. The queue name constant is exported from there and imported at the call sites — same pattern as `MEDIA_QUEUE_NAME`.

### Files Changed or Created

| File | Change |
|------|--------|
| `src/workers/notificationWorker.js` | New — worker factory + queue name constant |
| `src/validators/notification.validators.js` | New |
| `src/services/notification.service.js` | New |
| `src/controllers/notification.controller.js` | New |
| `src/routes/notification.js` | New — mounts at `/api/v1/notifications` |
| `src/routes/index.js` | Mount notification router |
| `src/services/interest.service.js` | Refactor inline notification calls → enqueue |
| `src/services/connection.service.js` | Refactor inline notification calls → enqueue |
| `server.js` | Start + gracefully shut down notification worker |

---

## Cross-Cutting Concerns for the Entire Phase

### The Actor Resolution Pattern

Phase 3 introduces a new authorization pattern that doesn't exist in earlier phases: **both parties in a two-party resource have equal but different permissions**. In interest requests, the sender and poster have different allowed transitions. In connections, the initiator and counterpart have different confirmation flags. The pattern for resolving this is always the same:

1. Fetch the resource row including both party IDs.
2. Compare `req.user.userId` against each party ID.
3. Derive the caller's role from that comparison.
4. Use the role to gate the allowed operations.
5. If the caller matches neither party ID, return 404 — never 403. Confirming that a resource exists but the caller can't access it is an information leak.

This pattern is already established in `interest.service.js` via `resolveActorRole`. The connection service uses the same pattern.

### Notification Decoupling Is Non-Negotiable

The rule established in the project conventions bears repeating because it is violated easily under time pressure: **notifications are side effects that run after the transaction commits, never inside it**.

The reason: if a notification INSERT is inside a transaction and the notification INSERT fails (table locked, constraint violation, etc.), it rolls back the state machine transition that triggered it. A student's interest request being accepted gets rolled back because a notification INSERT failed. This is catastrophically wrong — a 500ms transient DB hiccup causes real data loss visible to users.

Post-commit fire-and-forget (or post-commit enqueue) means: the state change is committed and permanent, then the notification is attempted. If the notification fails, the state change still happened. The user may not get notified, but their interaction was correctly recorded. This is always the correct trade-off for notification delivery.

### The `connections` Table as Phase 4's Foundation

Every design decision in this phase should be made with Phase 4 in mind. Ratings require `connection_id` to be non-null, and the rating submission will check `confirmation_status = 'confirmed'` before accepting. This means:

- The `connection_id` must be returned in the `PATCH /interests/:interestId/status` response so the client has it immediately after acceptance.
- The `GET /connections/:connectionId` endpoint must return `confirmation_status` so the client knows when ratings become available.
- The `confirmed` status must never be set prematurely — the atomic single-UPDATE pattern in branch 2 ensures this.

### The `phase2/interests` Deferred Work

The deferred section in `ImplementationPlan.md` is the spec for `phase3/interests`. The implementation notes there carry forward without change. The one addition is wiring `expirePendingRequestsForListing` into the listing service's status-update path, which was not part of the original deferred spec.

---

## Branch Completion Criteria

### `phase3/interests`
A student can POST an interest request to an active listing they don't own. The poster can PATCH it to `accepted` and receives back a `connectionId` and `whatsappLink`. A `connections` row exists in the DB after acceptance with `confirmation_status = 'pending'`. The poster can PATCH to `declined` — no `connections` row is created. The student can PATCH to `withdrawn` while `pending` or `accepted`. Attempting a transition that violates the state machine returns 422. Concurrent duplicate interest requests from the same student to the same listing: one succeeds, the other returns 409. Deactivating a listing expires all its pending interest requests in the same transaction. Notification rows are inserted post-commit for each transition. Health check still 200.

### `phase3/connections`
Either party can POST to `/connections/:connectionId/confirm`. After one confirmation, `confirmation_status` is still `pending`. After the second, `confirmation_status = 'confirmed'` in a single atomic UPDATE. Neither party can confirm for the other. A third party gets 404. `GET /connections/me` returns the connection with the other party's profile and the listing summary. `connection_confirmed` notifications fire post-commit to both parties when confirmed. Health check still 200.

### `phase3/notifications`
`GET /notifications` returns the paginated feed correctly ordered, with human-readable messages assembled from type templates. `GET /notifications/unread-count` returns the correct count. `POST /notifications/mark-read` with specific IDs marks only those. `POST /notifications/mark-read` with `all: true` clears all. The `notification-queue` worker processes enqueued jobs and INSERTs notification rows. The inline `pool.query` notification calls in interest and connection services have been replaced with queue enqueues. Server shuts down cleanly on SIGTERM with worker draining. Health check still 200.

---

## What Phase 3 Unlocks

By the end of Phase 3, the core social loop is complete for the first time: a student finds a listing, expresses interest, gets accepted, contacts the poster over WhatsApp, both confirm the interaction happened, and notifications keep both parties informed throughout. The `connections` table now has rows with `confirmation_status = 'confirmed'` — Phase 4's entire ratings and reputation system becomes buildable.

---

## Updated Branch Tracking (for `ImplementationPlan.md`)

```
Phase3
 ├── phase3/interests      ← completes deferred phase2/interests
 │                            + accepted transition atomically creates connections row
 │                            + expirePendingRequestsForListing wired into listing service
 ├── phase3/connections    ← two-sided confirmation (atomic single-UPDATE pattern)
 │                            + WhatsApp deep-link returned at accept time
 │                            + GET /connections/me + GET /connections/:id
 └── phase3/notifications  ← notification HTTP endpoints (feed, unread-count, mark-read)
                              + notification-queue BullMQ worker
                              + refactor inline pool.query calls → enqueue in interests + connections
```
---

## Phase 4 — Reputation System

**Build order levels covered:** 7

**Entry condition:** Phase 3 stable. At least one `connections` row with `confirmation_status = confirmed`.

**Goal:** A participant in a confirmed connection can rate the other party or the property. Cached averages update automatically. Ratings can be reported. Admins can moderate.

**What gets built:**

Eligibility check: submitting user must be `initiator_id` or `counterpart_id` and connection `confirmation_status = confirmed`. Polymorphic reviewee check in service (DB FK cannot enforce two tables). INSERT triggers `update_rating_aggregates` automatically — no application code needed for cache update. Report submission, partial unique index prevents duplicate open reports. Admin endpoints: `resolved_removed` (sets `is_visible = FALSE`, trigger recalculates average) or `resolved_kept`.

---

## Phase 5 — Operations & Admin

**Build order levels covered:** 8, 9

**Entry condition:** Phase 4 stable.

**Goal:** Platform maintains itself. Full admin control panel.

**What gets built:**

`node-cron` tasks: listing expiry (daily 02:00), connection expiry (daily 03:00), expiry warning (daily 01:00), hard-delete cleanup (weekly Sunday 04:00). `email-queue` BullMQ worker wired here.

Admin-only router `/api/v1/admin`: verification queue management, user account management (suspend, ban, reactivate), rating moderation, platform analytics.

---

## Phase 6 — Real-Time (Future Phase)

**Build order levels covered:** 10

**Entry condition:** Phase 3 polling confirmed working. Real users exist. Explicitly deferred.

**Goal:** Replace polling with push delivery over WebSocket.

**What gets built:**

`ws` WebSocket server on same HTTP server instance. JWT from `?token=` query param on handshake. Connections tracked in `Map` keyed by `user_id`. Redis pub/sub for cross-instance broadcast on Azure App Service.

---

## Phase Summary

| Phase | Levels | Status | What Becomes Possible | Hard Dependency |
|-------|--------|--------|----------------------|-----------------|
| 1 — Foundation & Identity | 0, 1, 2 | 0 + 1 + 2 + 2.5 ✅, 2.6 next | Register, log in, verify, upload documents | Schema applied, `.env.local` valid |
| 2 — Listings & Search | 3, 4 | Not started | Post listings, search by filters + proximity, photos, compatibility scores | Phase 1 fully stable |
| 3 — Interaction Pipeline | 5, 6 | Not started | Send interest, accept/decline, WhatsApp contact, confirm interactions, notification feed | Phase 2 stable |
| 4 — Reputation System | 7 | Not started | Rate users and properties, report ratings, admin moderation, cached averages | Phase 3 stable |
| 5 — Operations & Admin | 8, 9 | Not started | Auto-expiry, cleanup cron, full admin control panel, analytics | Phase 4 stable |
| 6 — Real-Time (Future) | 10 | Deferred | Push notifications via WebSocket | Phase 3 polling confirmed, real users exist |

---

*— Last updated: phase1/auth-transport merged; phase1/verification is next (unblocked) —*

<!-- ImplementationPlan.md -->