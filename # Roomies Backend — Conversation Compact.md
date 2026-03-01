# Roomies Backend — Conversation Compact

_Context summary as of: phase1/auth-transport merged_

---

## Project Identity

**Roomies** is a trust-first PG and roommate discovery platform for Indian college students. Node.js + Express, raw SQL
via `pg` (no ORM), Zod v4 for validation, JWT + bcryptjs + Google OAuth auth, Redis for OTP/token storage, BullMQ for
background jobs, Pino for structured logging. Target cloud: Azure. Local dev runs PostgreSQL 16 + PostGIS and Redis
directly on the host (no Docker).

The codebase is JavaScript ES modules (`"type": "module"` in package.json). All files begin with a path comment
(`// src/routes/auth.js`). `config` from `src/config/env.js` is the single source of truth for env vars — `process.env`
is never read directly in application code.

---

## What Has Been Built (Merged to Phase1 branch)

### phase1/foundation ✅

Express app, Pino logger, pg.Pool singleton, Redis singleton, Zod env validation at startup (process exits on
missing/bad vars), global error handler (`AppError` + Zod + PG constraints + JWT), `validate(schema)` middleware, health
check at `GET /api/v1/health` with 3s timeout probes, graceful shutdown on SIGINT/SIGTERM.

### phase1/auth ✅

Full email/password auth flow: register (transaction: users + profile + user_roles), login (DUMMY_HASH timing
equalisation), logout (Redis del), refresh (Redis validation + account_status check), OTP send/verify (bcrypt-hashed in
Redis, 5-attempt lockout). Authenticate middleware (Bearer token → req.user). Authorize factory (call-time role
validation). Rate limiters (authLimiter 10/15min, otpLimiter 5/15min). Student and PG owner profile GET/PUT. All
validators in `src/validators/`.

Key hardening decisions baked in: `DUMMY_HASH` is hardcoded (never replace at runtime). `INACTIVE_STATUSES` Set is
module-scope. `crypto.randomInt(100000, 1000000)` for OTP. OTP verify has no IP rate limiter (service-layer attempt
counter is the throttle). GET profile routes are world-readable by any authenticated user (intentional product decision,
not IDOR).

### phase1/institutions ✅

`findInstitutionByDomain(domain, client?)` in `src/db/utils/institutions.js`. Called inside registration transaction —
on a domain match, updates `institution_id` on `student_profiles` and flips `is_email_verified = TRUE`, all atomic.
`effectivelyVerified` variable tracks the post-UPDATE state because the INSERT RETURNING value is always FALSE. PG owner
verification pipeline: `submitDocument`, `getVerificationQueue` (keyset pagination with compound cursor),
`approveRequest`, `rejectRequest` (both with `AND status = 'pending'` concurrency safety). Admin router with
router-level `authenticate + authorize('admin')`.

### phase1/auth-transport ✅

**Three files changed, nothing else.**

`src/services/auth.service.js`: `parseTtlSeconds` promoted to named export. This is the single TTL source of truth —
import it anywhere cookie `maxAge` or Redis TTL needs to be computed from the env string (e.g. "7d", "15m").

`src/controllers/auth.controller.js`: `setAuthCookies(res, accessToken, refreshToken)` called in register and login
(before `res.json()`). `clearAuthCookies(res)` called in logout. Cookie options defined as module-level constants
(`ACCESS_COOKIE_OPTIONS`, `REFRESH_COOKIE_OPTIONS`) using `parseTtlSeconds`. Options: `httpOnly: true`,
`secure: config.NODE_ENV === 'production'`, `sameSite: 'strict'`, `maxAge: parseTtlSeconds(...) * 1000`. JSON body kept
intact — dual delivery is intentional.

`src/middleware/authenticate.js`: Restructured around `extractToken(req)` (cookie first → header fallback, returns
`{ token, source }` or null) and `attemptSilentRefresh(req, res)` (only called on TokenExpiredError from a cookie-source
token; validates refresh cookie against both JWT secret and Redis; loads fresh roles/email from DB; signs new access
token; sets replacement cookie on res; returns userId or null). Silent refresh is cookie-only — an expired Bearer token
always returns 401 immediately so Android can handle refresh explicitly.

**Invariant:** Browser clients receive cookies and never manage tokens. Android clients receive body tokens and handle
refresh explicitly via `POST /auth/refresh`. The same response serves both.

---

## Current State of Every Source File

```
src/
  server.js                      ← stable, no changes expected
  app.js                         ← stable, no changes expected
  config/env.js                  ← stable; add new vars to Zod schema here before use
  db/
    client.js                    ← stable
    utils/
      auth.js                    ← findUserById, findUserByEmail; findUserByGoogleId STUB
      institutions.js            ← findInstitutionByDomain(domain, client?)
  cache/client.js                ← stable
  logger/index.js                ← stable
  middleware/
    authenticate.js              ← UPDATED in auth-transport (cookie+header extraction, silent refresh)
    authorize.js                 ← stable
    errorHandler.js              ← stable
    rateLimiter.js               ← stable (authLimiter, otpLimiter)
    validate.js                  ← stable
  services/
    auth.service.js              ← UPDATED in auth-transport (parseTtlSeconds exported)
    email.service.js             ← stable
    student.service.js           ← stable
    pgOwner.service.js           ← stable
    verification.service.js      ← stable (may receive hardening in phase1/verification)
  controllers/
    auth.controller.js           ← UPDATED in auth-transport (cookie set/clear)
    student.controller.js        ← stable
    pgOwner.controller.js        ← stable
    verification.controller.js   ← stable
  routes/
    index.js                     ← stable
    auth.js                      ← stable (google/callback route added in next branch)
    student.js                   ← stable
    pgOwner.js                   ← stable
    admin.js                     ← stable
  validators/
    auth.validators.js           ← stable (googleCallbackSchema added in next branch)
    student.validators.js        ← stable
    pgOwner.validators.js        ← stable
    verification.validators.js   ← stable (possible hardening in next branch)
```

---

## What Is Next: phase1/verification

**Unblocked.** This branch has two deliverables.

**Deliverable 1 — Google OAuth.** Complete `findUserByGoogleId` stub in `src/db/utils/auth.js`. Add
`POST /api/v1/auth/google/callback` route. Controller receives Google ID token in body, verifies with
`google-auth-library`'s `OAuth2Client.verifyIdToken()`, extracts email and google_id. Service branches: existing
google_id → login path; new → registration path. Registration path runs the same institution domain lookup transaction
as email/password register. Both paths end at `buildTokenResponse` + dual-delivery response. `password_hash` is NULL for
OAuth users; `is_email_verified` starts TRUE (Google already verified it).

`refreshSchema` needs `refreshToken` made optional in body — browser clients calling `POST /auth/refresh` send no body.
The refresh service and controller need to read the token from `req.body.refreshToken ?? req.cookies?.refreshToken`.

**Deliverable 2 — Verification hardening.** At minimum: verify that `submitDocument` checks the authenticated user holds
the `pg_owner` role (not just that a profile exists). Confirm `getVerificationQueue` returns `user_id` in the response
so admin UI can deep-link to the owner profile.

---

## Non-Negotiable Conventions for All Future Work

Every auth response (register, login, OAuth callback) must use dual-delivery: `setAuthCookies` + JSON body. Cookie
options must be consistent between set and clear (same `sameSite`, `secure`, `httpOnly`). `parseTtlSeconds` from
`auth.service.js` is the only place TTL is computed. Silent refresh is cookie-source only. `buildTokenResponse` is the
only way to issue tokens. `DUMMY_HASH` is never replaced at runtime. Never read `process.env` directly — always use
`config`. Never `console.log` — always `logger`. Every route uses `validate(schema)` before the controller. `AppError`
for known errors, `next(err)` for unknown. Zod v4 API throughout (`z.email()`, `z.uuid()`, `error.issues`,
`{ error: '...' }`).
