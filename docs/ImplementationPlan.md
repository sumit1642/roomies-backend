# Roomies — Implementation Plan

**Derived from the Project Plan. Each phase delivers a working, testable slice. No phase begins until the previous one is stable and every endpoint is manually verified with real HTTP requests.**

---

## Stack

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
      ├── phase3/notifications      ✅ MERGED
      └── phase3/ratings            ✅ MERGED
 └── Phase4                        ✅ COMPLETE
      └── phase4/moderation         ✅ MERGED
 └── Phase5                        🔄 PARTIAL
      ├── phase5/cron               ✅ MERGED
      └── phase5/admin              ⏳ NOT STARTED
 └── Phase6                        ⏳ DEFERRED
```

---

## Established Conventions

These decisions were made during `phase1/foundation` and apply to every file written from this point forward.

**File path comment:** Every file must have its relative path as the first comment line: `// src/routes/auth.js`

**Environment files:** `.env.local` for local dev, `.env.azure` for Azure connectivity check only. `ENV_FILE` environment variable controls which file is loaded. All env vars are Zod-validated at startup — process exits on any missing or wrong-typed variable. Never read `process.env` directly in application code; always import `config` from `src/config/env.js`.

**npm scripts:**
```bash
npm run dev          # ENV_FILE=.env.local
npm run dev:azure    # ENV_FILE=.env.azure
npm start            # ENV_FILE=.env.local
npm run start:azure  # ENV_FILE=.env.azure
```

**Validation middleware:** `validate(schema)` from `src/middleware/validate.js`. After successful parse, `result.data` is written back to `req.body`, `req.query`, and `req.params`. Downstream handlers always see coerced types and Zod defaults.

**Error handling:** Throw `new AppError(message, statusCode)` for all known errors. Pass unknown errors to `next(err)`. Global handler covers ZodError, AppError, PostgreSQL constraint codes (`23505`, `23503`, `23514`), and JWT errors. Never expose stack traces.

**Zod v4 API:**

| Feature | Correct (v4) | Deprecated (v3) |
|---------|-------------|-----------------|
| Email | `z.email()` | `z.string().email()` |
| URL | `z.url()` | `z.string().url()` |
| UUID | `z.uuid()` | `z.string().uuid()` |
| Error list | `error.issues` | `error.errors` |
| Error message param | `{ error: '...' }` | `{ message: '...' }` |

**Health check:** `GET /api/v1/health` — returns 200 with both services `ok`, or 503 with `degraded` status. Each probe has a 3-second timeout via `Promise.race` with `clearTimeout` in `.finally()`.

**Graceful shutdown:** `server.js` handles `SIGINT` and `SIGTERM`. Shutdown order: HTTP → cron → workers → queues → PostgreSQL → Redis. Force-exits after 10 seconds. Redis uses `redis.close()` (not `redis.quit()` — deprecated in node-redis v5).

**Database queries:** Import `pool` from `src/db/client.js` for one-shot queries. For transactions: `pool.connect()` → `BEGIN / COMMIT / ROLLBACK` manually, always `client.release()` in `finally`. Stable reused queries go in `src/db/utils/` — one file per concern.

**Logging:** Import `logger` from `src/logger/index.js`. Structured: `logger.info({ userId }, 'message')`. Never `console.log`.

**Auth transport:** Every auth response sets `accessToken` and `refreshToken` as HttpOnly cookies AND includes both tokens in JSON body. Browser clients use cookies; Android clients use the body. Cookie options: `httpOnly: true`, `secure: config.NODE_ENV === 'production'`, `sameSite: 'strict'`, `maxAge: parseTtlSeconds(...) * 1000`. Options must be identical between set and clear calls.

**Silent refresh:** `authenticate` middleware attempts silent refresh exclusively when the expired token came from `req.cookies.accessToken`. An expired Bearer header token always returns 401 immediately.

**Notifications:** Always post-commit, never inside a transaction. Enqueue to `notification-delivery` queue via BullMQ `enqueueNotification()` helper in `src/workers/notificationQueue.js`. A notification failure never rolls back a state transition.

**Pagination:** Keyset cursor. Fetch `limit + 1` rows to detect next page. Compound cursor `(created_at, entity_id)` provides stable ordering under concurrent inserts. Both cursor fields must be present or both absent (validated at Zod layer).

**The paise rule:** `rent_per_month` and `deposit_amount` are stored in paise (1 rupee = 100 paise) in the database. Conversion happens only in `src/services/listing.service.js` — never in validators or controllers.

**Security decisions (permanent):**
- `DUMMY_HASH` in `auth.service.js` is a pre-computed bcrypt hash of `"dummy"` at 10 rounds. Never remove. Never replace with a runtime `bcrypt.hash()` call. Used for timing equalisation on unknown email logins.
- `INACTIVE_STATUSES` is module-scope, allocated once.
- OTP verify applies dual throttles: IP-level Redis counter (`ipAttempts:{ip}`, 50/15min, fail-closed) and service-layer per-user counter (`otpAttempts:{userId}`, max 5).
- `404` not `403` for party-membership checks — never confirm resource existence to non-parties. Applies to connections, ratings, interest requests.
- Property rating guard: WHERE EXISTS JOIN traverses `connections → listings → properties` — prevents rating an arbitrary property using an unrelated connection.

---

## Complete Source File Inventory

```
src/
  server.js                         ✅ Starts media + notification workers; registers cron jobs; graceful shutdown
  app.js                            ✅ Middleware order fixed, CORS guard at startup
  config/
    env.js                          ✅ Zod env validation — add new vars here before use
    constants.js                    ✅ MAX_UPLOAD_SIZE_BYTES, UPLOAD_FIELD_NAME
  db/
    client.js                       ✅ pg.Pool singleton; fatalCodes for ECONNREFUSED/ENOTFOUND
    seeds/
      amenities.js                  ✅ Idempotent ON CONFLICT DO NOTHING seed (19 amenities)
    utils/
      auth.js                       ✅ findUserById, findUserByEmail, findUserByGoogleId
      institutions.js               ✅ findInstitutionByDomain(domain, client?)
      pgOwner.js                    ✅ assertPgOwnerVerified(userId, client?)
      spatial.js                    ✅ (proximity search moved inline to listing.service.js)
      compatibility.js              ✅ scoreListingsForUser — JOIN on (preference_key, value)
  cache/client.js                   ✅ Exponential backoff, MAX_RETRY_ATTEMPTS=10
  logger/index.js                   ✅ Pino — structured logging
  middleware/
    authenticate.js                 ✅ extractToken (cookie→header priority), attemptSilentRefresh (cookie-only), INACTIVE_STATUSES
    authorize.js                    ✅ Call-time role validation throws Error at route registration
    optionalAuthenticate.js         ✅ Tries to resolve user context if valid token exists; never blocks
    contactRevealGate.js            ✅ Two-tier quota enforcement: verified=unlimited, guest=10 email-only reveals
    errorHandler.js                 ✅ AppError + ZodError + PG constraint codes + JWT errors
    rateLimiter.js                  ✅ authLimiter (10/15min), otpLimiter (5/15min) — Redis-backed
    validate.js                     ✅ Writes result.data back to req
    upload.js                       ✅ Multer — MIME type + extension cross-check, 10MB limit
  services/
    auth.service.js                 ✅ register, login, logout (current + all), refresh, sendOtp, verifyOtp,
                                       googleOAuth, listSessions, revokeSession — all paths end at buildTokenResponse
                                       Per-session refresh tokens with CAS rotation; legacy token migration
    email.service.js                ✅ maskEmail guard, OTP format guard, transport at module level
    student.service.js              ✅ Dynamic SET clause, ownership check, getStudentContactReveal
    pgOwner.service.js              ✅ Same pattern as student, getPgOwnerContactReveal
    verification.service.js         ✅ submitDocument, getVerificationQueue (keyset), approveRequest, rejectRequest
    property.service.js             ✅ Full CRUD; location cascade to linked listings on update;
                                       soft-delete blocked if active listings exist; FOR UPDATE row lock on delete
    listing.service.js              ✅ Full CRUD + search (dynamic WHERE + LOWER(city) index + proximity +
                                       compatibility) + preferences + save/unsave;
                                       rent stored in paise, divided by 100 on read;
                                       occupancy tracking on accept; expirePendingRequests wired
    listingLifecycle.js             ✅ EXPIRED_LISTING_MESSAGE, UNAVAILABLE_LISTING_MESSAGE constants
    photo.service.js                ✅ enqueuePhotoUpload (202 pattern, server-side display_order, FOR UPDATE lock),
                                       getListingPhotos, deletePhoto, setCoverPhoto, reorderPhotos
    interest.service.js             ✅ createInterestRequest, transitionInterestRequest,
                                       _acceptInterestRequest (atomic: accept + connection + occupancy + fill/expire),
                                       getInterestRequest, getInterestRequestsForListing,
                                       getMyInterestRequests, expirePendingRequestsForListing
    connection.service.js           ✅ confirmConnection (single atomic UPDATE with CASE WHEN + FOR UPDATE pre-read),
                                       getConnection, getMyConnections
    notification.service.js         ✅ getFeed, getUnreadCount, markRead (bulk + selective)
    rating.service.js               ✅ submitRating (WHERE EXISTS gate + ON CONFLICT; self-rating prevention;
                                       property owner_id captured in CTE RETURNING),
                                       getRatingsForConnection (returns arrays), getPublicRatings,
                                       getMyGivenRatings, getPublicPropertyRatings
    report.service.js               ✅ submitReport (atomic INSERT...SELECT), getReportQueue (LEFT JOINs),
                                       resolveReport (handles soft-deleted rating edge case)
  controllers/                      ✅ All thin wrappers — no business logic
    auth.controller.js              ✅ register, login, logout, logoutAll, refresh, sendOtp, verifyOtp,
                                       me, listSessions, revokeSession, googleCallback
    student.controller.js           ✅ getProfile, updateProfile, revealContact
    pgOwner.controller.js           ✅ getProfile, updateProfile, revealContact
    verification.controller.js      ✅ submitDocument, getVerificationQueue, approveRequest, rejectRequest
    property.controller.js          ✅ createProperty, getProperty, listProperties, updateProperty, deleteProperty
    listing.controller.js           ✅ createListing, getListing, searchListings, updateListing, deleteListing,
                                       updateListingStatus, getListingPreferences, updateListingPreferences,
                                       saveListing, unsaveListing, getSavedListings
    photo.controller.js             ✅ uploadPhoto, getPhotos, deletePhoto, setCoverPhoto, reorderPhotos
    interest.controller.js          ✅ createInterestRequest, getInterestRequest, updateInterestStatus,
                                       getListingInterests, getMyInterestRequests
    connection.controller.js        ✅ confirmConnection, getConnection, getMyConnections
    notification.controller.js      ✅ getFeed, getUnreadCount, markRead
    rating.controller.js            ✅ submitRating, getRatingsForConnection, getPublicRatings,
                                       getMyGivenRatings, getPublicPropertyRatings
    report.controller.js            ✅ submitReport, getReportQueue, resolveReport
  routes/
    index.js                        ✅ Mounts all routers at /api/v1
    health.js                       ✅ GET /health — 3s timeout probes, sanitised error responses
    auth.js                         ✅ 10 auth endpoints including google/callback, sessions
    student.js                      ✅ GET + PUT /:userId/profile; GET /:userId/contact/reveal
    pgOwner.js                      ✅ GET + PUT /:userId/profile; GET /:userId/contact/reveal; POST /:userId/documents
    admin.js                        ✅ authenticate + authorize('admin') at router level;
                                       verification queue + report queue management
    property.js                     ✅ Full CRUD — pg_owner only for writes
    listing.js                      ✅ Full CRUD + status + preferences + save/unsave + photos + interest sub-routes
    interest.js                     ✅ /me + /:interestId + /:interestId/status
    connection.js                   ✅ /me + /:connectionId + /:connectionId/confirm
    notification.js                 ✅ / + /unread-count + /mark-read
    rating.js                       ✅ POST / + /me/given + /user/:userId + /property/:propertyId
                                       + /connection/:connectionId + /:ratingId/report
  validators/
    auth.validators.js              ✅ registerSchema, loginSchema, refreshSchema, logoutCurrentSchema,
                                       listSessionsSchema, revokeSessionSchema, otpVerifySchema, googleCallbackSchema
    student.validators.js           ✅ getStudentParamsSchema, updateStudentSchema
    pgOwner.validators.js           ✅ getPgOwnerParamsSchema, updatePgOwnerSchema
    verification.validators.js      ✅ submitDocumentSchema, getQueueSchema, approveRequestSchema, rejectRequestSchema
    property.validators.js          ✅ propertyParamsSchema, listPropertiesSchema, createPropertySchema, updatePropertySchema
    listing.validators.js           ✅ Full suite including searchListingsSchema (cross-field: rent range, cursor, proximity),
                                       createListingSchema, updateListingSchema, updateListingStatusSchema,
                                       updatePreferencesSchema, saveListingSchema, savedListingsSchema
    photo.validators.js             ✅ uploadPhotoSchema, deletePhotoSchema, reorderPhotosSchema, setCoverSchema
    interest.validators.js          ✅ createInterestSchema, interestParamsSchema, updateInterestStatusSchema,
                                       getListingInterestsSchema, getMyInterestsSchema
    connection.validators.js        ✅ connectionParamsSchema, getMyConnectionsSchema
    notification.validators.js      ✅ getFeedSchema (isRead coercion fixed), markReadSchema (all: z.literal(true))
    pagination.validators.js        ✅ buildKeysetPaginationQuerySchema, keysetPaginationQuerySchema
    rating.validators.js            ✅ submitRatingSchema, getRatingsForConnectionSchema, getPublicRatingsSchema,
                                       getMyGivenRatingsSchema, getPublicPropertyRatingsSchema
    report.validators.js            ✅ submitReportSchema, getReportQueueSchema, resolveReportSchema
  storage/
    index.js                        ✅ Selects adapter from config.STORAGE_ADAPTER at startup (reads Zod config, not process.env)
    adapters/
      localDisk.js                  ✅ Dev adapter — writes WebP to /uploads/listings/{listingId}/
      azureBlob.js                  ✅ Production — uploadData with 30s AbortController timeout;
                                       delete strips query-string before extracting blob path
  cron/
    listingExpiry.js                ✅ Daily 02:00 — expires active listings past expires_at + expires pending requests
    expiryWarning.js                ✅ Daily 01:00 — enqueues listing_expiring notifications for listings expiring in 7 days;
                                       idempotent (checks 24h notification dedup)
    hardDeleteCleanup.js            ✅ Weekly Sunday 04:00 — hard-deletes rows with deleted_at > 90 days;
                                       correct dependency-order deletion
  workers/
    queue.js                        ✅ Named singleton registry — prevents duplicate Redis connections
    notificationQueue.js            ✅ Shared enqueueNotification() helper — fire-and-forget, catches Redis errors
    mediaProcessor.js               ✅ Sharp resize→WebP, storage write, DB update, cover election, staging cleanup; concurrency 1
    notificationWorker.js           ✅ Notification INSERT with idempotency_key ON CONFLICT DO NOTHING; concurrency 10
```

---

## Phase 1 — Foundation & Identity ✅ COMPLETE

**Goal:** Register as student or PG owner, log in, receive OTP, server correctly identifies on every subsequent request. Institution auto-verification works. PG owner document upload creates a `verification_requests` row. Admin can view the verification queue and approve/reject.

### `phase1/foundation` ✅

Server, app, config, database pool, Redis client, logger, error handler, validate middleware, health route.

### `phase1/auth` ✅

Full auth pipeline: register (with institution domain lookup in same transaction), login (DUMMY_HASH timing equalisation), logout, refresh (account_status enforced), OTP send/verify (dual throttle: IP + per-user), `GET /auth/me`. Student and PG owner profile GET/PUT. `authenticate` and `authorize` middleware. Redis-backed rate limiters.

**Hardening baked in permanently:** `authorize` throws at route registration (not per-request), concurrent registration race guarded with inner try/catch on `23505`, OTP exhaustion returns 429 on the 5th wrong attempt, `crypto.randomInt` upper bound `1000000` (exclusive) gives full `100000–999999` range, `otpVerifySchema` uses digit-only regex.

### `phase1/institutions` ✅

`findInstitutionByDomain` queries with `deleted_at IS NULL` to hit the partial unique index. Registration transaction extended: domain match triggers institution_id link + `is_email_verified = TRUE` in the same `BEGIN/COMMIT`. `effectivelyVerified` tracks the post-UPDATE state — the RETURNING value from INSERT is always FALSE.

PG owner verification pipeline: `submitDocument` (ownership + profile check + INSERT into `verification_requests`), `getVerificationQueue` (keyset pagination, oldest-first anti-starvation), `approveRequest` / `rejectRequest` (both with `AND status = 'pending'` concurrency guard). Admin router has `authenticate + authorize('admin')` at router level.

### `phase1/auth-transport` ✅

`setAuthCookies` / `clearAuthCookies` in auth controller. `ACCESS_COOKIE_OPTIONS` / `REFRESH_COOKIE_OPTIONS` computed once at module scope. Silent refresh in `authenticate.js`: cookie-source expiry only — loads fresh roles and email from DB, signs new access token, CAS-rotates refresh token in Redis.

### `phase1/verification` ✅

`findUserByGoogleId` completed. `googleOAuth` service covers three paths: returning OAuth user, account linking (`AND google_id IS NULL` concurrency guard on UPDATE), new registration (same institution domain transaction, `password_hash = NULL`, `is_email_verified = TRUE`). Per-session refresh tokens introduced (`refreshToken:{userId}:{sid}`). `listSessions` and `revokeSession` added. `casRefreshToken` Lua script prevents concurrent rotation races.

**Full route surface after Phase 1:**

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
POST   /api/v1/auth/logout/current
POST   /api/v1/auth/logout/all
GET    /api/v1/auth/sessions
DELETE /api/v1/auth/sessions/:sid
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
POST   /api/v1/admin/verification-queue/:requestId/approve
POST   /api/v1/admin/verification-queue/:requestId/reject
```

---

## Phase 2 — Listings & Search ✅ COMPLETE

**Goal:** Verified PG owner can create a property and attach listings. Student can search by city, rent range, room type, amenities, and proximity. Photos upload and compress asynchronously. Compatibility scores appear on search results. Student can save listings.

### `phase2/amenities` ✅

Idempotent amenity seed (19 amenities across utility/safety/comfort categories, `ON CONFLICT DO NOTHING`). Property CRUD with `assertPgOwnerVerified` guard before any write. Amenity junction rows managed in same transaction as property INSERT. Soft-delete blocked if active listings exist (with `SELECT ... FOR UPDATE` row lock on property + all its listings to close the TOCTOU race).

**Location cascade:** When a property's city/address/coordinates change in `updateProperty`, the same values are propagated to all linked `pg_room` and `hostel_bed` listing rows in the same transaction, keeping proximity search consistent.

### `phase2/listings` ✅

**The paise rule** enforced: rent and deposit stored in paise, divided by 100 before returning to caller. `expires_at = NOW() + INTERVAL '60 days'` set server-side at creation.

Search: dynamic parameterised WHERE clause. City search uses `LOWER(l.city) LIKE LOWER($n)` against the `idx_listings_city_lower` functional index (fixes the ILIKE sequential scan issue). Proximity via `ST_DWithin` with geography cast inline in the query. Compatibility via `scoreListingsForUser` (JOIN on preference_key + preference_value). Score computed fresh per search, never stored.

`updateListingStatus` handles poster-initiated transitions: `active → filled`, `active → deactivated`, `deactivated → active`. Terminal state: `filled → *` not allowed. `expirePendingRequestsForListing` wired into the status-update path inside the same transaction.

### `phase2/media` ✅

`StorageService` interface with `LocalDiskAdapter` (dev) and `AzureBlobAdapter` (production, 30s upload timeout via AbortController, strips query-string before delete). `STORAGE_ADAPTER` env var selects adapter at startup from Zod-validated config. Upload returns `202 Accepted` with `{ photoId, status: 'processing' }`. BullMQ `media-processing` queue worker: Sharp resize → WebP quality 80 → strip EXIF → storage write → DB URL update → cover election (`NOT EXISTS` guard in single UPDATE) → staging cleanup. Concurrency 1 (CPU-bound). `display_order` allocated server-side with `SELECT MAX(...) FOR UPDATE` on parent listing row.

**Placeholder sentinel:** `photo_url = 'processing:{photoId}'` — never render URLs starting with `processing:`.

### `phase2/saved` ✅

`saveListing`: `ON CONFLICT DO UPDATE SET deleted_at = NULL, saved_at = NOW()` — idempotent re-save restores a previously soft-deleted row. `unsaveListing`: soft-delete via `SET deleted_at = NOW()`. `getSavedListings`: silently omits soft-deleted and expired listings, keyset paginated on `saved_at DESC`.

**Contact reveal:** `GET /students/:userId/contact/reveal` and `GET /pg-owners/:userId/contact/reveal` added. `optionalAuthenticate → validate → contactRevealGate → controller` chain. Gate enforces quota; controller delegates response shaping (`emailOnly` flag) to service. Both endpoints registered in student and pgOwner routes respectively.

**Full route surface after Phase 2:**

```
POST   /api/v1/properties
GET    /api/v1/properties
GET    /api/v1/properties/:propertyId
PUT    /api/v1/properties/:propertyId
DELETE /api/v1/properties/:propertyId
POST   /api/v1/listings
GET    /api/v1/listings
GET    /api/v1/listings/me/saved
GET    /api/v1/listings/:listingId
PUT    /api/v1/listings/:listingId
PATCH  /api/v1/listings/:listingId/status
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
GET    /api/v1/students/:userId/contact/reveal
GET    /api/v1/pg-owners/:userId/contact/reveal
```

---

## Phase 3 — Interaction Pipeline ✅ COMPLETE

**Goal:** Student can express interest. PG owner can accept or decline. On acceptance, connection created atomically and student receives WhatsApp deep-link. Both parties can confirm the real-world interaction. Notification feed keeps both parties informed. Once confirmed, either party can submit ratings.

### `phase3/interests` ✅

State machine: `pending → accepted | declined | withdrawn | expired`.

**The critical atomic block:** `accepted` transition runs `UPDATE interest_requests SET status = 'accepted'` + `INSERT INTO connections` + occupancy increment + conditional listing fill + `expirePendingRequestsForListing` all inside one `BEGIN/COMMIT` with `FOR UPDATE` locks on both the interest request row and the parent listing row.

**Occupancy model:** Multi-slot listings (`total_capacity > 1`) can accept multiple interest requests. Each acceptance increments `current_occupants`. When `current_occupants >= total_capacity`, listing transitions to `filled` and all remaining pending requests are expired. Single-slot listings behave the same way — capacity 1 means the first acceptance fills it.

`connection_type` derived from `listing.listing_type`: `student_room → student_roommate`, `pg_room → pg_stay`, `hostel_bed → hostel_stay`. WhatsApp deep-link (`https://wa.me/{phone}?text=...`) returned in the accepted response body. `null` if poster has no phone number — not an error.

Notifications fire post-commit: `new_interest_request` → poster, `interest_request_accepted` → sender, `interest_request_declined` → sender, `interest_request_withdrawn` → poster, `listing_filled` → poster when capacity exhausted.

### `phase3/connections` ✅

Two-sided confirmation via a single atomic UPDATE with `FOR UPDATE` pre-read to prevent race conditions. `rowCount === 0` → 404 (never 403). `connection_confirmed` notifications fire post-commit to both parties when `confirmed` is reached.

### `phase3/notifications` ✅

BullMQ worker with 5-attempt exponential backoff, concurrency 10. `idempotency_key` = BullMQ job ID, stored with `ON CONFLICT DO NOTHING`. `getUnreadCount` hits the partial index `WHERE is_read = FALSE`. `markRead` with `AND is_read = FALSE` guard makes all modes idempotent. `AND recipient_id = $1` on selective mark-read prevents cross-user manipulation. Message text stored at insert time from `NOTIFICATION_MESSAGES` map — not assembled at read time.

All services use the shared `enqueueNotification()` helper from `src/workers/notificationQueue.js` instead of creating their own Queue instances.

### `phase3/ratings` ✅

**Anti-fake-review guarantee:** `submitRating` uses a single `INSERT ... SELECT ... WHERE EXISTS` that atomically verifies: (1) connection exists and is not deleted, (2) `confirmation_status = 'confirmed'`, (3) reviewer is a party, (4) reviewer and reviewee are different parties (self-rating prevented). `ON CONFLICT (reviewer_id, connection_id, reviewee_id) DO NOTHING` handles duplicates.

`rowCount === 0` disambiguation: follow-up connection query determines 404 (not found) vs 422 (not confirmed) vs 409 (duplicate).

Property rating: WHERE EXISTS join traverses `connections → listings → properties`. Owner_id captured in CTE RETURNING clause — no second query needed for notification.

`getRatingsForConnection` returns `{ myRatings: Rating[], theirRatings: Rating[] }` as arrays (not single objects — multiple ratings per connection are possible).

Public rating endpoints require no auth.

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
GET    /api/v1/ratings/me/given
GET    /api/v1/ratings/user/:userId
GET    /api/v1/ratings/property/:propertyId
GET    /api/v1/ratings/connection/:connectionId
POST   /api/v1/ratings
```

---

## Phase 4 — Reputation Moderation ✅ COMPLETE

**Goal:** Parties to a connection can report ratings on that connection. Admin reviews the report queue with full context and resolves reports, optionally hiding the rating and triggering automatic aggregate recalculation.

### `phase4/moderation` ✅

**Files:** `src/validators/report.validators.js`, `src/services/report.service.js`, `src/controllers/report.controller.js`. Modifications to `src/routes/rating.js` (added `POST /:ratingId/report`) and `src/routes/admin.js` (added report queue + resolve routes).

`submitReport`: atomic `INSERT ... SELECT ... FROM ratings JOIN connections WHERE (reporter is a party)`. If sub-query returns nothing, INSERT produces zero rows → 404. Partial unique index `WHERE status = 'open'` prevents duplicate open reports; PostgreSQL raises 23505 → global handler converts to 409.

`getReportQueue`: LEFT JOINs (not INNER) on ratings, reporter user, reviewer user — ensures open reports remain visible even if related rows are soft-deleted. Oldest-first pagination (anti-starvation).

`resolveReport`: transaction updates both `rating_reports.status` and (for `resolved_removed`) `ratings.is_visible = FALSE`. The `update_rating_aggregates` DB trigger fires automatically — no application code needed for aggregate recalculation. Handles edge case where target rating is already soft-deleted: treats as success equivalent. `adminNotes` required when `resolution = 'resolved_removed'` (enforced at both Zod and service layers).

**Full route surface after Phase 4:**

```
POST   /api/v1/ratings/:ratingId/report
GET    /api/v1/admin/report-queue
PATCH  /api/v1/admin/reports/:reportId/resolve
```

---

## Phase 5 — Operations & Admin 🔄 PARTIAL

### `phase5/cron` ✅ MERGED

**Files:** `src/cron/listingExpiry.js`, `src/cron/expiryWarning.js`, `src/cron/hardDeleteCleanup.js`. All registered in `src/server.js` alongside BullMQ workers. node-cron tasks returned from register functions so `server.js` can call `task.stop()` during graceful shutdown.

| Job | Schedule | Action |
|-----|----------|--------|
| `listingExpiry` | Daily 02:00 | `UPDATE listings SET status='expired'` where `expires_at < NOW() AND status='active'`; bulk-expires pending requests in same transaction |
| `expiryWarning` | Daily 01:00 | Enqueues `listing_expiring` notifications for listings expiring within 7 days; idempotent via 24h notification dedup subquery |
| `hardDeleteCleanup` | Weekly Sunday 04:00 | Hard-deletes rows where `deleted_at < NOW() - INTERVAL '90 days'`; correct dependency-order deletion within one transaction |

Schedules overridable via env vars: `CRON_LISTING_EXPIRY`, `CRON_EXPIRY_WARNING`, `CRON_HARD_DELETE`. Retention period overridable via `SOFT_DELETE_RETENTION_DAYS`.

**`SOFT_DELETE_RETENTION_DAYS` format requirement:** must be a plain decimal integer with no prefix, suffix, or sign — e.g. `"90"`, not `"90days"`, `"-30"`, or `"1e2"`. Values that fail this check emit a `warn` log and fall back to the default of `90` days. The strict parse (`/^[0-9]+$/` before any numeric conversion) is intentional: `parseInt()` silently accepts a leading numeric portion and would use a completely different retention period than the operator intended without any warning.

### `phase5/admin` ⏳ NOT STARTED

Files to create: extensions to `src/routes/admin.js` and new service/controller files for user management, rating visibility management, email worker, and analytics.

**What needs building:**
- `email-queue` BullMQ worker (`startEmailWorker()`) — same factory pattern as notification worker, 5-attempt exponential backoff
- `GET /admin/users` — paginated list filterable by role + status
- `GET /admin/users/:userId` — full profile + roles + status detail
- `PATCH /admin/users/:userId/status` — suspend | ban | reactivate
- `GET /admin/ratings` — paginated, filterable by `is_visible`
- `PATCH /admin/ratings/:ratingId/visibility` — direct visibility toggle
- `GET /admin/analytics/platform` — DAU, new signups, active listings count, connections formed (computed fresh, no caching)

---

## Phase 6 — Real-Time ⏳ DEFERRED

**Entry condition:** Phase 3 polling confirmed working in production with real users.

Files to create: `src/ws/server.js`, `src/ws/connectionMap.js`, `src/ws/pubsub.js`. WebSocket attached to same HTTP server instance. Auth via JWT from `?token=` query param on WS handshake. Redis pub/sub channel `notifications:{userId}` for cross-instance fanout — required for Azure App Service multi-instance deployments.

---

## DB Trigger Reference

| Trigger | Table | Fires on | Action |
|---------|-------|----------|--------|
| `update_rating_aggregates` | `ratings` | INSERT, or UPDATE of `overall_score`, `is_visible`, `deleted_at` | Recalculates `average_rating` + `rating_count` on `users` or `properties` for the affected `reviewee_id` |
| `set_updated_at` | All tables with `updated_at` | BEFORE UPDATE | Sets `NEW.updated_at = NOW()` |
| `sync_location_geometry` | `properties`, `listings` | BEFORE INSERT OR UPDATE OF `latitude`, `longitude` | Computes PostGIS `GEOMETRY(POINT, 4326)` from lat/lng decimals |

Application code never manually updates `average_rating`, `rating_count`, `location`, or `updated_at`.

---

## Future Upgrade Notes

**View counting on listings:** Current `getListing` increments `views_count` with a detached fire-and-forget `pool.query` — failures are logged and suppressed. This is correct for reliability but is a direct DB write per view. When traffic grows, replace with a Redis buffer → batch flush to Postgres pattern. If `views_count` later affects ranking or monetisation, define approximate vs strongly consistent requirement before redesigning. Entry point: `src/services/listing.service.js` → `getListing`.
