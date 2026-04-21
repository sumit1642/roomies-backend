# FixOutdated.md — QA Audit Findings: Documentation vs Source

> This file documents each QA finding, verifies it against the source, explains what the bug in the docs actually means, and prescribes the exact fix — accounting for all interdependencies.

---

## Finding 1 — Notification Lifecycle Status Mismatch

### What the finding says

`docs/api/notifications.md` marks `verification_approved` and `verification_rejected` as having a "PLANNED emitter". The claim is that no active code enqueues in-app notifications for these types.

### Verification against source

**`src/workers/verificationEventWorker.js`** (lines inside `processEvent`):

```js
// For verification_approved:
enqueueNotification({
  recipientId: user_id,
  type: "verification_approved",
  entityType: "verification_request",
  entityId: request_id,
});

// For verification_rejected:
enqueueNotification({
  recipientId: user_id,
  type: "verification_rejected",
  entityType: "verification_request",
  entityId: request_id,
});
```

**`src/workers/notificationWorker.js`** — `NOTIFICATION_MESSAGES` map contains:
```js
verification_approved: "Your verification request was approved",
verification_rejected: "Your verification request was rejected",
```
Both are annotated `PLANNED` in the notificationWorker comments, but the emit code in `verificationEventWorker.js` is **live and active**. The notificationWorker comments are also stale but that is a source comment issue, not just a docs issue.

**`src/workers/emailWorker.js`** — `EMAIL_HANDLERS` map:
```js
verification_approved: async ({ to, data }) => { await sendVerificationApprovedEmail(...) },
verification_rejected: async ({ to, data }) => { await sendVerificationRejectedEmail(...) },
verification_pending:  async ({ to, data }) => { await sendVerificationPendingEmail(...) },
```
All three are `ACTIVE` in the emailWorker already.

**The trigger chain** that makes this active:
1. Admin calls `POST /admin/verification-queue/:requestId/approve` or `/reject`
2. `verification.service.approveRequest()` / `rejectRequest()` does `UPDATE verification_requests SET status = 'verified'|'rejected'`
3. Postgres trigger `trg_verification_status_changed` fires → inserts row into `verification_event_outbox`
4. `verificationEventWorker` polls every 5s → calls `processEvent()` → calls both `enqueueNotification()` and `enqueueEmail()`
5. `notificationWorker` processes the BullMQ job → INSERTs into `notifications` table
6. `emailWorker` processes the BullMQ email job → calls `sendVerificationApprovedEmail()` / `sendVerificationRejectedEmail()`

**Conclusion: Finding is confirmed.** Both `verification_approved` and `verification_rejected` are fully active. `verification_pending` is also active (email only — no in-app notification because it is not enqueued in `verificationEventWorker` for `verification_pending` via `enqueueNotification`, only `enqueueEmail` is called).

### What the docs currently say (incorrect)

```markdown
| `verification_approved` | Your verification request was approved | PLANNED emitter |
| `verification_rejected` | Your verification request was rejected | PLANNED emitter |
```

### Exact fix for `docs/api/notifications.md`

Replace the notification type table with the following:

```markdown
| Type                         | Message                                            | Status                       |
| ---------------------------- | -------------------------------------------------- | ---------------------------- |
| `interest_request_received`  | Someone expressed interest in your listing         | ACTIVE                       |
| `interest_request_accepted`  | Your interest request was accepted                 | ACTIVE                       |
| `interest_request_declined`  | Your interest request was declined                 | ACTIVE                       |
| `interest_request_withdrawn` | An interest request was withdrawn                  | ACTIVE                       |
| `connection_confirmed`       | Your connection has been confirmed by both parties | ACTIVE                       |
| `rating_received`            | You received a new rating                          | ACTIVE                       |
| `listing_expiring`           | One of your listings is expiring soon              | ACTIVE                       |
| `listing_expired`            | One of your listings has expired                   | ACTIVE                       |
| `listing_filled`             | A listing has been marked as filled                | ACTIVE                       |
| `verification_approved`      | Your verification request was approved             | ACTIVE (in-app + email)      |
| `verification_rejected`      | Your verification request was rejected             | ACTIVE (in-app + email)      |
| `verification_pending`       | We received your verification documents            | ACTIVE (email only, no in-app notification) |
| `new_message`                | You have a new message                             | PLANNED — no emitter         |
| `connection_requested`       | You have a new connection request                  | PLANNED — no emitter         |
```

Add a note below the table:

```markdown
### Delivery pipeline for verification events

Verification notifications are **not triggered directly by the API controller**. They are driven by a CDC (Change Data Capture) outbox pattern:

1. Admin calls `POST /admin/verification-queue/:requestId/approve|reject`
2. `verification.service.js` commits `UPDATE verification_requests SET status = 'verified'|'rejected'|'pending'`
3. Postgres trigger `trg_verification_status_changed` (migration `002`) writes to `verification_event_outbox`
4. `src/workers/verificationEventWorker.js` polls the outbox every **5 seconds** using `SELECT ... FOR UPDATE SKIP LOCKED`
5. On each event, the worker calls:
   - `enqueueNotification()` → `notification-delivery` BullMQ queue → in-app notification row
   - `enqueueEmail()` → `email-delivery` BullMQ queue → Brevo REST/SMTP email
6. `verification_pending` emits **email only** (no `enqueueNotification` call in source)

This means verification notifications can originate from **direct SQL on the database** (not just the API), as long as the trigger fires. The worker handles retry with up to `MAX_ATTEMPTS = 5` retries per event.
```

Also fix `notificationWorker.js` source comments — change the annotation on `verification_approved` and `verification_rejected` from `PLANNED` to `ACTIVE` in the `NOTIFICATION_MESSAGES` map comments. This is a source file fix, not just docs.

---

## Finding 2 — CDC Outbox Worker Behavior Undocumented

### What the finding says

API docs don't document that verification side effects are driven by DB-trigger → outbox → poll worker, and that state changes from outside the API (raw SQL, migrations) can also trigger notifications/emails.

### Verification against source

**`migrations/002_verification_event_outbox.sql`** — creates `verification_event_outbox` table and the trigger `trg_verification_status_changed` which fires on `AFTER UPDATE OF status ON verification_requests`.

**`src/workers/verificationEventWorker.js`**:
- Polls every `POLL_INTERVAL_MS = 5_000` ms
- Batch size: `BATCH_SIZE = 10`
- Max retry attempts per event: `MAX_ATTEMPTS = 5`
- Uses `FOR UPDATE SKIP LOCKED` — safe for multi-instance deployments
- On startup, runs one immediate drain cycle (catches events that accumulated during downtime)
- Profile consistency guard: if `pg_owner_profiles.verification_status` is out of sync with the event type, the worker corrects it in the same transaction

**`src/server.js`**:
```js
const verificationEventWorker = startVerificationEventWorker();
// ... shutdown:
verificationEventWorker.close(); // clearInterval only — no async drain
```

The worker's `close()` is synchronous (`clearInterval`) — it does not drain in-flight events before shutdown. This means events in the middle of processing during a SIGTERM may be retried on next startup.

### What the docs currently say

There is no mention of any of this in `docs/api/notifications.md`, `docs/api/admin.md`, or `docs/API.md`. The admin doc has only this footnote:

```markdown
## CDC side-effects note
When verification status changes to `verified`, `rejected`, or `pending`, trigger `trg_verification_status_changed` writes to `verification_event_outbox`. `verificationEventWorker` polls this table (5-second interval) and enqueues:
- in-app notification (`notification-delivery`)
- email (`email-delivery`)
```

This is present but incomplete — it doesn't note email-only for `pending`, doesn't cover the profile consistency guard, doesn't cover the retry model, and doesn't cover the "outside-API trigger" scenario.

### Exact fix for `docs/api/admin.md`

Replace the CDC side-effects note at the bottom with:

```markdown
## CDC Outbox: Verification Side Effects

Verification status changes trigger a **CDC (Change Data Capture) outbox pipeline**, not direct synchronous effects from the API.

### Trigger

The Postgres trigger `trg_verification_status_changed` fires on `AFTER UPDATE OF status ON verification_requests` for any status change to `verified`, `rejected`, or `pending`. This fires regardless of whether the change comes from the API or direct SQL.

### Worker behavior (`src/workers/verificationEventWorker.js`)

| Property         | Value                        |
| ---------------- | ---------------------------- |
| Poll interval    | 5 seconds                    |
| Batch size       | 10 events per cycle          |
| Max retry attempts | 5 (then event is abandoned with error recorded) |
| Concurrency safe | Yes — `FOR UPDATE SKIP LOCKED` prevents double-processing across instances |
| Startup behavior | Runs one immediate drain on startup to catch accumulated events |

### Per-event actions

| Event type              | In-app notification | Email                         |
| ----------------------- | ------------------- | ----------------------------- |
| `verification_approved` | Yes                 | Yes (`sendVerificationApprovedEmail`) |
| `verification_rejected` | Yes                 | Yes (`sendVerificationRejectedEmail`) |
| `verification_pending`  | No                  | Yes (`sendVerificationPendingEmail`)  |

### Profile consistency guard

Before enqueuing notifications, the worker verifies `pg_owner_profiles.verification_status` matches the event type. If inconsistent (e.g. admin ran partial SQL), the worker corrects the profile status in the same DB transaction as the event acknowledgement.

### Failure behavior

- If `processEvent()` throws, `attempts` is incremented and `error_message` recorded.
- After `MAX_ATTEMPTS = 5` failures, `processed_at` is set — event is permanently skipped but remains in table for inspection.
- Graceful shutdown (`SIGTERM`) calls `clearInterval` only — in-flight events are not drained and will be retried on next startup.
```

---

## Finding 3 — Auth Transport Docs Missing Branch Semantics

### What the finding says

Docs don't fully specify the concrete branching behavior implemented in `authenticate.js` and `optionalAuthenticate.js`:
- Cookie vs bearer priority in token extraction
- Silent refresh triggers (cookie-expired only, not bearer)
- What exactly is returned on each failure path
- `optionalAuthenticate` degrading to guest on any token error

### Verification against source

**`src/middleware/authenticate.js` — `extractToken()`:**
```js
const extractToken = (req) => {
  const cookieToken = req.cookies?.accessToken;
  if (cookieToken) return { token: cookieToken, source: "cookie" };
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return { token: authHeader.slice(7), source: "header" };
  return null;
};
```
**Cookie takes priority unconditionally.** If both cookie and `Authorization` header are present, cookie wins.

**`authenticate` — expired token branching:**
```js
} catch (err) {
  if (err.name === "TokenExpiredError" && source === "cookie") {
    const session = await attemptSilentRefresh(req, res);
    if (!session?.userId) return next(new AppError("Session expired", 401));
    payload = session;
  } else {
    return next(err); // → global handler: "Token has expired" for bearer
  }
}
```

**Silent refresh conditions** (`attemptSilentRefresh`):
- Only triggers when `source === "cookie"` AND `err.name === "TokenExpiredError"`
- Reads `req.cookies?.refreshToken`
- Calls `verifyRefreshTokenPayload()` — handles legacy tokens without `sid`
- Checks `redis.get(refreshTokenKey(userId, sid))` — token must match stored value
- Signs new access + refresh tokens, CAS-rotates refresh via Lua script
- Sets new cookies in-place — client sees no interruption
- Returns `null` on any failure → `"Session expired"` 401

**`optionalAuthenticate` — failure degradation:**
```js
try {
  payload = jwt.verify(token, config.JWT_SECRET);
} catch {
  return next(); // any verify error → guest, never 401
}
if (!payload?.userId) return next();
const user = await findUserById(payload.userId);
if (!user || INACTIVE_STATUSES.has(user.account_status)) return next(); // still guest
```
Any failure (expired, invalid, user deleted, user suspended) → request continues as guest with no `req.user`.

**`isBearerTransport` in `auth.controller.js`:**
```js
const isBearerTransport = (req) => req.headers["x-client-transport"] === "bearer";
```
Only the exact header value `"bearer"` (lowercase) triggers bearer response mode.

**`setAuthCookies` cookie options:**
```js
const ACCESS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: "strict",
  maxAge: parseTtlSeconds(config.JWT_EXPIRES_IN, 15 * 60) * 1000,
};
```

### What the docs currently say

`docs/api/auth.md` Transport Summary:
```markdown
- Browser clients should use cookie mode.
- Mobile and API clients should send `X-Client-Transport: bearer` to receive tokens in the JSON body.
- Silent refresh only happens when the expired access token came from a cookie.
```

This is correct but **incomplete** — it doesn't document the response body difference, error message difference between bearer-expired vs cookie-expired, or that cookie takes priority over bearer header when both are present.

### Exact fix for `docs/api/auth.md` Transport Summary section

Replace "Transport Summary" with:

```markdown
## Auth Transport Reference

### Token extraction priority

`authenticate` and `optionalAuthenticate` extract the access token in this exact order:

1. `req.cookies.accessToken` (HttpOnly cookie) — **takes priority**
2. `Authorization: Bearer <token>` header — used only if no cookie present

If both are present, **the cookie always wins**. This prevents a stale bearer token from overriding a valid cookie session.

### Transport mode: cookie (default, browser)

- No special request header needed
- Auth endpoints set `accessToken` (TTL: `JWT_EXPIRES_IN`, default `15m`) and `refreshToken` (TTL: `JWT_REFRESH_EXPIRES_IN`, default `7d`) as `HttpOnly; SameSite=Strict` cookies
- Response body for auth endpoints contains `{ user, sid }` only — **no raw token strings**
- `secure: true` in production, `secure: false` in development

### Transport mode: bearer (mobile/Android)

- Set request header: `X-Client-Transport: bearer` (case-sensitive, lowercase `"bearer"`)
- Response body for auth endpoints includes `{ accessToken, refreshToken, user, sid }`
- For protected endpoints, send: `Authorization: Bearer <access-token>`

### Silent refresh (cookie mode only)

Triggers automatically inside `authenticate` middleware when:
- `err.name === "TokenExpiredError"` **AND**
- Token came from `req.cookies.accessToken` (not from `Authorization` header)

Silent refresh process:
1. Reads `req.cookies.refreshToken`
2. Calls `verifyRefreshTokenPayload()` — handles legacy tokens missing `sid` via migration path
3. Checks Redis: `GET refreshToken:{userId}:{sid}` — must match stored value exactly
4. Loads fresh user state from DB (roles, email, account_status)
5. Signs new access token + new refresh token
6. CAS-rotates refresh token via Lua script (atomic compare-and-swap prevents concurrent rotation races)
7. Sets new cookies on the response — client sees no interruption

Silent refresh **never** triggers for an expired `Authorization: Bearer` header token.

### Error response matrix by scenario

| Scenario | Middleware | Response |
| --- | --- | --- |
| No token present | `authenticate` | `401 { "message": "No token provided" }` |
| Bearer token expired | `authenticate` | `401 { "message": "Token has expired" }` |
| Cookie token expired + refresh succeeds | `authenticate` | Request continues transparently |
| Cookie token expired + refresh fails | `authenticate` | `401 { "message": "Session expired" }` |
| Token invalid (malformed/wrong secret) | `authenticate` | `401 { "message": "Invalid token" }` |
| User not found in DB | `authenticate` | `401 { "message": "User not found" }` |
| User suspended/banned/deactivated | `authenticate` | `401 { "message": "Account is suspended" }` |
| Any token error | `optionalAuthenticate` | Request continues as guest (`req.user` is undefined) |
| Invalid/expired token | `optionalAuthenticate` | Request continues as guest — **never returns 401** |
| Suspended user token | `optionalAuthenticate` | Request continues as guest |
```

---

## Finding 4 — Listing Route Chain and Photo Upload Path Inaccurate

### What the finding says

The exact middleware chain for listing read endpoints has validate before guestListingGate (not gate before validate). Photo upload flow should explicitly show the queue/worker chain and 503 queue-failure path.

### Verification against source

**`src/routes/listing.js`** — search route:
```js
listingRouter.get(
  "/",
  optionalAuthenticate,
  validate(searchListingsSchema),    // ← validate BEFORE gate
  guestListingGate,                  // ← gate AFTER validate
  listingController.searchListings,
);
```

**`src/routes/listing.js`** — single listing route:
```js
listingRouter.get(
  "/:listingId",
  optionalAuthenticate,
  validate(listingParamsSchema),     // ← validate BEFORE gate
  guestListingGate,
  listingController.getListing,
);
```

**Why this order matters**: `validate` runs Zod and writes coerced values back to `req.query`. `guestListingGate` reads `req.query.limit` to apply the guest cap. If gate ran before validate, it would read a raw string from the query rather than the Zod-coerced number. The source comment in `listing.js` explicitly explains this:
```js
// validate runs before guestListingGate so that the limit field is already
// coerced to a number (by Zod) when guestListingGate reads it.
```

**`guestListingGate` actual behavior** (`src/middleware/guestListingGate.js`):
- If `req.user` is set → passes through with no modification
- If guest → silently caps `req.query.limit` to `GUEST_MAX_LISTINGS_PER_REQUEST = 20` **only if requested limit exceeds 20**
- Does NOT block or count guest browses, does NOT touch Redis
- Sets `req.query = { ...req.query, limit: 20 }` via object spread (req.query was already made writable by `validate`)

**Photo upload flow** (`src/routes/listing.js` + `src/middleware/upload.js` + `src/services/photo.service.js`):

Full chain for `POST /listings/:listingId/photos`:
```
authenticate
→ upload.single("photo")           [Multer: MIME check, extension cross-check, 10MB limit, writes to uploads/staging/]
→ validate(uploadPhotoSchema)       [Zod: listingId UUID param]
→ photoController.uploadPhoto
  → photoService.enqueuePhotoUpload(posterId, listingId, req.file.path)
    → pool.connect() → BEGIN
    → SELECT listing_id FROM listings WHERE ... FOR UPDATE   [listing lock]
    → SELECT COALESCE(MAX(display_order),-1)+1 FROM listing_photos  [server-side order]
    → INSERT INTO listing_photos (photo_id, ..., photo_url='processing:{photoId}')
    → COMMIT
    → getQueue("media-processing").add("process-photo", { listingId, photoId, stagingPath })
      → [If queue.add() throws] → UPDATE listing_photos SET deleted_at=NOW() [cleanup]
                                → throw AppError 503 "Photo processing queue is temporarily unavailable"
    → return { photoId, status: "processing" }
  → res.status(202).json(...)

[Async — after HTTP response sent]
mediaProcessor worker (concurrency: 1):
  → sharp(stagingPath).resize(1200,1200).webp({quality:80}).withMetadata(false).toBuffer()
  → storageService.upload(buffer, listingId, filename)  [AzureBlobAdapter: 30s AbortController timeout]
  → UPDATE listing_photos SET photo_url = finalUrl WHERE photo_id = ...
  → UPDATE listing_photos SET is_cover = TRUE WHERE ... AND NOT EXISTS (SELECT 1 ... WHERE is_cover=TRUE)
  → fs.unlink(stagingPath)
```

**503 queue-failure path** is real and documented in source but absent from docs:
```js
} catch (queueErr) {
  // soft-delete the provisional row
  await pool.query(`UPDATE listing_photos SET deleted_at = NOW() WHERE photo_id = $1 ...`, [photoId, listingId]);
  throw new AppError("Photo processing queue is temporarily unavailable. Please retry.", 503);
}
```

### Exact fix for `docs/api/listings.api.md`

**1. Fix the middleware chain description** (add to the "Auth Policy for Read Routes" section):

```markdown
### Exact middleware chain for read endpoints

**`GET /listings`**:
```
optionalAuthenticate → validate(searchListingsSchema) → guestListingGate → listingController.searchListings
```
Note: `validate` runs before `guestListingGate` intentionally — Zod coerces `limit` to a number before the gate reads it.

**`GET /listings/:listingId`**:
```
optionalAuthenticate → validate(listingParamsSchema) → guestListingGate → listingController.getListing
```

**`guestListingGate` behavior**:
- Authenticated users (`req.user` set): passes through with no changes
- Guests: silently caps `req.query.limit` to `20` if requested value exceeds `20`
- Does not block browsing, does not touch Redis, does not count requests
```

**2. Fix the photo upload scenario to include the full chain:**

```markdown
### `POST /listings/:listingId/photos`

**Middleware chain:**
```
authenticate → upload.single("photo") → validate(uploadPhotoSchema) → photoController.uploadPhoto
```

**Upload middleware (`src/middleware/upload.js`)**:
- Field name must be `photo` (LIMIT_UNEXPECTED_FILE → 400 if wrong)
- Accepted MIME types: `image/jpeg`, `image/png`, `image/webp`
- Extension cross-checked against MIME type (e.g. `.txt` claiming `image/jpeg` → 400)
- Max file size: `10MB` (LIMIT_FILE_SIZE → 413)
- Writes staged file to `uploads/staging/{uuid}.ext`

**Service layer (`src/services/photo.service.js` → `enqueuePhotoUpload`)**:
1. Acquires row-level lock: `SELECT ... FROM listings WHERE ... FOR UPDATE`
2. Allocates `display_order` server-side: `SELECT COALESCE(MAX(display_order), -1) + 1`
3. Inserts provisional row with `photo_url = 'processing:{photoId}'`
4. Commits transaction
5. Calls `getQueue("media-processing").add("process-photo", { ... })`

**Queue failure path** (Redis unavailable after DB commit):
- Soft-deletes the provisional photo row
- Returns `503 { "message": "Photo processing queue is temporarily unavailable. Please retry." }`

**Async processing** (`src/workers/mediaProcessor.js`, concurrency: 1):
- Sharp: resize to max 1200×1200, WebP quality 80, strip EXIF metadata
- Upload to Azure Blob (30s AbortController timeout — `504` if exceeded)
- `UPDATE listing_photos SET photo_url = finalUrl`
- Cover election: `UPDATE ... SET is_cover = TRUE WHERE NOT EXISTS (SELECT 1 ... WHERE is_cover = TRUE)`
- Deletes staging file

**Scenario: upload accepted and queued**

Status: `202`
```json
{
  "status": "success",
  "data": {
    "photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
    "status": "processing"
  }
}
```

**Scenario: queue unavailable**

Status: `503`
```json
{
  "status": "error",
  "message": "Photo processing queue is temporarily unavailable. Please retry."
}
```
```

---

## Finding 5 — Zod-Derived Request Contracts Incomplete

### What the finding says

Docs miss important validator constraints actually enforced by Zod. Specific examples:
- `isRead` in notification feed accepts `"true"/"false"` strings and numeric `0`/`1`
- Auth refresh/logout body token is optional due to cookie mode
- Cursor pair rules not fully specified across all keyset endpoints

### Verification against source

**`src/validators/notification.validators.js` — `isRead` preprocessing:**
```js
isRead: z.preprocess((val) => {
  if (typeof val === "string") {
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;
    return val; // anything else passes through → z.boolean() rejects it
  }
  if (typeof val === "number") {
    if (val === 0) return false;
    if (val === 1) return true;
    return val; // 2, -1, etc. pass through → z.boolean() rejects
  }
  return val;
}, z.boolean()).optional()
```
Accepts: `"true"`, `"false"`, `"TRUE"`, `"FALSE"`, `0`, `1`. Rejects: `"yes"`, `2`, `"1"` (string).

**`src/validators/auth.validators.js` — optional refresh token body:**
```js
const optionalRefreshTokenBody = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .optional()
  .default({});

export const refreshSchema = z.object({ body: optionalRefreshTokenBody });
export const logoutCurrentSchema = z.object({ body: optionalRefreshTokenBody });
```
Entire body is optional (defaults to `{}`). `refreshToken` within it is also optional. Controller resolves via `req.body?.refreshToken ?? req.cookies?.refreshToken`.

**`src/validators/pagination.validators.js` — cursor pair rule:**
```js
.refine(
  (data) => {
    const hasTime = data.cursorTime !== undefined;
    const hasId = data.cursorId !== undefined;
    return hasTime === hasId;
  },
  { error: "cursorTime and cursorId must be provided together", path: ["cursorTime"] }
)
```
This refine is in `buildKeysetPaginationQuerySchema()` which is used by: `searchListingsSchema`, `getListingInterestsSchema`, `getMyInterestsSchema`, `getFeedSchema` (notifications), `getPublicRatingsSchema`, `getMyGivenRatingsSchema`, `getPublicPropertyRatingsSchema`. But `listPropertiesSchema` uses its own cursor validation (not via `buildKeysetPaginationQuerySchema`), with the same refine applied locally.

### Exact fixes

**Fix `docs/api/notifications.md` — add to `GET /notifications` request contract:**

```markdown
### Query parameter details

**`isRead`** (optional boolean filter):

Accepts the following values:
- String: `"true"` or `"false"` (case-insensitive: `"TRUE"`, `"False"` also work)
- Numeric: `0` (false) or `1` (true)
- Omit entirely to receive all notifications (read + unread)

Values like `"yes"`, `"1"` (as string), `2` are rejected with `400 Validation failed`.
```

**Fix `docs/api/auth.md` — `POST /auth/refresh` and `POST /auth/logout` request contracts:**

```markdown
### Request body

The request body is **fully optional** for browser clients using cookie transport.

- **Cookie mode (browser):** Send no body. The controller reads `req.cookies.refreshToken` automatically.
- **Bearer mode (Android/API):** Send `{ "refreshToken": "..." }` in the body.

The validator accepts an empty body (`{}`), an absent body, or a body with `refreshToken`. Missing `refreshToken` in body is not an error if the cookie is present — the controller resolves: `req.body?.refreshToken ?? req.cookies?.refreshToken`.
```

**Fix all paginated endpoint docs — add explicit cursor pair rule note:**

Add to the shared `docs/api/conventions.md` pagination section:

```markdown
### Cursor pairing enforcement

All keyset-paginated endpoints enforce that `cursorTime` and `cursorId` must be supplied together or both omitted. This is validated by Zod before the request reaches the controller.

Sending only one cursor field returns `400`:

```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [{ "field": "query.cursorTime", "message": "cursorTime and cursorId must be provided together" }]
}
```

This rule applies to: `GET /listings`, `GET /listings/:listingId/interests`, `GET /interests/me`, `GET /notifications`, `GET /ratings/user/:userId`, `GET /ratings/property/:propertyId`, `GET /ratings/me/given`, `GET /ratings/connection/:connectionId`, `GET /connections/me`, `GET /properties`, `GET /listings/me/saved`.
```

---

## Finding 6 — Missing Appendix Sections

### What the finding says

Two cross-reference appendices are absent:
1. Middleware reference: maps each middleware → every route that uses it
2. Workers/crons reference: maps each worker/cron → affected endpoints and behavior

### Verification against source

Reviewing all route files (`src/routes/*.js`) and cross-referencing with middleware files (`src/middleware/*.js`) and worker/cron files.

### Fix: Create `docs/api/appendix-middleware.md`

```markdown
# Appendix: Middleware Reference

Maps each middleware to every route that uses it, with its role in the chain.

---

## `authenticate` (`src/middleware/authenticate.js`)

Requires a valid access token. Sets `req.user`. Attempts silent refresh for expired cookie tokens only.

| Route | Method |
| --- | --- |
| `POST /auth/logout/current` | POST |
| `POST /auth/logout/all` | POST |
| `GET /auth/sessions` | GET |
| `DELETE /auth/sessions/:sid` | DELETE |
| `POST /auth/otp/send` | POST |
| `POST /auth/otp/verify` | POST |
| `GET /auth/me` | GET |
| `POST /listings` | POST |
| `PUT /listings/:listingId` | PUT |
| `DELETE /listings/:listingId` | DELETE |
| `PATCH /listings/:listingId/status` | PATCH |
| `GET /listings/:listingId/preferences` | GET |
| `PUT /listings/:listingId/preferences` | PUT |
| `POST /listings/:listingId/save` | POST |
| `DELETE /listings/:listingId/save` | DELETE |
| `GET /listings/me/saved` | GET |
| `GET /listings/:listingId/photos` | GET |
| `POST /listings/:listingId/photos` | POST |
| `DELETE /listings/:listingId/photos/:photoId` | DELETE |
| `PATCH /listings/:listingId/photos/:photoId/cover` | PATCH |
| `PUT /listings/:listingId/photos/reorder` | PUT |
| `POST /listings/:listingId/interests` | POST |
| `GET /listings/:listingId/interests` | GET |
| `GET /interests/me` | GET |
| `GET /interests/:interestId` | GET |
| `PATCH /interests/:interestId/status` | PATCH |
| `GET /connections/me` | GET |
| `GET /connections/:connectionId` | GET |
| `POST /connections/:connectionId/confirm` | POST |
| `GET /notifications` | GET |
| `GET /notifications/unread-count` | GET |
| `POST /notifications/mark-read` | POST |
| `GET /students/:userId/profile` | GET |
| `PUT /students/:userId/profile` | PUT |
| `GET /students/:userId/preferences` | GET |
| `PUT /students/:userId/preferences` | PUT |
| `GET /pg-owners/:userId/profile` | GET |
| `PUT /pg-owners/:userId/profile` | PUT |
| `POST /pg-owners/:userId/documents` | POST |
| `GET /properties` | GET |
| `GET /properties/:propertyId` | GET |
| `POST /properties` | POST |
| `PUT /properties/:propertyId` | PUT |
| `DELETE /properties/:propertyId` | DELETE |
| `GET /ratings/me/given` | GET |
| `GET /ratings/connection/:connectionId` | GET |
| `POST /ratings` | POST |
| `POST /ratings/:ratingId/report` | POST |
| `GET /preferences/meta` | GET |

---

## `optionalAuthenticate` (`src/middleware/optionalAuthenticate.js`)

Tries to set `req.user` if a valid token is present. Never returns 401. Any failure (expired, invalid, user deleted/suspended) → request continues as guest.

Token extraction order: cookie → Authorization header (same as `authenticate`).

| Route | Method |
| --- | --- |
| `GET /listings` | GET |
| `GET /listings/:listingId` | GET |
| `GET /students/:userId/contact/reveal` | GET |
| `POST /pg-owners/:userId/contact/reveal` | POST |

---

## `authorize(role)` (`src/middleware/authorize.js`)

Must run after `authenticate`. Checks `req.user.roles.includes(role)`. Returns `403 Forbidden` if role missing.

**Note:** `authorize()` validates the role argument at route registration time (startup), not per-request. Misconfiguration throws at startup.

| Route | Required Role |
| --- | --- |
| `GET /listings/me/saved` | `student` |
| `POST /listings/:listingId/save` | `student` |
| `DELETE /listings/:listingId/save` | `student` |
| `POST /listings/:listingId/interests` | `student` |
| `GET /interests/me` | `student` |
| `PUT /pg-owners/:userId/profile` | `pg_owner` |
| `POST /pg-owners/:userId/documents` | `pg_owner` |
| `GET /properties` | `pg_owner` |
| `POST /properties` | `pg_owner` |
| `PUT /properties/:propertyId` | `pg_owner` |
| `DELETE /properties/:propertyId` | `pg_owner` |

---

## `contactRevealGate` (`src/middleware/contactRevealGate.js`)

Must run after `optionalAuthenticate` and `validate`. Sets `req.contactReveal = { emailOnly, verified }`.

**Behavior:**
- Verified users (`req.user?.isEmailVerified === true`): passes through, sets `emailOnly: false` → controller returns full bundle (email + phone)
- Guests/unverified: checks Redis counter `contactRevealAnon:{sha256(ip|ua)}`, then checks HttpOnly cookie `contactRevealAnonCount`
- If count ≥ 10: returns `429 CONTACT_REVEAL_LIMIT_REACHED` immediately
- Otherwise: installs a pre-response hook on `res.json`/`res.send`/`res.end` to increment quota **after** a successful 2xx response only
- Quota is incremented atomically via Lua script: `INCR key; if count==1 then EXPIRE key 30days`
- `Cache-Control: no-store` must be set on the response **before** this middleware runs (see route files)

| Route | Method |
| --- | --- |
| `GET /students/:userId/contact/reveal` | GET |
| `POST /pg-owners/:userId/contact/reveal` | POST |

---

## `guestListingGate` (`src/middleware/guestListingGate.js`)

Must run after `validate` (relies on Zod-coerced `req.query.limit` being a number).

**Behavior:**
- Authenticated (`req.user` set): no-op, passes through
- Guest: silently caps `req.query.limit` to `20` if the requested value exceeds `20`
- Does not block, does not count, does not touch Redis

| Route | Method |
| --- | --- |
| `GET /listings` | GET |
| `GET /listings/:listingId` | GET |

---

## `validate(schema)` (`src/middleware/validate.js`)

Runs Zod's `schema.safeParse({ body, query, params })`. On success, writes `result.data` back to `req.body`, `req.params`, and `req.query` (using `Object.defineProperty` for query in Express 5 compatibility). On failure, passes `ZodError` to `next(err)` → global error handler.

Used on virtually every route. Not individually listed here — see per-endpoint docs for the schema name.

---

## `authLimiter` (`src/middleware/rateLimiter.js`)

10 requests / 15-minute window. Redis-backed (`rl:auth:{ip}`). `passOnStoreError: true` — degrades to no limiting if Redis is down.

| Route | Method |
| --- | --- |
| `POST /auth/register` | POST |
| `POST /auth/login` | POST |
| `POST /auth/logout/all` | POST |
| `POST /auth/refresh` | POST |
| `GET /auth/sessions` | GET |
| `DELETE /auth/sessions/:sid` | DELETE |
| `POST /auth/google/callback` | POST |

---

## `otpLimiter` (`src/middleware/rateLimiter.js`)

5 requests / 15-minute window. Redis-backed (`rl:otp:{ip}`). `passOnStoreError: true`.

| Route | Method |
| --- | --- |
| `POST /auth/otp/send` | POST |

---

## `publicRatingsLimiter` (`src/middleware/rateLimiter.js`)

120 requests / 15-minute window. Redis-backed (`rl:ratings:public:{ip}`). `passOnStoreError: true`.

| Route | Method |
| --- | --- |
| `GET /ratings/user/:userId` | GET |
| `GET /ratings/property/:propertyId` | GET |

---

## `upload.single("photo")` (`src/middleware/upload.js`)

Multer disk storage. Writes to `uploads/staging/{uuid}.ext`. Validates MIME type and file extension cross-match. Limits: 10MB file size, 1 file per request.

| Route | Method |
| --- | --- |
| `POST /listings/:listingId/photos` | POST |
```

### Fix: Create `docs/api/appendix-workers-crons.md`

```markdown
# Appendix: Workers and Cron Jobs Reference

---

## BullMQ Workers

### `media-processing` queue — `src/workers/mediaProcessor.js`

**Concurrency:** 1 (CPU-bound Sharp processing)

**Triggered by:** `POST /listings/:listingId/photos` (via `photo.service.enqueuePhotoUpload`)

**Job payload:** `{ listingId, photoId, stagingPath, posterId }`

**Processing steps:**
1. `sharp(stagingPath).resize(1200, 1200, { fit: "inside" }).webp({ quality: 80 }).withMetadata(false).toBuffer()`
2. `storageService.upload(buffer, listingId, filename)` — AzureBlobAdapter with 30s AbortController timeout
3. `UPDATE listing_photos SET photo_url = finalUrl WHERE photo_id = ?`
4. Cover election: `UPDATE ... SET is_cover = TRUE WHERE NOT EXISTS (SELECT 1 ... WHERE is_cover = TRUE)`
5. `fs.unlink(stagingPath)`

**Failure handling:**
- If photo row was soft-deleted before processing completed: deletes the already-uploaded permanent file, skips DB update
- `storageService.upload` timeout (30s): throws `AppError 504`, job fails → BullMQ retries (max 3 attempts)
- Stage file cleanup failures: logged as warn, does not fail the job

**Affects these endpoint-visible states:**
- `GET /listings/:listingId/photos` — photo becomes visible only after worker sets real URL (placeholder `processing:{photoId}` is filtered out)
- `GET /listings/:listingId` — cover photo in `photos` array

---

### `notification-delivery` queue — `src/workers/notificationWorker.js`

**Concurrency:** 10 (I/O-bound DB inserts)

**Job options:** 5 attempts, exponential backoff (2s base)

**Triggered by:** `enqueueNotification()` calls in:
- `interest.service.js` — `createInterestRequest`, `transitionInterestRequest`, `_acceptInterestRequest`
- `connection.service.js` — `confirmConnection`
- `rating.service.js` — `submitRating`
- `cron/listingExpiry.js` — listing expired
- `cron/expiryWarning.js` — listing expiring soon
- `verificationEventWorker.js` — verification approved/rejected

**Processing:** `INSERT INTO notifications ... ON CONFLICT (idempotency_key) DO NOTHING`

Idempotency key = BullMQ `job.id`. Retry-safe: duplicate inserts are silently skipped.

**Affects:** `GET /notifications`, `GET /notifications/unread-count`

---

### `email-delivery` queue — `src/workers/emailWorker.js`

**Concurrency:** 3 (I/O-bound SMTP/REST)

**Job options:** 3 attempts, exponential backoff (5s base)

**Triggered by:** `enqueueEmail()` calls in:
- `auth.service.js` → `sendOtp()` — triggers on `POST /auth/otp/send`
- `verificationEventWorker.js` — all three verification event types

**Handlers:**

| Job type | Email function | Triggered by |
| --- | --- | --- |
| `otp` | `sendOtpEmail()` | `POST /auth/otp/send` |
| `verification_approved` | `sendVerificationApprovedEmail()` | verificationEventWorker |
| `verification_rejected` | `sendVerificationRejectedEmail()` | verificationEventWorker |
| `verification_pending` | `sendVerificationPendingEmail()` | verificationEventWorker |

Unknown job type: logged at warn level, job marked complete without sending.

---

### `verificationEventWorker` — `src/workers/verificationEventWorker.js`

**Type:** Not BullMQ — `setInterval` polling loop

**Poll interval:** 5 seconds

**Batch size:** 10 events per cycle

**Max attempts per event:** 5

**Triggered by:** Postgres trigger `trg_verification_status_changed` which fires on `AFTER UPDATE OF status ON verification_requests`

**API routes that can trigger the trigger:**
- `POST /admin/verification-queue/:requestId/approve` → `verification.service.approveRequest()`
- `POST /admin/verification-queue/:requestId/reject` → `verification.service.rejectRequest()`
- `POST /pg-owners/:userId/documents` → `verification.service.submitDocument()` → sets status to `pending`

**Also triggered by:** Any direct SQL UPDATE on `verification_requests.status` (migration scripts, admin psql sessions)

**Actions per event:**
- `verification_approved`: correct `pg_owner_profiles.verification_status` if needed → `enqueueNotification` + `enqueueEmail`
- `verification_rejected`: correct profile status → `enqueueNotification` + `enqueueEmail`
- `verification_pending`: `enqueueEmail` only (no in-app notification)

**Concurrency safety:** `SELECT ... FOR UPDATE SKIP LOCKED` — safe for multi-instance deployments

**Shutdown behavior:** `clearInterval` only — does not drain in-flight events. Events retried on next startup.

---

## Cron Jobs

### `listingExpiry` — `src/cron/listingExpiry.js`

**Schedule:** `0 2 * * *` (02:00 daily). Override: `CRON_LISTING_EXPIRY` env var.

**What it does:**
```sql
UPDATE listings SET status = 'expired'
WHERE status = 'active' AND expires_at < NOW() AND deleted_at IS NULL
RETURNING listing_id, posted_by
```
Then in the same transaction:
```sql
UPDATE interest_requests SET status = 'expired'
WHERE listing_id = ANY($expiredIds) AND status = 'pending' AND deleted_at IS NULL
```
Post-commit: `enqueueNotification({ type: "listing_expired" })` for each expired listing's poster.

**API impact:**
- Expired listings no longer appear in `GET /listings` search results
- `POST /listings/:listingId/save` and `POST /listings/:listingId/interests` return 422 for expired listings
- Pending interest requests on expired listings become `expired` status

---

### `expiryWarning` — `src/cron/expiryWarning.js`

**Schedule:** `0 1 * * *` (01:00 daily). Override: `CRON_EXPIRY_WARNING` env var.

**What it does:** Finds active listings expiring within 7 days that have NOT already received a warning today. Inserts notification rows directly (not via BullMQ) inside a transaction with idempotency key `expiry_warning:{listing_id}:{YYYY-MM-DD}`. Uses advisory lock `pg_try_advisory_xact_lock(7001)` to prevent concurrent runs.

Post-commit: `enqueueNotification({ type: "listing_expiring" })` for each newly inserted warning.

**Idempotent:** Re-running on the same day produces no duplicates (ON CONFLICT DO NOTHING on idempotency_key).

**API impact:** Adds `listing_expiring` notification to poster's feed.

---

### `hardDeleteCleanup` — `src/cron/hardDeleteCleanup.js`

**Schedule:** `0 4 * * 0` (04:00 Sundays). Override: `CRON_HARD_DELETE` env var.

**Retention period:** `SOFT_DELETE_RETENTION_DAYS` env var (default `90`). Must be a plain decimal integer (e.g. `"90"`). Values like `"90days"` or `"-30"` fall back to 90 with a warn log.

**What it does:** Hard-deletes rows with `deleted_at < NOW() - N days` across all soft-delete tables, in dependency order to avoid FK violations:

1. `rating_reports` → 2. `ratings` → 3. `notifications` → 4. `connections` (guarded: skips if not-yet-aged rating references it) → 5. `interest_requests` → 6. `saved_listings` → 7. `listing_photos` → 8. `listings` (guarded: skips if child rows not yet aged) → 9. `verification_requests` → 10. `pg_owner_profiles` → 11. `student_profiles` → 12. `properties` (guarded) → 13. `institutions` → 14. `users` (guarded: skips if any not-yet-aged child references it)

All in one transaction. Rollback on any error.

**API impact:** Reduces DB size. Rows aged past retention are permanently unrecoverable. No direct endpoint impact.
```

---

## Summary of All Changes Required

| Finding | File(s) to change | Type of change |
| --- | --- | --- |
| 1 | `docs/api/notifications.md` | Update notification type table, add CDC pipeline section |
| 1 | `src/workers/notificationWorker.js` | Fix PLANNED→ACTIVE comments for verification types |
| 2 | `docs/api/admin.md` | Replace CDC side-effects note with full worker behavior table |
| 3 | `docs/api/auth.md` | Replace Transport Summary with full branch-semantics reference |
| 4 | `docs/api/listings.api.md` | Fix middleware chain order, add full photo upload chain + 503 path |
| 5 | `docs/api/notifications.md` | Add `isRead` accepted value details |
| 5 | `docs/api/auth.md` | Add optional body note for refresh/logout |
| 5 | `docs/api/conventions.md` | Add cursor pair rule with full endpoint list |
| 6 | `docs/api/appendix-middleware.md` | **Create new file** — full middleware → route mapping |
| 6 | `docs/api/appendix-workers-crons.md` | **Create new file** — full worker/cron → endpoint mapping |
| 6 | `docs/README.md` | Add links to new appendix files |
