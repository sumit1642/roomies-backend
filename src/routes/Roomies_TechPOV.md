Roomies_TechPOV

# Roomies — Implementation Plan

**Stack:** Node.js + Express (ES modules) · PostgreSQL 16 + PostGIS · Redis + BullMQ · Zod v4 · Pino · Azure target

---

## Global Conventions

| Concern               | Decision                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env vars              | Zod-validated at startup via `src/config/env.js`. Never read `process.env` directly.                                                                                                                                                         |
| Env files             | `.env.local` (dev), `.env.azure` (Azure check). Controlled by `ENV_FILE` var.                                                                                                                                                                |
| Validation middleware | `validate(schema)` — writes `result.data` back to `req.body/query/params`. Schema shape: `z.object({ body?, query?, params? })`.                                                                                                             |
| Error handling        | Throw `new AppError(message, statusCode)` for known errors. Pass unknown to `next(err)`. Global handler covers `AppError`, `ZodError`, PG constraint codes `23505/23503/23514`, JWT errors.                                                  |
| Zod v4 API            | `z.uuid()`, `z.email()`, `z.url()`. Error param is `{ error: '...' }` not `{ message: '...' }`. Issue list is `error.issues` not `error.errors`.                                                                                             |
| DB queries            | `pool` from `src/db/client.js`. Transactions: `pool.connect()` → manual `BEGIN/COMMIT/ROLLBACK` → `client.release()` in `finally`. Reusable queries in `src/db/utils/`.                                                                      |
| Auth transport        | Every auth response: set `accessToken` + `refreshToken` as HttpOnly cookies AND include both in JSON body. Cookie options: `httpOnly: true`, `secure: NODE_ENV==='production'`, `sameSite: 'strict'`, `maxAge: parseTtlSeconds(...) * 1000`. |
| Silent refresh        | Only attempted when expired token came from `req.cookies.accessToken`. Expired Bearer header → immediate 401.                                                                                                                                |
| Notifications         | Always post-commit, never inside a transaction. Fire-and-forget enqueue to `notification-queue`. A notification failure never rolls back a state transition.                                                                                 |
| Pagination            | Keyset cursor. Fetch `limit + 1` rows to detect next page. Cursor fields must both be present or both absent (validated at Zod layer).                                                                                                       |
| Logging               | `logger` from `src/logger/index.js`. Structured: `logger.info({ userId }, 'message')`.                                                                                                                                                       |
| File path comment     | Every file starts with `// src/path/to/file.js`.                                                                                                                                                                                             |

---

## Branch Status

```
main
 └── Phase1
      ├── phase1/foundation       ✅ MERGED
      ├── phase1/auth             ✅ MERGED
      ├── phase1/institutions     ✅ MERGED
      ├── phase1/auth-transport   ✅ MERGED
      └── phase1/verification     ✅
 └── Phase2                       ✅
 └── Phase3
      ├── phase3/interests        ✅ MERGED
      ├── phase3/connections      ✅ MERGED
      ├── phase3/notifications    ✅ MERGED
      └── phase3/ratings          ✅ MERGED
 └── Phase4                       ← Not started
 └── Phase5                       ← Not started
```

---

## Phase 1 — Foundation & Identity ✅

### `phase1/foundation` ✅

**Files created:**

```
src/server.js · src/app.js · src/config/env.js
src/db/client.js · src/cache/client.js · src/logger/index.js
src/middleware/errorHandler.js · src/middleware/validate.js
src/routes/index.js · src/routes/health.js
```

**`GET /api/v1/health`**

- Probes both PostgreSQL and Redis with `Promise.race` against a 3s timeout (`clearTimeout` in `.finally()`)
- Returns `200 { status: 'ok', services: { db: 'ok', redis: 'ok' } }` or `503 { status: 'degraded', ... }`

---

### `phase1/auth` ✅

**Files created:**

```
src/db/utils/auth.js
src/middleware/authenticate.js · src/middleware/authorize.js · src/middleware/rateLimiter.js
src/validators/auth.validators.js · src/validators/student.validators.js · src/validators/pgOwner.validators.js
src/services/auth.service.js · src/services/email.service.js
src/services/student.service.js · src/services/pgOwner.service.js
src/controllers/auth.controller.js · src/controllers/student.controller.js · src/controllers/pgOwner.controller.js
src/routes/auth.js · src/routes/student.js · src/routes/pgOwner.js
```

**`src/db/utils/auth.js`**

- `findUserById(userId, client?)` — correlated subquery with `ARRAY_AGG` for roles. Returns full user row + roles array
  or `null`.
- `findUserByEmail(email, client?)` — returns full user row or `null`.
- `findUserByGoogleId(googleId, client?)` — stub (completed in `phase1/verification`).

**`src/services/auth.service.js`**

- `parseTtlSeconds(ttlString)` — exported. Single source of truth for TTL arithmetic used by cookie `maxAge` and Redis
  TTL.
- `DUMMY_HASH` — hardcoded bcrypt of `"dummy"` at 10 rounds:
  `$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi`. Never replace with runtime `bcrypt.hash()`.
- `register(data)` — transaction: INSERT `users` → INSERT profile → institution domain lookup → conditional
  `UPDATE student_profiles SET institution_id` + `UPDATE users SET is_email_verified = TRUE`. Throws `409` on duplicate
  email (`23505`).
- `login({ email, password })` — always runs `bcrypt.compare` against `DUMMY_HASH` for unknown emails (timing
  equalisation). Throws `401` for bad credentials, `403` for inactive account.
- `logout(userId, refreshToken)` — deletes refresh token from Redis.
- `refresh(refreshToken)` — validates JWT + Redis presence → loads fresh user from DB (never trusts stale payload) →
  signs new access token. Throws `401` on any failure.
- `sendOtp(userId)` — `crypto.randomInt(100000, 1000000)`, stores at `otp:{userId}` and `otpAttempts:{userId}` in Redis.
  Calls `email.service.sendOtpEmail`.
- `verifyOtp(userId, otp)` — checks attempt counter (max 5, returns `429` on exhaustion), compares OTP, deletes from
  Redis on success, updates `is_email_verified = TRUE`.

**`src/middleware/authenticate.js`**

- `extractToken(req)` → `{ token, source: 'cookie' | 'header' } | null`. Cookie takes priority.
- `attemptSilentRefresh(req, res)` → `userId | null`. Only called when `source === 'cookie'` and token is expired. Loads
  fresh roles from DB. Sets new `accessToken` cookie.
- `INACTIVE_STATUSES` — module-scope constant, not per-request allocation.

**`src/middleware/authorize.js`**

- `authorize(...roles)` — validates roles array at call time (throws `Error` at route registration, not per-request
  `403`).

**`src/middleware/rateLimiter.js`**

- `authLimiter` — 10 req / 15 min
- `otpLimiter` — 5 req / 15 min

**Route surface:**

```
POST   /api/v1/auth/register          authLimiter
POST   /api/v1/auth/login             authLimiter
POST   /api/v1/auth/logout            authenticate
POST   /api/v1/auth/refresh
POST   /api/v1/auth/otp/send          authenticate + otpLimiter
POST   /api/v1/auth/otp/verify        authenticate          ← no otpLimiter (service-layer counter is the throttle)
GET    /api/v1/auth/me                authenticate

GET    /api/v1/students/:userId/profile     authenticate     ← world-readable by any authed user
PUT    /api/v1/students/:userId/profile     authenticate     ← ownership enforced in service

GET    /api/v1/pg-owners/:userId/profile    authenticate
PUT    /api/v1/pg-owners/:userId/profile    authenticate
```

---

### `phase1/institutions` ✅

**Files created / modified:**

```
src/db/utils/institutions.js          (new)
src/services/verification.service.js  (new)
src/controllers/verification.controller.js (new)
src/validators/verification.validators.js  (new)
src/routes/admin.js                   (new)
src/services/auth.service.js          (modified — registration transaction extended)
src/routes/pgOwner.js                 (modified — document submission route added)
src/routes/index.js                   (modified — admin router mounted)
```

**`src/db/utils/institutions.js`**

- `findInstitutionByDomain(domain, client?)` — queries `WHERE deleted_at IS NULL` to match partial unique index
  predicate. Domain extraction is caller's responsibility.

**`src/services/verification.service.js`**

- `submitDocument(userId, data)` — ownership check + profile existence check + INSERT `verification_requests`. Throws
  `403` if caller is not `pg_owner`. Throws `404` if profile missing. Throws `409` on duplicate (`23505`).
- `getVerificationQueue(filters)` — keyset pagination on `(submitted_at ASC, request_id ASC)` (oldest-first,
  anti-starvation). Returns `{ items, nextCursor }`. Each item includes `user_id`.
- `approveRequest(requestId, adminId)` — transaction:
  `UPDATE verification_requests SET status='approved' WHERE request_id=$1 AND status='pending'` +
  `UPDATE pg_owner_profiles SET verification_status='verified'`. Throws `409` if `rowCount === 0` on either.
- `rejectRequest(requestId, adminId, reason)` — same transaction pattern, writes `rejection_reason` to profile.

**`src/routes/admin.js`** — `authenticate + authorize('admin')` applied at router level. Structurally impossible to add
unprotected routes here.

**Route surface:**

```
POST   /api/v1/pg-owners/:userId/verification-documents   authenticate
GET    /api/v1/admin/verification-queue                   authenticate + authorize('admin')
PATCH  /api/v1/admin/verification-requests/:id/approve   authenticate + authorize('admin')
PATCH  /api/v1/admin/verification-requests/:id/reject    authenticate + authorize('admin')
```

---

### `phase1/auth-transport` ✅

**Files modified:** `src/services/auth.service.js` · `src/controllers/auth.controller.js` ·
`src/middleware/authenticate.js`

**`src/controllers/auth.controller.js`**

- `ACCESS_COOKIE_OPTIONS` / `REFRESH_COOKIE_OPTIONS` — module-level constants computed once at startup from
  `parseTtlSeconds`.
- `setAuthCookies(res, accessToken, refreshToken)` — called in `register` and `login` before `res.json()`.
- `clearAuthCookies(res)` — called in `logout`. Uses same options object as set (required for browser cookie deletion).
- JSON body remains fully intact — both clients receive tokens.

---

### `phase1/verification` ← NEXT

**Files to change:**

| File                                   | Change                                                                                                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/utils/auth.js`                 | Complete `findUserByGoogleId(googleId, client?)`                                                                                                                                                                                               |
| `src/services/auth.service.js`         | Add `googleOAuth({ googleIdToken })` — branches on existing/new `google_id`. New users run same institution domain transaction. `password_hash = NULL`, `is_email_verified = TRUE`. Both paths end at `buildTokenResponse` + `setAuthCookies`. |
| `src/controllers/auth.controller.js`   | Add `googleCallback` — thin wrapper                                                                                                                                                                                                            |
| `src/routes/auth.js`                   | Add `POST /google/callback`                                                                                                                                                                                                                    |
| `src/validators/auth.validators.js`    | Add `googleCallbackSchema`. Update `refreshSchema`: `refreshToken` optional in body (browser sends no body; service reads `req.body.refreshToken ?? req.cookies?.refreshToken`).                                                               |
| `src/services/verification.service.js` | Harden `submitDocument`: verify caller holds `pg_owner` role (currently only checks profile existence). Confirm `getVerificationQueue` returns `user_id` per item.                                                                             |

---

## Phase 2 — Listings & Search

**Entry condition:** Phase 1 fully merged. Verified PG owner + verified student exist in DB.

**Branch structure:**

```
Phase2
 ├── phase2/amenities    ← seed data + property CRUD
 ├── phase2/listings     ← listing CRUD + search + compatibility
 ├── phase2/media        ← photo upload + Sharp compression via BullMQ
 └── phase2/saved        ← saved listings
```

### `phase2/amenities`

**Files:**

```
src/db/seeds/amenities.js     (new — idempotent, ON CONFLICT DO NOTHING)
src/validators/property.validators.js  (new)
src/services/property.service.js       (new)
src/controllers/property.controller.js (new)
src/routes/property.js                 (new)
src/routes/index.js                    (modified)
```

**`src/services/property.service.js`**

- `createProperty(ownerId, data)` — service-layer guard: caller must have `verification_status = 'verified'` (not
  enforced by DB FK). Amenity junction rows managed in same transaction as property INSERT.
- `updateProperty(ownerId, propertyId, data)` — ownership check. Partial update via dynamic SET clause.
- `deleteProperty(ownerId, propertyId)` — soft-delete. Throws `409` if active listings exist.
- `getProperty(propertyId)` — public read.

**Route surface:**

```
POST   /api/v1/properties                    authenticate + authorize('pg_owner')
GET    /api/v1/properties/:propertyId
PUT    /api/v1/properties/:propertyId        authenticate + authorize('pg_owner')
DELETE /api/v1/properties/:propertyId        authenticate + authorize('pg_owner')
```

---

### `phase2/listings`

**Files:**

```
src/db/utils/spatial.js        (new — findListingsNearPoint)
src/db/utils/compatibility.js  (new — scoreListingsForUser)
src/validators/listing.validators.js  (new)
src/services/listing.service.js       (new)
src/controllers/listing.controller.js (new)
src/routes/listing.js                 (new)
src/routes/index.js                   (modified)
```

**`src/db/utils/spatial.js`**

- `findListingsNearPoint(lat, lng, radiusMeters, filters)` — `ST_DWithin` with geography cast (meters, handles
  curvature). Returns listing IDs ordered by distance.

**`src/db/utils/compatibility.js`**

- `scoreListingsForUser(userId, listingIds)` — JOIN on `(preference_key, preference_value)`. Returns
  `Map<listingId, score>`. Score never stored, always computed fresh.

**`src/services/listing.service.js`**

- `createListing(ownerId, data)` — `expires_at = NOW() + INTERVAL '60 days'` set server-side, never from request body.
- `searchListings(filters)` — dynamic parameterised WHERE clause (city, rent range, room type, gender, `available_from`,
  listing type, amenity filter) + optional proximity via `findListingsNearPoint` + optional compatibility via
  `scoreListingsForUser`. Rent stored in paise, divided by 100 before returning.
- `updateListingStatus(ownerId, listingId, status)` — wires `expirePendingRequestsForListing(listingId, client)` inside
  same transaction when status transitions away from `active`.
- `deleteListing(ownerId, listingId)` — soft-delete.

**Route surface:**

```
POST   /api/v1/listings                    authenticate + authorize('pg_owner')
GET    /api/v1/listings                    (search — public)
GET    /api/v1/listings/:listingId
PUT    /api/v1/listings/:listingId         authenticate + authorize('pg_owner')
PATCH  /api/v1/listings/:listingId/status  authenticate + authorize('pg_owner')
DELETE /api/v1/listings/:listingId         authenticate + authorize('pg_owner')
```

---

### `phase2/media`

**Files:**

```
src/storage/StorageService.js       (new — interface)
src/storage/LocalDiskAdapter.js     (new — dev)
src/storage/AzureBlobAdapter.js     (new — stub, throws 501)
src/workers/mediaWorker.js          (new — startMediaWorker())
src/validators/media.validators.js  (new)
src/services/media.service.js       (new)
src/controllers/media.controller.js (new)
src/routes/media.js                 (new)
src/server.js                       (modified — start/stop worker)
```

**`STORAGE_ADAPTER`** env var controls `LocalDiskAdapter` vs `AzureBlobAdapter`.

**Upload flow:** `POST /listings/:listingId/photos` returns `202 Accepted` immediately. BullMQ `media-processing-queue`
worker runs Sharp: resize to 1200px max, WebP, quality 80. First photo auto-set as cover if none exists.

**Route surface:**

```
POST   /api/v1/listings/:listingId/photos        authenticate + authorize('pg_owner')
DELETE /api/v1/listings/:listingId/photos/:photoId  authenticate + authorize('pg_owner')
PATCH  /api/v1/listings/:listingId/photos/:photoId/cover  authenticate + authorize('pg_owner')
```

---

### `phase2/saved`

**Files:**

```
src/validators/saved.validators.js  (new)
src/services/saved.service.js       (new)
src/controllers/saved.controller.js (new)
src/routes/saved.js                 (new — or merged into listing.js)
```

**`src/services/saved.service.js`**

- `saveListing(userId, listingId)` — `ON CONFLICT DO NOTHING` (idempotent).
- `unsaveListing(userId, listingId)` — DELETE. Idempotent.
- `getSavedListings(userId, filters)` — keyset paginated. Silently omits soft-deleted and expired listings
  (`deleted_at IS NULL AND expires_at > NOW()`).

**Route surface:**

```
POST   /api/v1/listings/:listingId/save     authenticate
DELETE /api/v1/listings/:listingId/save     authenticate
GET    /api/v1/users/me/saved-listings      authenticate
```

---

## Phase 3 — Interaction Pipeline ✅

### `phase3/interests` ✅

**Files created / modified:**

```
src/validators/interest.validators.js  (new)
src/services/interest.service.js       (new — had partial stub from Phase 2)
src/controllers/interest.controller.js (new)
src/routes/interest.js                 (new)
src/routes/listing.js                  (modified — added POST/GET /:listingId/interests)
src/routes/index.js                    (modified)
src/services/listing.service.js        (modified — expirePendingRequestsForListing wired in)
```

**State machine:** `pending → accepted | declined | withdrawn | expired`

**`src/services/interest.service.js`**

- `createInterestRequest(senderId, listingId)` — throws `409` on duplicate pending request (unique constraint on
  `(sender_id, listing_id)` where `status='pending'`). Throws `403` if sender owns the listing. Post-commit: enqueue
  `new_interest_request` notification to poster.
- `updateInterestStatus(callerId, interestId, newStatus)`:
    - Resolves actor role by comparing `callerId` to `sender_id` and `listing.posted_by`.
    - Throws `404` if no match (never `403`).
    - Throws `422` if transition violates state machine.
    - `accepted` path: transaction —
      `UPDATE interest_requests SET status='accepted' WHERE interest_id=$1 AND status='pending'` +
      `INSERT INTO connections (initiator_id, counterpart_id, listing_id, interest_request_id, connection_type)`. Both
      or neither. `connection_type` derived from `listing.listing_type`: `student_room→student_roommate`,
      `pg_room→pg_stay`, `hostel_bed→hostel_stay`.
    - Returns `{ status, connectionId?, whatsappLink? }` on `accepted`. `whatsappLink = https://wa.me/91${phone}` from
      poster's profile. `null` if no phone on file.
    - Post-commit enqueues: `interest_request_accepted` | `interest_request_declined` | `interest_request_withdrawn`
      notification.
- `getInterestRequestsForListing(callerId, listingId, filters)` — poster-only read. Keyset paginated.
- `getMyInterestRequests(senderId, filters)` — student's own sent requests. Keyset paginated.
- `expirePendingRequestsForListing(listingId, client)` — bulk UPDATE inside caller's transaction. Called from
  `listing.service.updateListingStatus` when transitioning away from `active`.

**Connections row at birth:**

```
initiator_id          = sender_id (student)
counterpart_id        = listing.posted_by (poster)
listing_id            = from interest request
interest_request_id   = interest request that triggered it
connection_type       = derived from listing_type
initiator_confirmed   = FALSE
counterpart_confirmed = FALSE
confirmation_status   = 'pending'
status                = 'active'
```

**Notification types fired (post-commit enqueue):**

- `new_interest_request` → recipient: poster
- `interest_request_accepted` → recipient: sender
- `interest_request_declined` → recipient: sender
- `interest_request_withdrawn` → recipient: poster

**Route surface:**

```
POST   /api/v1/listings/:listingId/interests   authenticate
GET    /api/v1/listings/:listingId/interests   authenticate + authorize('pg_owner')
GET    /api/v1/interests/me                    authenticate
PATCH  /api/v1/interests/:interestId/status    authenticate
```

---

### `phase3/connections` ✅

**Files created / modified:**

```
src/validators/connection.validators.js  (new)
src/services/connection.service.js       (new)
src/controllers/connection.controller.js (new)
src/routes/connection.js                 (new)
src/routes/index.js                      (modified)
```

**`src/services/connection.service.js`**

- `confirmConnection(callerId, connectionId)` — single atomic UPDATE:

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

    `rowCount === 0` → throws `404`. Post-commit: if `confirmation_status` just became `'confirmed'`, enqueues
    `connection_confirmed` notification to both parties (two separate enqueue calls).

- `getMyConnections(callerId, filters)` — `WHERE initiator_id = $1 OR counterpart_id = $1`. Supports
  `confirmation_status` filter. Keyset pagination on `(created_at DESC, connection_id ASC)`. Each row includes other
  party's public profile (name, photo, `average_rating`) + listing summary.

- `getConnection(callerId, connectionId)` — `WHERE connection_id = $1 AND (initiator_id = $2 OR counterpart_id = $2)`.
  Throws `404` for non-parties (never `403`). Returns full detail including both confirmation flags.

**Notification types fired:**

- `connection_confirmed` → both `initiator_id` and `counterpart_id`

**Route surface:**

```
POST   /api/v1/connections/:connectionId/confirm   authenticate
GET    /api/v1/connections/me                      authenticate
GET    /api/v1/connections/:connectionId           authenticate
```

---

### `phase3/notifications` ✅

**Files created / modified:**

```
src/workers/notificationWorker.js      (new)
src/validators/notification.validators.js  (new)
src/services/notification.service.js       (new)
src/controllers/notification.controller.js (new)
src/routes/notification.js                 (new)
src/routes/index.js                        (modified)
src/services/interest.service.js           (modified — inline pool.query → enqueue)
src/services/connection.service.js         (modified — inline pool.query → enqueue)
src/server.js                              (modified — start/stop worker)
```

**`src/workers/notificationWorker.js`**

- Exports `startNotificationWorker()` and `NOTIFICATION_QUEUE_NAME`.
- Concurrency: `10`.
- Job name: `'send-notification'`.
- Job payload: `{ recipientId, type, entityType, entityId }`.
- Worker body:
  `INSERT INTO notifications (recipient_id, type, entity_type, entity_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`.
- Retry policy: `{ attempts: 5, backoff: { type: 'exponential', delay: 1000 } }`.

**`src/services/notification.service.js`**

- `getNotifications(userId, filters)` — keyset pagination on `(created_at DESC, notification_id ASC)`. Assembles
  human-readable `message` from type→template map at read time (never stored in DB). Returns `{ items, nextCursor }`.
- `getUnreadCount(userId)` → `{ count: N }`. Query:
  `SELECT COUNT(*) WHERE recipient_id=$1 AND is_read=FALSE AND deleted_at IS NULL`. Hits partial index
  `WHERE is_read=FALSE`.
- `markRead(userId, { notificationIds?, all? })`:
    - Specific IDs: `UPDATE ... WHERE recipient_id=$1 AND notification_id=ANY($2::uuid[]) AND is_read=FALSE`
    - All: `UPDATE ... WHERE recipient_id=$1 AND is_read=FALSE`
    - `AND is_read=FALSE` guard makes both idempotent.

**Route surface:**

```
GET    /api/v1/notifications               authenticate
GET    /api/v1/notifications/unread-count  authenticate
POST   /api/v1/notifications/mark-read     authenticate
```

---

### `phase3/ratings` ✅

**Files created / modified:**

```
src/validators/rating.validators.js  (new)
src/services/rating.service.js       (new)
src/controllers/rating.controller.js (new)
src/routes/rating.js                 (new)
src/routes/index.js                  (modified)
```

**Validators — `src/validators/rating.validators.js`**

Shared `paginationQuerySchema` (keyset: `cursorTime` + `cursorId` both-or-neither, `limit` 1–100 default 20) composed
into all read schemas.

| Export                           | Validates                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitRatingSchema`             | `body.connectionId` (uuid), `body.revieweeType` (`'user'\|'property'`), `body.revieweeId` (uuid), `body.overallScore` (int 1–5), optional dimension scores (int 1–5 each), optional `body.comment` (string max 2000) |
| `getRatingsForConnectionSchema`  | `params.connectionId` (uuid)                                                                                                                                                                                         |
| `getPublicRatingsSchema`         | `params.userId` (uuid) + pagination query                                                                                                                                                                            |
| `getMyGivenRatingsSchema`        | pagination query only                                                                                                                                                                                                |
| `getPublicPropertyRatingsSchema` | `params.propertyId` (uuid) + pagination query                                                                                                                                                                        |

**`src/services/rating.service.js`**

Queue singleton at module scope — `new Queue(NOTIFICATION_QUEUE_NAME, { connection: { host, port, password, tls } })`
parsed from `config.REDIS_URL`.

`submitRating(reviewerId, data)` → `{ ratingId, createdAt }`

- Step 1: reviewee existence pre-check — `SELECT 1 FROM users` or `properties WHERE ... AND deleted_at IS NULL`. Throws
  `404` if missing.
- Step 2: atomic
  `INSERT ... SELECT ... WHERE EXISTS ... ON CONFLICT (reviewer_id, connection_id, reviewee_id) DO NOTHING RETURNING rating_id, created_at`.
    - User path EXISTS:
      `connections WHERE connection_id=$2 AND confirmation_status='confirmed' AND deleted_at IS NULL AND (initiator_id=$1 OR counterpart_id=$1) AND (initiator_id=$4 OR counterpart_id=$4) AND initiator_id != counterpart_id`
    - Property path EXISTS: joins `connections → listings → properties`, verifies `p.property_id = $4` (prevents rating
      arbitrary properties via unrelated connection)
- Step 3: `rowCount === 0` disambiguation — follow-up connection query: `404` (not found/not a party) | `422` (not
  confirmed) | `409` (duplicate — ON CONFLICT fired)
- Step 4: post-commit notification enqueue — user: `rating_received` to `revieweeId`. Property: async owner lookup →
  `rating_received` to `owner_id`. Both fire-and-forget with `.catch()` logging.

`getRatingsForConnection(callerId, connectionId)` → `{ myRating: Rating|null, theirRating: Rating|null }`

- Fetches `initiator_id, counterpart_id` — throws `404` if caller is not a party.
- Single query fetches both ratings via `reviewer_id = ANY($2::uuid[])`.
- Filters `is_visible = TRUE AND deleted_at IS NULL`.
- Resolves `myRating` / `theirRating` by comparing `reviewer_id` to `callerId`.

`getPublicRatings(userId, filters)` → `{ items, nextCursor }`

- No auth. Filters: `reviewee_type = 'user'`, `is_visible = TRUE`, `deleted_at IS NULL`.
- JOINs `users` + LEFT JOIN `student_profiles` for `COALESCE(sp.full_name, u.email)` as `reviewer_name`.
- Keyset on `(created_at DESC, rating_id ASC)`.
- Item shape:
  `{ ratingId, overallScore, cleanliness/communication/reliability/valueScore, comment, createdAt, reviewer: { fullName, profilePhotoUrl } }`

`getMyGivenRatings(reviewerId, filters)` → `{ items, nextCursor }`

- Filters: `reviewer_id = $1`, `deleted_at IS NULL` (no `is_visible` filter — reviewer sees their own hidden ratings).
- Polymorphic reviewee name:
  `CASE WHEN reviewee_type='user' THEN COALESCE(sp_rev.full_name, pop_rev.owner_full_name, u_rev.email) ELSE p_rev.property_name END`.
- Four LEFT JOINs: `users u_rev`, `student_profiles sp_rev`, `pg_owner_profiles pop_rev`, `properties p_rev`.
- Item shape adds `isVisible` + `reviewee: { fullName, profilePhotoUrl, type }`.

`getPublicPropertyRatings(propertyId, filters)` → `{ items, nextCursor }`

- Pre-check: `SELECT 1 FROM properties WHERE property_id=$1 AND deleted_at IS NULL` → `404` if missing (distinguishes
  "no ratings" from "wrong ID").
- Filters: `reviewee_type = 'property'`, `is_visible = TRUE`, `deleted_at IS NULL`.
- Same JOIN pattern as `getPublicRatings`.
- Item shape identical to `getPublicRatings`.

**`src/routes/rating.js`** — route registration order (static before parameterised):

```
GET    /api/v1/ratings/me/given                  authenticate
GET    /api/v1/ratings/user/:userId              (public — no auth)
GET    /api/v1/ratings/property/:propertyId      (public — no auth)
GET    /api/v1/ratings/connection/:connectionId  authenticate
POST   /api/v1/ratings                           authenticate
```

**Known issue in existing codebase:** `src/routes/notification.js` imports `authenticate` from `../middleware/auth.js`
(wrong path). Should be `../middleware/authenticate.js`. Causes startup crash when notification router loads — fix
before merging `phase3/ratings`.

---

## Phase 4 — Reputation Moderation

**Entry condition:** `phase3/ratings` merged. Confirmed connections exist in DB.

**Branch:** `phase4/moderation`

**What gets built:**

```
src/validators/report.validators.js    (new)
src/services/report.service.js         (new)
src/controllers/report.controller.js   (new)
src/routes/report.js                   (new)
src/routes/index.js                    (modified)
src/routes/admin.js                    (modified — moderation endpoints)
```

**`src/services/report.service.js`**

- `submitReport(reporterId, ratingId, data)` — INSERT into `rating_reports`. Partial unique index prevents duplicate
  open reports from same reporter on same rating. Throws `409` on duplicate.
- `getReportQueue(filters)` — admin only. Keyset paginated. Returns reports with associated rating and reviewer details.
- `resolveReport(adminId, reportId, resolution)`:
    - `resolution = 'resolved_removed'` → transaction: `UPDATE rating_reports SET status='resolved_removed'` +
      `UPDATE ratings SET is_visible=FALSE`. DB trigger `update_rating_aggregates` fires automatically to recalculate
      `average_rating`. No app code needed for aggregate update.
    - `resolution = 'resolved_kept'` → `UPDATE rating_reports SET status='resolved_kept'` only.
    - Throws `409` if report not in `'open'` status.

**Route surface:**

```
POST   /api/v1/ratings/:ratingId/report              authenticate
GET    /api/v1/admin/report-queue                    authenticate + authorize('admin')
PATCH  /api/v1/admin/reports/:reportId/resolve       authenticate + authorize('admin')
```

---

## Phase 5 — Operations & Admin

**Entry condition:** Phase 4 merged.

**Branch structure:**

```
Phase5
 ├── phase5/cron     ← scheduled maintenance tasks
 └── phase5/admin    ← full admin control panel
```

### `phase5/cron`

**Files:**

```
src/cron/listingExpiry.js      (new)
src/cron/connectionExpiry.js   (new)
src/cron/expiryWarning.js      (new)
src/cron/hardDeleteCleanup.js  (new)
src/server.js                  (modified — register cron jobs)
```

**Schedule (all via `node-cron`):**

| Job                 | Schedule            | Action                                                                              |
| ------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `listingExpiry`     | daily 02:00         | `UPDATE listings SET status='expired' WHERE expires_at < NOW() AND status='active'` |
| `connectionExpiry`  | daily 03:00         | `UPDATE connections SET status='expired' WHERE ...`                                 |
| `expiryWarning`     | daily 01:00         | Enqueue `email-queue` jobs for listings expiring in 7 days                          |
| `hardDeleteCleanup` | weekly Sunday 04:00 | Permanently DELETE rows where `deleted_at < NOW() - INTERVAL '90 days'`             |

**`email-queue` BullMQ worker** — `startEmailWorker()` — wired in `server.js`. Handles email delivery with retry. Same
pattern as notification worker.

### `phase5/admin`

Full admin router additions to `src/routes/admin.js`:

**User management:**

```
GET    /api/v1/admin/users                     paginated list with filters
GET    /api/v1/admin/users/:userId
PATCH  /api/v1/admin/users/:userId/status      suspend | ban | reactivate
```

**Rating moderation (beyond Phase 4 report resolution):**

```
GET    /api/v1/admin/ratings                   paginated, filterable by is_visible
PATCH  /api/v1/admin/ratings/:ratingId/visibility
```

**Analytics:**

```
GET    /api/v1/admin/analytics/platform        DAU, new signups, active listings, connections formed
```

---

## Phase 6 — Real-Time (Deferred)

**Entry condition:** Phase 3 polling confirmed working. Real users exist.

**What gets built:**

```
src/ws/server.js          (new — WebSocket server on same HTTP server instance)
src/ws/authenticate.js    (new — JWT from ?token= query param on handshake)
src/ws/connectionMap.js   (new — Map<userId, WebSocket> for per-instance connections)
src/ws/pubsub.js          (new — Redis pub/sub for cross-instance broadcast)
```

**Auth:** JWT from `?token=` query param on WS handshake (cookies not available in WS upgrade). **Fanout:** Redis
pub/sub channel `notifications:{userId}`. On notification enqueue, publisher pushes to channel. All instances listen;
the one holding that user's WS connection delivers it. **Azure App Service:** Multiple instances require pub/sub —
direct in-memory delivery only works on single instance.

---

## DB Trigger Reference

| Trigger                    | Table     | Fires on                          | Action                                                                                                   |
| -------------------------- | --------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `update_rating_aggregates` | `ratings` | INSERT, or UPDATE of `is_visible` | Recalculates `average_rating` + `rating_count` on `users` or `properties` for the affected `reviewee_id` |

Application code never manually updates `average_rating` or `rating_count`.

---

## Security Decisions (Permanent)

- `DUMMY_HASH` — bcrypt of `"dummy"` at 10 rounds. Hardcoded. Never replace with runtime hash. Exists to equalise login
  timing for unknown emails.
- `404` not `403` for party-membership checks — never confirm resource existence to non-parties. Applies to connections,
  ratings, interest requests.
- OTP verify has no IP rate limiter — service-layer attempt counter (`otpAttempts:{userId}` in Redis, max 5) is the only
  throttle. Dual throttle (IP + counter) creates confusing UX with no security benefit.
- Silent refresh is cookie-only — expired Bearer token always 401. Silently rotating an Android Bearer token would stale
  the stored token with no recovery path.
- Property rating via connection — WHERE EXISTS JOIN on `connections → listings → properties` prevents rating an
  arbitrary property using an unrelated confirmed connection.
