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

---

## Phase 3 — Interaction Pipeline & Contact

**Build order levels covered:** 5, 6

**Entry condition:** Phase 2 stable. At least one active listing by a verified PG owner. At least one verified student with preferences set.

**Goal:** A student can express interest. A PG owner can accept or decline. On acceptance, a connection is created and the student receives the poster's WhatsApp deep-link. Both parties can confirm the interaction. Notification feed works.

**What gets built:**

Interest request INSERT + notification INSERT in one `BEGIN/COMMIT`. Acceptance: `interest_requests` status update + `connections` row creation in one transaction — if either fails, both roll back. Post-commit: notification dispatched via `notification-queue`, WhatsApp `wa.me/91XXXXXXXXXX` deep-link returned.

Two-sided confirmation: each party flips their own flag. After each flip, service checks both `TRUE` → sets `confirmation_status = confirmed` in same transaction. Notifications layer: unread count, paginated feed, mark-as-read. `notification-queue` BullMQ worker wired here.

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