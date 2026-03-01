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
      ├── phase1/auth-transport   ← NEXT (depends on institutions merged)
      └── phase1/verification     ⏸ HALTED — resumes after auth-transport
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

### Level 2 — Institution + Verification `phase1/institutions` ✅ COMPLETE

**Branch:** `phase1/institutions` → merged into `Phase1`

**Two independent sub-systems in one branch.** The first is a read-modify-write pipeline embedded inside the existing registration transaction. The second is a multi-actor state machine with an append-only audit trail. They share a branch because both depend on `authenticate` and `authorize`, but they are architecturally unrelated problems.

---

**Sub-system 1 — Institution Auto-Verification**

`src/db/utils/institutions.js` — single exported function `findInstitutionByDomain(domain, client?)`. Accepts a clean domain string (not a raw email — domain extraction is the service layer's responsibility). Queries `institutions WHERE email_domain = $1 AND deleted_at IS NULL`, returns `{ institution_id, name }` or `null`. The `deleted_at IS NULL` predicate is mandatory — it matches the partial unique index predicate and forces PostgreSQL to use the index scan rather than a sequential scan. Follows the same `client?` defaulting-to-pool contract as `findUserById` and `findUserByEmail`.

`src/services/auth.service.js` — the registration transaction is extended, not restructured. After the `student_profiles` INSERT, `findInstitutionByDomain` is called with the transaction client, passing `email.split('@')[1]`. On a match: `UPDATE student_profiles SET institution_id = $1 WHERE user_id = $2` and `UPDATE users SET is_email_verified = TRUE WHERE user_id = $1`, both using the transaction client. On no match: nothing runs, the default `is_email_verified = FALSE` / `institution_id = NULL` state persists. The entire block is gated `if (role === 'student')` — PG owner registration is untouched.

The atomicity requirement, the stale RETURNING value problem (`effectivelyVerified`), and the `ON DELETE SET NULL` schema constraint are all documented in the original Level 2 plan and remain unchanged.

---

**Sub-system 2 — PG Owner Verification Pipeline**

The state machine, all four service functions (`submitDocument`, `getVerificationQueue`, `approveRequest`, `rejectRequest`), the admin router with router-level authorization, keyset pagination rationale, and the concurrency safety pattern on approve/reject are all implemented and stable. Full documentation in the original Level 2 plan is carried forward unchanged.

**Files built in this branch:**

| File | Type |
|------|------|
| `src/db/utils/institutions.js` | New |
| `src/services/verification.service.js` | New |
| `src/controllers/verification.controller.js` | New |
| `src/validators/verification.validators.js` | New |
| `src/routes/admin.js` | New |
| `src/services/auth.service.js` | Modified (registration transaction extended) |
| `src/routes/pgOwner.js` | Modified (one new route) |
| `src/routes/index.js` | Modified (admin router mounted) |

---

### Level 2.5 — Dual-Client Auth Transport `phase1/auth-transport` ← NEXT

**Branch:** `phase1/auth-transport` → merges into `Phase1` before `phase1/verification` resumes

**Blocked by:** `phase1/institutions` merged into `Phase1` ✅

**Why this branch exists before verification continues:** The verification pipeline currently works correctly, but it serves a single client type. Before the frontend is built and before Google OAuth is layered on top, the auth transport layer must be hardened to serve both a browser client (the primary target) and an Android client simultaneously. Getting this right now means every subsequent feature — including the resumed `phase1/verification` — is born into a transport layer that is already correct, rather than retrofitting cookies around features that assumed bearer-only.

---

#### The Core Problem

The backend currently returns both tokens in the JSON response body and reads the access token from the `Authorization: Bearer` header on every protected request. This is correct and sufficient for Android clients and Postman. It is incomplete for browser clients, where the correct security posture is to use HttpOnly cookies — tokens stored in cookies cannot be read or stolen by JavaScript, which eliminates the primary XSS attack vector.

The challenge is that one backend must serve both client types without duplicating logic, creating two separate code paths, or breaking either client's expectations.

---

#### The Solution: Priority-Based Credential Extraction

The `authenticate` middleware is extended with a priority chain for finding the access token: it looks in `req.cookies.accessToken` first, and if that is empty or absent, falls through to the `Authorization: Bearer` header. The token verification logic (`jwt.verify`, `findUserById`, the `INACTIVE_STATUSES` check, the `req.user` attachment) is identical regardless of which source produced the token. Only the extraction point differs.

This design means the middleware does not know or care which client type is calling. It simply tries the more secure transport first. A browser client will always hit the cookie path. An Android client will always hit the header path. The routing is automatic and requires zero per-request decision-making.

---

#### The Silent Refresh Problem

When the access token expires, the correct behavior diverges sharply between the two client types, and this is the most important design decision in this branch.

For a **browser client**, the ideal experience is that expiry is invisible. The middleware detects the expired access token cookie, immediately looks for `req.cookies.refreshToken`, validates it against Redis, issues a new access token, sets it as a new cookie on the outgoing response, and allows the original request to proceed as if nothing happened. The browser never sees a 401. The frontend JavaScript never needs a refresh interceptor. Sessions simply keep working.

For an **Android client**, silent refresh in the middleware would be harmful. Android stores the refresh token in EncryptedSharedPreferences and sends the access token as a Bearer header. If the middleware silently rotated the token without Android knowing, the app's stored token would become stale, and the very next request would fail with a 401 that cannot be recovered from without re-login. Android expects the standard mobile pattern: receive a 401, call `POST /auth/refresh` explicitly with the stored refresh token, receive a new access token, update storage, and retry.

The rule that unifies both cases is: **attempt silent refresh only when the expired token was found in a cookie.** Finding an expired token in the `Authorization` header means the client is managing its own token lifecycle — return a 401 and let it handle things explicitly.

---

#### What the Login and Register Responses Do

This is the key insight that makes the whole system work without choosing sides. The controller for login and register does **both** things simultaneously: it sets the tokens as HttpOnly cookies on the response, and it also includes them in the JSON body. This is not redundant — it is deliberate dual-delivery.

A browser client receives the cookies, stores them automatically at the OS level (outside JavaScript's reach), and ignores the tokens in the body. An Android client receives the tokens in the body, stores them in EncryptedSharedPreferences, and ignores the cookies. Both clients are served correctly by the same response with zero conditional logic.

The `res.cookie()` options that must be applied: `httpOnly: true` (invisible to JavaScript), `secure: config.NODE_ENV === 'production'` (HTTPS-only in prod, plain HTTP allowed in dev), `sameSite: 'strict'` (cookies only sent on same-origin requests, blocking CSRF), and `maxAge` matching the JWT TTL in milliseconds (so the cookie and the token expire together — no stale cookies holding an expired token).

The `maxAge` calculation requires the `parseTtlSeconds` helper from `auth.service.js` to be exported, since it is the single source of truth for TTL arithmetic.

---

#### The Refresh Endpoint

`POST /auth/refresh` stays exactly as it is for Android — reads `req.body.refreshToken`, validates against Redis, returns a new access token in the JSON body. Android uses this endpoint explicitly. The browser never calls it because the middleware handles refresh transparently.

The one scenario where a browser does encounter a 401 is when both the access token cookie and the refresh token cookie have expired simultaneously (the user has not visited in 7 days). In that case the middleware has no refresh token to work with, returns a 401, and the frontend redirects to the login page. This is correct behavior — the session has genuinely ended.

---

#### Files Changed and Why

Only three files change in this branch:

`src/middleware/authenticate.js` gains the priority extraction chain (cookies first, then header) and the conditional silent refresh path (only when the token source was a cookie). This is the only file with substantive new logic.

`src/controllers/auth.controller.js` gains `res.cookie()` calls on register, login, and a cookie-clearing call on logout. The JSON body response is kept intact — this is purely additive. The controller does not change its service calls or response shape in any other way.

`src/services/auth.service.js` exports `parseTtlSeconds` as a named export so the controller can calculate `maxAge` without duplicating the TTL parsing logic. This is a one-line addition.

The validators, routes, service logic, database queries, Redis storage, and schema are all entirely unchanged.

---

#### How Each Client Experiences the System After This Branch

A **browser client** logs in, receives cookies set automatically by the response, and never thinks about tokens again. Every subsequent request attaches cookies automatically. When the access token expires mid-session, the middleware silently refreshes and the request proceeds. The session ends only when the refresh token cookie expires after 7 days of inactivity, producing a 401 that the frontend handles by redirecting to login.

An **Android client** logs in, reads the tokens from the JSON body, stores the refresh token in EncryptedSharedPreferences, and sends the access token as `Authorization: Bearer` on every request. When the access token expires, it receives a 401, calls `POST /auth/refresh` explicitly, receives a new access token, updates its storage, and retries the original request. Nothing about this flow changes from the current behavior.

**Files changed:**

| File | Change |
|------|--------|
| `src/middleware/authenticate.js` | Priority extraction (cookie → header) + conditional silent refresh |
| `src/controllers/auth.controller.js` | `res.cookie()` on login/register, `res.clearCookie()` on logout |
| `src/services/auth.service.js` | Export `parseTtlSeconds` for cookie `maxAge` calculation |

**Regression tests (must still pass after this branch):** All seven auth endpoints from Level 1. All profile GET and PUT routes. The verification queue and resolution endpoints. Health check.

**What `phase1/verification` inherits from this:** The `authenticate` middleware is now transport-agnostic. The Google OAuth registration path (the primary target of `phase1/verification`) will go through the same login response pattern — setting cookies and returning body tokens simultaneously — without any additional middleware changes.

---

### Level 2.6 — Google OAuth + Verification Hardening `phase1/verification` ⏸ HALTED

**Blocked by:** `phase1/auth-transport` merged into `Phase1`

**Why halted:** The `phase1/auth-transport` branch must be complete and merged first. The Google OAuth callback is a new authentication entry point — it must go through the same dual-delivery response (cookies + body) that the email/password login uses. Building it before the transport layer is settled would mean retrofitting cookie logic onto the OAuth path after the fact, which risks inconsistency.

**What this branch will build when it resumes:**

This branch completes the `findUserByGoogleId` stub in `src/db/utils/auth.js` and implements the full Google OAuth registration and login flow. A Google OAuth user registers via the `/auth/google/callback` endpoint. The backend verifies the Google ID token using `google-auth-library`, extracts the verified email, runs the same institution domain lookup as the email/password registration path, and issues tokens via the same `buildTokenResponse` function. The response uses the same dual-delivery pattern (cookies + body) established in `phase1/auth-transport`.

The `phase1/verification` branch also completes any remaining hardening on the verification pipeline that was identified during review of `phase1/institutions` but was not addressed in that branch.

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
| 1 — Foundation & Identity | 0, 1, 2 | Levels 0 + 1 + 2 ✅, 2.5 next, 2.6 ⏸ | Register, log in, verify, upload documents | Schema applied, `.env.local` valid |
| 2 — Listings & Search | 3, 4 | Not started | Post listings, search by filters + proximity, photos, compatibility scores | Phase 1 fully stable |
| 3 — Interaction Pipeline | 5, 6 | Not started | Send interest, accept/decline, WhatsApp contact, confirm interactions, notification feed | Phase 2 stable |
| 4 — Reputation System | 7 | Not started | Rate users and properties, report ratings, admin moderation, cached averages | Phase 3 stable |
| 5 — Operations & Admin | 8, 9 | Not started | Auto-expiry, cleanup cron, full admin control panel, analytics | Phase 4 stable |
| 6 — Real-Time (Future) | 10 | Deferred | Push notifications via WebSocket, replaces polling | Phase 3 polling confirmed, real users exist |

---

*— Last updated: phase1/institutions merged; phase1/auth-transport designed and ready to build; phase1/verification halted pending transport layer —*