# Roomies — Tech Stack Reference

**Runtime:** Node.js + Express, JavaScript ES modules (`"type": "module"`). No TypeScript.

---

## Core Dependencies

| Category | Package | Version | Role |
|----------|---------|---------|------|
| HTTP | `express` | ^5.2.1 | Server, routing, middleware pipeline |
| DB driver | `pg` (node-postgres) | ^8.20.0 | Direct PostgreSQL connection pool — all queries are raw parameterised SQL |
| Validation | `zod` | ^4.3.6 | HTTP boundary + env var validation at startup |
| Auth | `jsonwebtoken` | ^9.0.3 | JWT issuance and verification |
| Auth | `bcryptjs` | ^3.0.3 | Password hashing (10 rounds) |
| Auth | `google-auth-library` | ^10.6.2 | Google OAuth ID token verification via `OAuth2Client.verifyIdToken()` |
| Cache | `redis` | ^5.11.0 | Official node-redis v5 — used for sessions, OTP TTL, rate limiting, BullMQ |
| Queue | `bullmq` | ^5.71.0 | Job queues backed by Redis |
| File upload | `multer` | ^2.1.1 | Multipart parsing, MIME type + extension cross-check, 10MB limit |
| Image processing | `sharp` | ^0.34.5 | Resize to 1200px max, WebP quality 80, strip EXIF |
| Email | `nodemailer` | ^8.0.3 | SMTP transport — Ethereal Mail in dev, configurable for prod |
| Scheduling | `node-cron` | ^4.2.1 | Time-triggered cron jobs within the main Express process |
| Logging | `pino` | ^10.3.1 | Structured async JSON logging |
| Logging | `pino-http` | ^11.0.0 | Request/response logging middleware |
| Logging | `pino-pretty` | ^13.1.3 | Human-readable dev output (not used in production) |
| Security | `helmet` | ^8.1.0 | Security headers |
| Security | `cors` | ^2.8.6 | CORS with `credentials: true` |
| Rate limiting | `express-rate-limit` | ^8.3.1 | Per-route rate limiters |
| Rate limiting | `rate-limit-redis` | ^4.3.1 | Redis-backed store for distributed rate limiting |
| Cookies | `cookie-parser` | ^1.4.7 | Parses `req.cookies` |
| Cloud storage | `@azure/storage-blob` | ^12.31.0 | Azure Blob Storage adapter |
| Dev | `nodemon` | ^3.1.14 | Hot reload, env-file aware |
| Dev | `dotenv` | ^17.3.1 | `.env` file loading |

---

## Database — PostgreSQL 16 + PostGIS

**Connection:** Single `pg.Pool` singleton in `src/db/client.js`. Max 20 connections, idle timeout 30s, connect timeout 5s. Exported as `pool` and `query`. Pool errors on fatal codes (`ECONNREFUSED`, `ENOTFOUND`) call `process.exit(1)`; recoverable idle-client errors are logged and the pool self-heals.

**Query organisation:** Reusable cross-service queries live in `src/db/utils/` — one file per domain (`auth.js`, `institutions.js`, `pgOwner.js`, `compatibility.js`). One-off or evolving queries live inline in service files. All named utility functions accept an optional `client` parameter (defaulting to `pool`) so they can participate in transactions without special wiring.

**Transactions:** Manual `BEGIN / COMMIT / ROLLBACK` using a checked-out `PoolClient`. Always `client.release()` in `finally`. Services that need atomicity check out their own client — never pass a pool reference where a transaction client is needed.

**PostGIS:** `GEOMETRY(POINT, 4326)` columns on `properties` and `listings`. GiST indexes on both for spatial queries. The `sync_location_geometry` trigger auto-computes the geometry column from `latitude`/`longitude` on every INSERT or UPDATE of those columns — application code only writes lat/lng decimals. Proximity search uses `ST_DWithin` with geography cast (meters, handles earth curvature) inline in `listing.service.js`.

**Triggers (all defined in `roomies_db_setup.sql`):**
- `set_updated_at` — BEFORE UPDATE on every table with `updated_at`; sets `NEW.updated_at = NOW()`
- `sync_location_geometry` — BEFORE INSERT OR UPDATE OF `latitude`, `longitude` on `properties` and `listings`; computes PostGIS geometry from `ST_MakePoint(longitude, latitude)` with SRID 4326
- `update_rating_aggregates` — AFTER INSERT OR UPDATE OF `overall_score`, `is_visible`, `deleted_at` on `ratings`; recalculates `AVG(overall_score)` and `COUNT(*)` for the affected reviewee and writes back to `users.average_rating` / `properties.average_rating`

**Extensions required:** `postgis` (spatial types and functions), `pgcrypto` (`gen_random_uuid()` as primary key default on every table).

**Key indexes:**
- `idx_listings_city_lower` — functional index on `LOWER(city)` WHERE `status='active' AND deleted_at IS NULL`; used by `LOWER(l.city) LIKE LOWER($n)` in search
- `idx_notifications_recipient_unread` — partial index on `(recipient_id, created_at DESC)` WHERE `is_read = FALSE`; keeps unread count queries O(log N)
- `idx_connections_interest_request_id` — unique partial index on `interest_request_id` WHERE `interest_request_id IS NOT NULL AND deleted_at IS NULL`; prevents duplicate connections per interest request
- `idx_interest_requests_no_duplicates` — unique partial index on `(sender_id, listing_id)` WHERE `status IN ('pending','accepted') AND deleted_at IS NULL`; prevents duplicate concurrent interest requests
- `idx_listing_photos_one_cover` — unique partial index on `listing_id` WHERE `is_cover = TRUE AND deleted_at IS NULL`; enforces at most one cover photo per listing

---

## Redis — `redis` v5

**Client:** Singleton in `src/cache/client.js`. Exponential backoff reconnect strategy, max 10 attempts, max 3s delay. Connection established via `connectRedis()` called from `server.js`. Shutdown via `redis.close()` (not `redis.quit()` — deprecated in v5).

**Usage by subsystem:**

| Key pattern | TTL | Used by |
|-------------|-----|---------|
| `refreshToken:{userId}:{sid}` | `JWT_REFRESH_EXPIRES_IN` (default 7d) | `auth.service.js` — per-session refresh token storage |
| `userSessions:{userId}` | — | Redis sorted set; score = expiry timestamp; members = sid strings |
| `otp:{userId}` | 600s | `auth.service.js` — hashed OTP storage |
| `otpAttempts:{userId}` | 600s | `auth.service.js` — per-user OTP attempt counter |
| `ipAttempts:{ip}` | 900s | `auth.service.js` — IP-level OTP rate limiter |
| `rl:auth:{ip}` | 900s | `rateLimiter.js` — auth endpoint rate limiter |
| `rl:otp:{ip}` | 900s | `rateLimiter.js` — OTP send rate limiter |
| `contactRevealAnon:{fingerprint}` | 30d | `contactRevealGate.js` — guest reveal quota counter |
| BullMQ internal keys | — | Queue metadata, job payloads, worker locking |

**Per-session refresh token rotation:** `casRefreshToken()` in `auth.service.js` uses a Lua script for atomic compare-and-swap — reads current token, compares with expected old token, updates to new token only if match. Prevents two concurrent refresh requests from both succeeding with the same token.

**Dedicated rate-limit client:** `rateLimiter.js` creates its own `redis` client (not the shared singleton) with a separate, modest reconnect strategy. `passOnStoreError: true` on all limiters — Redis unavailability degrades to no rate limiting rather than blocking all requests.

---

## BullMQ — Job Queues

**Connection:** Each queue and worker uses a connection config parsed from `config.REDIS_URL` (supports `rediss://` for Azure Cache for Redis with TLS). Queue instances are managed by the singleton registry in `src/workers/queue.js` — `getQueue(name)` returns a cached instance, preventing duplicate Redis connections.

**Queues and workers:**

| Queue name | Worker file | Concurrency | Used for |
|------------|-------------|-------------|---------|
| `media-processing` | `mediaProcessor.js` | 1 (CPU-bound) | Sharp image compression, storage write, DB URL update, cover election |
| `notification-delivery` | `notificationWorker.js` | 10 (pure I/O) | Notification INSERT with idempotency_key ON CONFLICT DO NOTHING |

**Job options (notification jobs):** `attempts: 5`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: 100`, `removeOnFail: 200`.

**Enqueueing:** All notification enqueues go through `enqueueNotification()` in `src/workers/notificationQueue.js`. This is a fire-and-forget wrapper — it catches Redis errors and logs them without throwing, so a notification queue failure never crashes a service call.

**Startup/shutdown:** Both workers are started in `server.js` after Redis connects. On shutdown, `mediaWorker.close()` and `notificationWorker.close()` are called before `closeAllQueues()` — workers drain in-flight jobs before the queue connections are torn down.

---

## Authentication — JWT + bcryptjs + Google OAuth

**Access tokens:** Signed with `config.JWT_SECRET` (min 32 chars). Payload: `{ userId, email, roles, sid }`. TTL from `config.JWT_EXPIRES_IN` (default `15m`). `parseTtlSeconds()` normalises string TTLs (`"15m"`, `"900"`, `900`) to numeric seconds before passing to `jwt.sign` — avoids the jsonwebtoken quirk where digit-only strings are interpreted as milliseconds.

**Refresh tokens:** Signed with `config.JWT_REFRESH_SECRET`. Payload: `{ userId, sid }`. TTL from `config.JWT_REFRESH_EXPIRES_IN` (default `7d`). Stored in Redis at `refreshToken:{userId}:{sid}` keyed by session ID. Session IDs tracked in a sorted set `userSessions:{userId}` with expiry timestamp as score.

**Token delivery:** Every auth response (register, login, refresh, OAuth) sets both tokens as HttpOnly cookies AND includes them in the JSON body. `X-Client-Transport: bearer` header from Android clients signals that body tokens should be included; browser clients receive a safe body (no raw tokens) and use cookies.

**Silent refresh:** In `authenticate.js`, if the access token is expired AND it came from a cookie (not a Bearer header), `attemptSilentRefresh()` is called. It validates the refresh token cookie, checks Redis, loads fresh user state from DB, signs a new access token, CAS-rotates the refresh token, and sets new cookies — all transparently, without the request failing.

**Google OAuth:** `googleOAuthClient.verifyIdToken()` validates the ID token signature, expiry, and audience against `config.GOOGLE_CLIENT_ID`. Three branching paths in `googleOAuth()`: returning user (found by `google_id`), account linking (found by email, `google_id IS NULL`), new registration (institution domain transaction, `password_hash = NULL`).

**Password hashing:** bcryptjs, 10 rounds. `DUMMY_HASH` = pre-computed hash of `"dummy"` at 10 rounds, hardcoded in `auth.service.js`. Used for constant-time comparison on unknown email login attempts to prevent user enumeration via timing.

---

## Validation — Zod v4

**HTTP boundary:** `validate(schema)` middleware in `src/middleware/validate.js`. Parses `{ body, query, params }` via `schema.safeParse()`. On success, writes `result.data` back to `req.body`, `req.query`, `req.params` — downstream handlers always see coerced types and defaults, not raw strings. On failure, passes `ZodError` to `next(err)` — global error handler formats it as `{ status: 'error', errors: [{ field, message }] }` using `error.issues`.

**Env validation:** `src/config/env.js` calls `envSchema.safeParse(process.env)` at import time. Any missing or wrong-typed variable causes `process.exit(1)` with a clear per-variable error message. `ALLOWED_ORIGINS` is pre-split into an array at startup.

**Shared pagination schema:** `src/validators/pagination.validators.js` exports `buildKeysetPaginationQuerySchema(extraFields)` and `keysetPaginationQuerySchema`. All paginated endpoints compose from these to keep cursor validation consistent.

---

## Storage — LocalDiskAdapter / AzureBlobAdapter

**Interface:** Both adapters implement `upload(buffer, listingId, filename) → url` and `delete(url)`. Selected by `config.STORAGE_ADAPTER` (`'local'` or `'azure'`). Singleton created in `src/storage/index.js` and imported by `photo.service.js` and `mediaProcessor.js`.

**LocalDiskAdapter** (`src/storage/adapters/localDisk.js`): Writes WebP buffers to `uploads/listings/{listingId}/{filename}`. Returns root-relative URL `/uploads/...`. `fs.mkdir({ recursive: true })` on every upload (idempotent). `fs.unlink` on delete — swallows `ENOENT`. Express serves `/uploads` statically in dev via `app.use('/uploads', express.static('uploads'))`.

**AzureBlobAdapter** (`src/storage/adapters/azureBlob.js`): Uses `@azure/storage-blob` `BlobServiceClient.fromConnectionString()`. Upload uses `AbortController` with 30s timeout passed as `abortSignal` to `uploadData()` — cancels the in-flight HTTP request, not just the JS promise. Delete strips query-string and fragment from the stored URL before extracting blob path (handles SAS tokens). `blobContentType: 'image/webp'`, `blobCacheControl: 'public, max-age=31536000, immutable'` set on upload.

---

## Logging — Pino

**Config:** `src/logger/index.js`. Level `debug` in development, `info` in production. `pino-pretty` transport only in non-production. `pino-http` middleware added in `app.js` for request/response logging.

**Convention:** `logger.info({ userId, listingId }, 'message')` — structured object first, message string second. Never `console.log`. All service files and workers import `logger` directly.

---

## Rate Limiting — express-rate-limit + rate-limit-redis

Two limiters defined in `src/middleware/rateLimiter.js`:
- `authLimiter` — 10 requests / 15 min window, applied to `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/google/callback`
- `otpLimiter` — 5 requests / 15 min window, applied to `/auth/otp/send`

Both use `RedisStore` from `rate-limit-redis` with a dedicated Redis client (separate from the session client). `passOnStoreError: true` on both — Redis unavailability degrades to no rate limiting, not a 500. `standardHeaders: true`, `legacyHeaders: false`. Key defaults to `req.ip` (accurate behind proxy because `app.set('trust proxy', 1)` in production).

---

## Cron Jobs — node-cron

All jobs registered in `server.js` after Redis + DB are confirmed healthy. Each `registerXxxCron()` function returns a `ScheduledTask` stored in a `cronTasks` array for clean `task.stop()` on shutdown.

| File | Default schedule | Env override |
|------|-----------------|-------------|
| `src/cron/listingExpiry.js` | `0 2 * * *` | `CRON_LISTING_EXPIRY` |
| `src/cron/expiryWarning.js` | `0 1 * * *` | `CRON_EXPIRY_WARNING` |
| `src/cron/hardDeleteCleanup.js` | `0 4 * * 0` | `CRON_HARD_DELETE` |

Retention period for `hardDeleteCleanup` overridable via `SOFT_DELETE_RETENTION_DAYS` (default `90`).

---

## File Upload — Multer

Config in `src/middleware/upload.js`. `multer.diskStorage` writes to `uploads/staging/` with a UUID filename. `fileFilter` validates `file.mimetype` against an allowed set (`image/jpeg`, `image/png`, `image/webp`) and cross-checks the file extension against the expected extensions for that MIME type. `limits.fileSize = 10MB`, `limits.files = 1`. `MAX_UPLOAD_SIZE_BYTES` and `UPLOAD_FIELD_NAME` are exported from `src/config/constants.js`.

**Upload flow:** Multer writes the staged file → `enqueuePhotoUpload()` creates the DB row with placeholder URL and enqueues BullMQ job → response sent → worker picks up job → Sharp processes → storage write → DB URL updated.

---

## Infrastructure — Microsoft Azure (Production)

| Service | Usage |
|---------|-------|
| Azure App Service | Node.js hosting — potentially multi-instance (requires Redis pub/sub for Phase 6 WebSocket) |
| Azure Database for PostgreSQL Flexible Server | Managed PostgreSQL 16 with native PostGIS support |
| Azure Cache for Redis | Managed Redis — connection via `rediss://` (TLS), parsed from `REDIS_URL` |
| Azure Blob Storage | Photo storage — `AZURE_STORAGE_CONNECTION_STRING` + `AZURE_STORAGE_CONTAINER` |
| Azure Communication Services | Production email delivery — `ACS_CONNECTION_STRING` + `ACS_FROM_EMAIL` (Phase 5 email worker) |

---

## Local Dev

| Service | Setup |
|---------|-------|
| PostgreSQL 16 + PostGIS | Host-installed — no Docker |
| Redis | Host-installed — no Docker |
| SMTP | Ethereal Mail (fake SMTP, `SMTP_HOST=smtp.ethereal.email`) — preview URL logged to console |
| Storage | Local disk (`STORAGE_ADAPTER=local`) — files written to `uploads/listings/`, served by Express |
| Email | Nodemailer with Ethereal — no real emails sent |
