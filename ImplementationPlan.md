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

## Branch Status

```
main
 └── Phase1                        ✅ COMPLETE
      ├── phase1/foundation         ✅ MERGED
      ├── phase1/auth               ✅ MERGED
      ├── phase1/institutions       ✅ MERGED
      ├── phase1/auth-transport     ✅ MERGED
      └── phase1/verification       ✅ MERGED
 └── Phase2                        ✅ COMPLETE
      ├── phase2/amenities          ✅ MERGED
      ├── phase2/listings           ✅ MERGED
      ├── phase2/media              ✅ MERGED
      └── phase2/saved              ✅ MERGED
 └── Phase3                        ✅ COMPLETE
      ├── phase3/interests          ✅ MERGED
      ├── phase3/connections        ✅ MERGED
      └── phase3/notifications      ✅ MERGED
 └── Phase4                        ← NEXT (Reputation System)
 └── Phase5                        ← PLANNED (Operations & Admin)
 └── Phase6                        ← DEFERRED (Real-Time WebSocket)
```

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

### Auth Transport Conventions
**Dual-delivery on every auth response.** Login, register, and any future OAuth callback must always: set `accessToken` and `refreshToken` as HttpOnly cookies AND include both tokens in the JSON body. Browser clients use cookies; Android clients use the body. Never do only one.

**Cookie options are fixed.** Every `res.cookie()` call for auth tokens must use `httpOnly: true`, `secure: config.NODE_ENV === 'production'`, `sameSite: 'strict'`, and `maxAge` derived from `parseTtlSeconds()` × 1000. Options must be identical between set and clear calls.

**`parseTtlSeconds` is the single TTL source of truth.** Exported from `src/services/auth.service.js`. Import it wherever cookie `maxAge` or Redis TTL needs to be computed from a JWT expiry string.

**Silent refresh is cookie-only.** The `authenticate` middleware attempts silent refresh exclusively when the expired token came from `req.cookies.accessToken`. An expired Bearer header token always returns 401 immediately.

**`buildTokenResponse` is the canonical token-issuing function.** All future authentication paths must go through it.

### Notifications Convention
Always post-commit, never inside a transaction. Enqueue to `notification-queue` via BullMQ. A notification failure never rolls back a state transition. The worker handles INSERT with retry (5 attempts, exponential backoff).

### Pagination Convention
Keyset cursor. Fetch `limit + 1` rows to detect next page. Cursor fields must both be present or both absent (validated at Zod layer). Compound cursor `(created_at, entity_id)` provides stable ordering under concurrent inserts.

### Security Decisions (Permanent)
- `DUMMY_HASH` in `auth.service.js` is a pre-computed bcrypt hash of `"dummy"` at 10 rounds. **Never remove. Never replace with a runtime `bcrypt.hash()` call.**
- `INACTIVE_STATUSES` is module-scope, allocated once.
- OTP verify has no IP rate limiter — service-layer attempt counter (`otpAttempts:{userId}`, max 5) is the only throttle.
- Silent refresh is cookie-only — expired Bearer token always 401.
- `404` not `403` for party-membership checks on connections and ratings — never confirm resource existence to non-parties.

---

## Complete Source File Inventory

```
src/
  server.js                         ✅ Starts media + notification workers; graceful shutdown
  app.js                            ✅ Middleware order fixed, CORS guard at startup
  config/env.js                     ✅ Zod env validation — add new vars here before use
  db/
    client.js                       ✅ pg.Pool singleton; fatalCodes for ECONNREFUSED/ENOTFOUND
    seeds/
      amenities.js                  ✅ Idempotent ON CONFLICT DO NOTHING seed (19 amenities)
    utils/
      auth.js                       ✅ findUserById, findUserByEmail, findUserByGoogleId
      institutions.js               ✅ findInstitutionByDomain(domain, client?)
      pgOwner.js                    ✅ assertPgOwnerVerified(userId, client?)
      spatial.js                    ✅ findListingsNearPoint — ST_DWithin with geography cast
      compatibility.js              ✅ scoreListingsForUser — JOIN on (preference_key, value)
  cache/client.js                   ✅ Exponential backoff, MAX_RETRY_ATTEMPTS=10
  logger/index.js                   ✅ Pino — structured logging, never console.log
  middleware/
    authenticate.js                 ✅ extractToken (cookie→header priority),
                                       attemptSilentRefresh (cookie-only), INACTIVE_STATUSES
    authorize.js                    ✅ Call-time role validation throws Error at route registration
    errorHandler.js                 ✅ AppError + ZodError + PG constraint codes + JWT errors
    rateLimiter.js                  ✅ authLimiter (10/15min), otpLimiter (5/15min)
    validate.js                     ✅ Writes result.data back to req
    upload.js                       ✅ Multer — MIME type + extension cross-check, 10MB limit
  services/
    auth.service.js                 ✅ register, login, logout, refresh, sendOtp, verifyOtp,
                                       googleOAuth — all paths end at buildTokenResponse
    email.service.js                ✅ maskEmail guard, OTP format guard, transport at module level
    student.service.js              ✅ Dynamic SET clause, ownership check
    pgOwner.service.js              ✅ Same pattern as student
    verification.service.js         ✅ submitDocument, getVerificationQueue (keyset),
                                       approveRequest, rejectRequest (AND status='pending' guard)
    property.service.js             ✅ Full CRUD; soft-delete blocked if active listings exist
    listing.service.js              ✅ Full CRUD + search (dynamic WHERE + proximity +
                                       compatibility) + preferences + save/unsave;
                                       rent stored in paise, divided by 100 on read
    photo.service.js                ✅ enqueuePhotoUpload (202 pattern), getListingPhotos,
                                       deletePhoto, setCoverPhoto, reorderPhotos
    interest.service.js             ✅ createInterestRequest, transitionInterestRequest
                                       (accepted transition atomically creates connections row),
                                       getInterestRequest, getInterestRequestsForListing,
                                       getMyInterestRequests, expirePendingRequestsForListing
    connection.service.js           ✅ confirmConnection (single atomic UPDATE with CASE WHEN),
                                       getConnection, getMyConnections
    notification.service.js         ✅ getFeed, getUnreadCount, markRead (bulk + selective)
    rating.service.js               ✅ submitRating (WHERE EXISTS confirmation check + ON CONFLICT),
                                       getRatingsForConnection, getPublicRatings,
                                       getMyGivenRatings, getPublicPropertyRatings
  controllers/
    auth.controller.js              ✅ register, login, logout, refresh, sendOtp, verifyOtp,
                                       me, googleCallback
    student.controller.js           ✅ getProfile, updateProfile
    pgOwner.controller.js           ✅ getProfile, updateProfile
    verification.controller.js      ✅ submitDocument, getVerificationQueue,
                                       approveRequest, rejectRequest
    property.controller.js          ✅ createProperty, getProperty, listProperties,
                                       updateProperty, deleteProperty
    listing.controller.js           ✅ createListing, getListing, searchListings, updateListing,
                                       deleteListing, getListingPreferences,
                                       updateListingPreferences, saveListing, unsaveListing,
                                       getSavedListings
    photo.controller.js             ✅ uploadPhoto, getPhotos, deletePhoto,
                                       setCoverPhoto, reorderPhotos
    interest.controller.js          ✅ createInterestRequest, getInterestRequest,
                                       updateInterestStatus, getListingInterests,
                                       getMyInterestRequests
    connection.controller.js        ✅ confirmConnection, getConnection, getMyConnections
    notification.controller.js      ✅ getFeed, getUnreadCount, markRead
    rating.controller.js            ✅ submitRating, getRatingsForConnection, getPublicRatings,
                                       getMyGivenRatings, getPublicPropertyRatings
  routes/
    index.js                        ✅ Mounts all routers at /api/v1
    health.js                       ✅ GET /health — 3s timeout probes, clearTimeout in finally
    auth.js                         ✅ 8 auth endpoints including google/callback
    student.js                      ✅ GET + PUT /:userId/profile
    pgOwner.js                      ✅ GET + PUT /:userId/profile + POST /:userId/documents
    admin.js                        ✅ authenticate + authorize('admin') at router level;
                                       verification queue management
    property.js                     ✅ Full CRUD — pg_owner only for writes
    listing.js                      ✅ Full CRUD + preferences + save/unsave + photos +
                                       interest sub-routes
    interest.js                     ✅ /me + /:interestId + /:interestId/status
    connection.js                   ✅ /me + /:connectionId + /:connectionId/confirm
    notification.js                 ✅ / + /unread-count + /mark-read
    rating.js                       ✅ POST / + /me/given + /user/:userId +
                                       /property/:propertyId + /connection/:connectionId
  validators/
    auth.validators.js              ✅ registerSchema, loginSchema, refreshSchema,
                                       otpVerifySchema, googleCallbackSchema
    student.validators.js           ✅ getStudentParamsSchema, updateStudentSchema
    pgOwner.validators.js           ✅ getPgOwnerParamsSchema, updatePgOwnerSchema
    verification.validators.js      ✅ submitDocumentSchema, getQueueSchema,
                                       approveRequestSchema, rejectRequestSchema
    property.validators.js          ✅ propertyParamsSchema, listPropertiesSchema,
                                       createPropertySchema, updatePropertySchema
    listing.validators.js           ✅ Full suite including searchListingsSchema
                                       (cross-field: rent range, cursor, proximity),
                                       createListingSchema, updateListingSchema,
                                       updatePreferencesSchema, saveListingSchema
    photo.validators.js             ✅ uploadPhotoSchema, deletePhotoSchema,
                                       reorderPhotosSchema, setCoverSchema
    interest.validators.js          ✅ createInterestSchema, interestParamsSchema,
                                       updateInterestStatusSchema, getListingInterestsSchema,
                                       getMyInterestsSchema
    connection.validators.js        ✅ connectionParamsSchema, getMyConnectionsSchema
    notification.validators.js      ✅ getFeedSchema, markReadSchema
    rating.validators.js            ✅ submitRatingSchema, getRatingsForConnectionSchema,
                                       getPublicRatingsSchema, getMyGivenRatingsSchema,
                                       getPublicPropertyRatingsSchema
  storage/
    index.js                        ✅ Selects adapter from config.STORAGE_ADAPTER at startup
    adapters/
      localDisk.js                  ✅ Dev adapter — writes WebP to /uploads/listings/{listingId}/
      azureBlob.js                  ✅ Stub — throws 501; ready for Azure credentials
  workers/
    queue.js                        ✅ Named singleton registry — prevents duplicate Redis connections
    mediaProcessor.js               ✅ Sharp resize→WebP, storage write, DB update, cover election,
                                       staging cleanup — concurrency 1
    notificationWorker.js           ✅ Notification INSERT with idempotency key, concurrency 10
```

---

## Phase 1 — Foundation & Identity ✅ COMPLETE

**Goal:** A person can register as a student or PG owner, log in, receive an OTP, and the server correctly identifies them on every subsequent request. Institution auto-verification works. PG owner document upload creates a `verification_requests` row. An admin can view the verification queue and approve or reject submissions.

### `phase1/foundation` ✅

Server, app, config, database pool, Redis client, logger, error handler, validate middleware, health route. **Verified:** health 200, missing env var exits cleanly, `GET /` returns 404 JSON.

### `phase1/auth` ✅

Full auth pipeline: register (with institution domain lookup in same transaction), login (DUMMY_HASH timing equalization), logout, refresh (account_status enforced), OTP send/verify (service-layer attempt counter — no IP rate limiter on verify route), `GET /auth/me`. Student and PG owner profile GET/PUT. `authenticate` and `authorize` middleware. Rate limiters.

**Hardening baked in permanently:** `authorize` throws at route registration (not per-request), concurrent registration race guarded with inner try/catch on `23505`, OTP exhaustion returns 429 on the 5th wrong attempt, `crypto.randomInt` upper bound `1000000` (exclusive) gives full `100000–999999` range, `otpVerifySchema` uses digit-only regex not just length check.

### `phase1/institutions` ✅

`findInstitutionByDomain` queries with `deleted_at IS NULL` to hit the partial unique index. Registration transaction extended: domain match triggers `UPDATE student_profiles SET institution_id` + `UPDATE users SET is_email_verified = TRUE` in the same `BEGIN/COMMIT`. `effectivelyVerified` tracks the post-UPDATE state — the RETURNING value from INSERT is always FALSE and cannot be trusted.

PG owner verification pipeline: `submitDocument` (ownership + profile check + INSERT), `getVerificationQueue` (keyset pagination, oldest-first anti-starvation), `approveRequest` / `rejectRequest` (both with `AND status = 'pending'` concurrency guard). Admin router has `authenticate + authorize('admin')` at router level — architecturally impossible to add an unprotected route there.

### `phase1/auth-transport` ✅

`setAuthCookies` / `clearAuthCookies` added to auth controller. `ACCESS_COOKIE_OPTIONS` / `REFRESH_COOKIE_OPTIONS` computed once at module scope from `parseTtlSeconds`. Silent refresh in `authenticate.js`: cookie-source expiry only — loads fresh roles and email from DB, signs new access token, sets replacement cookie. Bearer-source expiry always 401 immediately, no silent refresh attempted.

### `phase1/verification` ✅

`findUserByGoogleId` completed. `googleOAuth` service covers three paths: returning OAuth user, account linking (`AND google_id IS NULL` concurrency guard on UPDATE), new registration (same institution domain transaction, `password_hash = NULL`, `is_email_verified = TRUE`). `refreshSchema` updated: `refreshToken` optional in body — browser sends no body, reads from cookie. `submitDocument` hardened: verifies caller holds `pg_owner` role.

**Full route surface after Phase 1:**
```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
POST   /api/v1/auth/refresh
POST   /api/v1/auth/otp/send
POST   /api/v1/auth/otp/verify
GET    /api/v1/auth/me
POST   /api/v1/auth/google/callback
GET    /api/v1/students/:userId/profile
PUT    /api/v1/students/:userId/profile
GET    /api/v1/pg-owners/:userId/profile
PUT    /api/v1/pg-owners/:userId/profile
POST   /api/v1/pg-owners/:userId/documents
GET    /api/v1/admin/verification-queue
POST   /api/v1/admin/verification-queue/:id/approve
POST   /api/v1/admin/verification-queue/:id/reject
```

---

## Phase 2 — Listings & Search ✅ COMPLETE

**Goal:** A verified PG owner can create a property and attach listings to it. A student can search by city, rent range, room type, amenities, and proximity. Photos upload and compress asynchronously. Compatibility scores appear on search results. A student can save listings.

### `phase2/amenities` ✅

Idempotent amenity seed (19 amenities across utility/safety/comfort categories, `ON CONFLICT DO NOTHING`). Property CRUD with `assertPgOwnerVerified` guard before any write. Amenity junction rows managed in same transaction as property INSERT. Soft-delete blocked if active listings exist.

### `phase2/listings` ✅

**The paise rule:** rent and deposit stored in paise in DB, divided by 100 before returning to caller. Conversion happens only in `listing.service.js` — never in validators or controllers. `expires_at = NOW() + INTERVAL '60 days'` set server-side at creation, never accepted from the request body.

Search: dynamic parameterised WHERE clause (city ILIKE, rent range in paise, roomType, bedType, preferredGender, listingType, availableFrom, amenity EXISTS subquery per amenity). Proximity via `findListingsNearPoint` (ST_DWithin with geography cast, meters). Compatibility via `scoreListingsForUser` (JOIN on preference_key + preference_value). Score never stored, computed fresh per search.

`updateListingStatus` handles poster-initiated transitions: `active → filled`, `active → deactivated`, `deactivated → active`. Terminal state: `filled → *` not allowed (new listing required). `expirePendingRequestsForListing` wired into the status-update path — runs inside the same transaction.

### `phase2/media` ✅

`StorageService` interface with `LocalDiskAdapter` (dev) and `AzureBlobAdapter` (stub, throws 501). `STORAGE_ADAPTER` env var selects adapter at startup. Upload returns `202 Accepted` immediately with `{ photoId, status: 'processing' }`. BullMQ `media-processing` queue worker: Sharp resize to 1200px max → WebP quality 80 → strip EXIF → storage write → DB URL update → cover election (`NOT EXISTS` guard in single UPDATE) → staging cleanup. Concurrency 1. Started in `server.js`, closed before Redis disconnects.

**Placeholder sentinel:** `photo_url = 'processing:{photoId}'` — never render URLs starting with `processing:`.

### `phase2/saved` ✅

`saveListing`: `ON CONFLICT DO UPDATE SET deleted_at = NULL, saved_at = NOW()` — idempotent re-save restores a previously soft-deleted row. `unsaveListing`: soft-delete via `SET deleted_at = NOW()`. `getSavedListings`: silently omits soft-deleted and expired listings, keyset paginated on `saved_at DESC`.

**Full route surface after Phase 2:**
```
POST   /api/v1/properties
GET    /api/v1/properties
GET    /api/v1/properties/:propertyId
PUT    /api/v1/properties/:propertyId
DELETE /api/v1/properties/:propertyId
POST   /api/v1/listings
GET    /api/v1/listings                                   (search)
GET    /api/v1/listings/me/saved
GET    /api/v1/listings/:listingId
PUT    /api/v1/listings/:listingId
DELETE /api/v1/listings/:listingId
GET    /api/v1/listings/:listingId/preferences
PUT    /api/v1/listings/:listingId/preferences
POST   /api/v1/listings/:listingId/save
DELETE /api/v1/listings/:listingId/save
GET    /api/v1/listings/:listingId/photos
POST   /api/v1/listings/:listingId/photos
DELETE /api/v1/listings/:listingId/photos/:photoId
PATCH  /api/v1/listings/:listingId/photos/:photoId/cover
PUT    /api/v1/listings/:listingId/photos/reorder
```

---

## Phase 3 — Interaction Pipeline ✅ COMPLETE

**Goal:** A student can express interest. A PG owner can accept or decline. On acceptance, a connection is created atomically and the student receives the poster's WhatsApp deep-link in the same response. Both parties can confirm the real-world interaction happened. A notification feed keeps both parties informed throughout.

### `phase3/interests` ✅

State machine: `pending → accepted | declined | withdrawn | expired`.

**The critical atomic block:** the `accepted` transition runs `UPDATE interest_requests SET status = 'accepted'` + `INSERT INTO connections` + `expirePendingRequestsForListing` all inside one `BEGIN/COMMIT`. A crash between any two steps leaves the DB in a consistent state — no orphaned accepted request without a connection row, no pending requests for a listing that just got a confirmed taker.

`connection_type` derived from `listing.listing_type`: `student_room → student_roommate`, `pg_room → pg_stay`, `hostel_bed → hostel_stay`. WhatsApp deep-link (`https://wa.me/91${phone}`) returned in the accepted response body. `null` if poster has no phone number — not an error, connection still created. Duplicate prevention: partial unique index prevents more than one `pending` or `accepted` request from the same student to the same listing.

Notifications fire post-commit (never inside the transaction): `new_interest_request` → poster, `interest_request_accepted` → sender, `interest_request_declined` → sender, `interest_request_withdrawn` → poster.

### `phase3/connections` ✅

Two-sided confirmation via a single atomic UPDATE — no read-then-write race condition:

```sql
UPDATE connections SET
  initiator_confirmed   = CASE WHEN initiator_id  = $2 THEN TRUE ELSE initiator_confirmed  END,
  counterpart_confirmed = CASE WHEN counterpart_id = $2 THEN TRUE ELSE counterpart_confirmed END,
  confirmation_status   = CASE
    WHEN (initiator_confirmed  OR initiator_id  = $2)
     AND (counterpart_confirmed OR counterpart_id = $2)
    THEN 'confirmed' ELSE confirmation_status END,
  updated_at = NOW()
WHERE connection_id = $1
  AND (initiator_id = $2 OR counterpart_id = $2)
  AND deleted_at IS NULL
RETURNING *
```

`rowCount === 0` → 404 (never 403 — existence not confirmed to non-parties). `connection_confirmed` notifications fire post-commit to both parties when `confirmed` is reached.

### `phase3/notifications` ✅

**Two-layer architecture:** Layer 1 (storage) — the durable notification row in PostgreSQL. Layer 2 (delivery) — BullMQ worker with 5-attempt exponential backoff, concurrency 10 (pure I/O, no CPU cost). `getUnreadCount` hits the partial index `WHERE is_read = FALSE` — fast regardless of total notification history size. `markRead` with `AND is_read = FALSE` guard makes all modes idempotent. `AND recipient_id = $1` on selective mark-read prevents a user from marking another user's notifications as read. All inline `pool.query` notification calls from earlier branches were refactored to `notificationQueue.add()` enqueues in this branch.

**Full route surface after Phase 3:**
```
POST   /api/v1/listings/:listingId/interests
GET    /api/v1/listings/:listingId/interests
GET    /api/v1/interests/me
GET    /api/v1/interests/:interestId
PATCH  /api/v1/interests/:interestId/status
POST   /api/v1/connections/:connectionId/confirm
GET    /api/v1/connections/me
GET    /api/v1/connections/:connectionId
GET    /api/v1/notifications
GET    /api/v1/notifications/unread-count
POST   /api/v1/notifications/mark-read
```

---

## DB Trigger Reference

The `update_rating_aggregates` trigger on the `ratings` table fires after INSERT or after UPDATE of `is_visible`. It recalculates `average_rating` and `rating_count` on `users` or `properties` for the affected `reviewee_id`. Application code **never** manually updates these aggregate columns.

---

## Phase 4 — Reputation System ← NEXT

**Entry condition:** Phase 3 fully stable. At least one `connections` row with `confirmation_status = 'confirmed'` exists in the database.

**Goal:** A participant in a confirmed connection can rate the other party or the associated property. Cached rating aggregates update automatically via DB trigger. Ratings can be reported. Admins can moderate the report queue and remove abusive ratings — triggering automatic aggregate recalculation.

**Branch structure:**
```
Phase4
 ├── phase4/ratings      ← rating submission + public read endpoints
 └── phase4/moderation   ← report pipeline + admin report queue
```

### `phase4/ratings`

**Files to create:** `src/validators/rating.validators.js`, `src/services/rating.service.js`, `src/controllers/rating.controller.js`, `src/routes/rating.js`, mount in `src/routes/index.js`.

**The anti-fake-review guarantee:** rating submission uses a single `INSERT ... WHERE EXISTS` statement that atomically verifies three things in one query: (1) the connection exists and is not deleted, (2) `confirmation_status = 'confirmed'`, and (3) the reviewer is a party to it (`initiator_id` or `counterpart_id`). No separate read-then-write — the WHERE EXISTS is the gate. `ON CONFLICT (reviewer_id, connection_id, reviewee_id) DO NOTHING` handles duplicate submissions atomically.

`rowCount === 0` disambiguation: a follow-up connection query determines whether the WHERE EXISTS failed (404 if connection not found, 422 if not yet confirmed) versus the ON CONFLICT fired (409 duplicate). Never 403.

Property rating guard: the WHERE EXISTS join traverses `connections → listings → properties` to verify the rated property is the one associated with this specific confirmed connection — prevents rating an arbitrary property using an unrelated connection.

Public rating endpoints (`GET /ratings/user/:userId`, `GET /ratings/property/:propertyId`) require no authentication — they are part of the trust-first read model, visible to anyone evaluating whether to trust a user before registering.

**Route surface:**
```
POST   /api/v1/ratings
GET    /api/v1/ratings/me/given
GET    /api/v1/ratings/connection/:connectionId
GET    /api/v1/ratings/user/:userId              (public — no auth required)
GET    /api/v1/ratings/property/:propertyId      (public — no auth required)
```

**Completion criteria:** A party to a confirmed connection can submit a rating. Duplicate submission returns 409. A non-party attempting to rate gets 404. Rating against an unconfirmed connection gets 422. Public rating endpoints return results with no auth. The `update_rating_aggregates` DB trigger fires automatically — `average_rating` and `rating_count` update without any application code. Health check still 200.

### `phase4/moderation`

**Files to create:** `src/validators/report.validators.js`, `src/services/report.service.js`, `src/controllers/report.controller.js`. Modifications to `src/routes/rating.js` (add report route) and `src/routes/admin.js` (add report queue + resolve routes).

`submitReport(reporterId, ratingId)` — INSERT into `rating_reports`. A partial unique index (`WHERE status = 'open'`) prevents duplicate open reports from the same reporter on the same rating. The reporter must be a party to the connection that the rating references — enforced via WHERE EXISTS join, same pattern as rating submission. Duplicate open report → 409.

`getReportQueue` (admin only) — keyset paginated on `(submitted_at ASC, report_id ASC)`, oldest-first to prevent starvation. Each row includes the rating detail, reporter's public profile, and reviewee's public profile so the admin has full context to decide without a second request.

`resolveReport(adminId, reportId, resolution)` handles two outcomes. `resolved_removed`: a transaction that sets `rating_reports.status = 'resolved_removed'` and `ratings.is_visible = FALSE` — the `update_rating_aggregates` DB trigger fires automatically, no application code needed to update averages. `resolved_kept`: sets `rating_reports.status = 'resolved_kept'` only — rating stays visible, average unchanged. Both paths check `AND status = 'open'` as a concurrency guard, so two admins resolving the same report simultaneously results in one 409.

**Route surface:**
```
POST   /api/v1/ratings/:ratingId/report
GET    /api/v1/admin/report-queue
PATCH  /api/v1/admin/reports/:reportId/resolve
```

**Completion criteria:** A party to a connection can report a rating on that connection. Duplicate open report returns 409. Admin can view the full-context report queue. `resolved_removed` sets `is_visible = FALSE` and the trigger recalculates the average. `resolved_kept` closes the report without touching the rating. Resolving an already-resolved report returns 409. Health check still 200.

---

## Phase 5 — Operations & Admin ← PLANNED

**Entry condition:** Phase 4 fully stable.

**Goal:** The platform maintains itself without manual intervention. Full admin control surface for user and content management. Email delivery decoupled from the request cycle via a BullMQ worker.

**Branch structure:**
```
Phase5
 ├── phase5/cron     ← scheduled maintenance tasks + email worker
 └── phase5/admin    ← full admin control panel
```

### `phase5/cron`

Cron jobs via `node-cron`, registered and started in `server.js` alongside the existing BullMQ workers:

| Job | Schedule | Action |
|---|---|---|
| `listingExpiry` | daily 02:00 | `UPDATE listings SET status='expired' WHERE expires_at < NOW() AND status='active' AND deleted_at IS NULL` |
| `connectionExpiry` | daily 03:00 | Expire connections past their `end_date` |
| `expiryWarning` | daily 01:00 | Enqueue email + notification jobs for listings expiring within 7 days |
| `hardDeleteCleanup` | weekly Sunday 04:00 | `DELETE` rows where `deleted_at < NOW() - INTERVAL '90 days'` across all soft-delete tables |

`email-queue` BullMQ worker introduced here — same factory pattern as `notificationWorker.js`. 5-attempt exponential backoff. Concurrency appropriate to SMTP provider rate limits. Email jobs enqueued from the `expiryWarning` cron job and any future transactional email needs.

**`deleteProperty` hardening (carry forward from Phase 2):** The current implementation checks for active listings before soft-delete but does not wrap both in a transaction, creating a small race window. Phase 5 should harden this with `SELECT ... FOR UPDATE` on the property row inside the transaction.

### `phase5/admin`

Full additions to `src/routes/admin.js` (all protected by existing router-level `authenticate + authorize('admin')`):

User management: `GET /admin/users` (paginated, filterable by role + status), `GET /admin/users/:userId` (full profile + roles + status detail), `PATCH /admin/users/:userId/status` (suspend | ban | reactivate).

Rating visibility management: `GET /admin/ratings` (paginated, filterable by `is_visible`), `PATCH /admin/ratings/:ratingId/visibility`.

Analytics: `GET /admin/analytics/platform` returning DAU, new signups, active listings count, and connections formed — computed fresh on each request, no caching in this phase.

---

## Phase 6 — Real-Time ← DEFERRED

**Entry condition:** Phase 3 polling confirmed working in production with real users. WebSocket infrastructure justified by actual usage volume before building.

**Goal:** Replace polling-based notification delivery with WebSocket push. The existing HTTP notification endpoints remain in place — WebSocket is additive, not a replacement. Android clients that prefer explicit polling are unaffected.

**What gets built:**

`src/ws/server.js` — WebSocket server attached to the same HTTP server instance (no separate port). Auth via JWT from `?token=` query param on the WS handshake — HttpOnly cookies are not forwarded on WS upgrade requests. `src/ws/connectionMap.js` — `Map<userId, WebSocket>` for per-instance routing. `src/ws/pubsub.js` — Redis pub/sub channel `notifications:{userId}` for cross-instance fanout. This is required for Azure App Service: multiple instances mean a user's socket may be on a different instance than the one processing the notification job — pub/sub decouples instance identity from delivery.

The notification worker already INSERTs to the DB. Phase 6 adds one side-effect after the INSERT: publish to the user's Redis pub/sub channel. The instance holding that user's WebSocket connection receives the message and delivers it in-process.

---

## Phase Summary

| Phase | Focus | Status | What Becomes Possible |
|---|---|---|---|
| 1 — Foundation & Identity | Auth, profiles, institutions, Google OAuth, PG owner verification | ✅ Complete | Register, log in, verify email, upload documents, admin approve/reject |
| 2 — Listings & Search | Properties, listings, async photo upload, proximity + compatibility search, saved listings | ✅ Complete | Post listings, search by filters + proximity, compress photos, bookmark listings |
| 3 — Interaction Pipeline | Interest requests, connections, two-sided confirmation, notification feed | ✅ Complete | Full trust loop: interest → accept → WhatsApp → confirm → notify |
| 4 — Reputation System | Rating submission, public aggregates, report pipeline, admin moderation | ← Next | Rate confirmed interactions, report abusive ratings, admin remove with auto-recalculated averages |
| 5 — Operations & Admin | Cron jobs, email worker, full admin control panel, analytics | ← Planned | Auto-expiry, hard-delete cleanup, user management, platform analytics |
| 6 — Real-Time | WebSocket push over Redis pub/sub | ← Deferred | Replace polling with push — requires real user volume to justify infrastructure |

---

*— Last updated: Phase 3 complete (interests, connections, notifications all merged and stable). Phase 4 reputation system is next. —*