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

- If photo row was soft-deleted before processing completed: deletes the already-uploaded permanent file, skips DB
  update
- `storageService.upload` timeout (30s): throws `AppError 504`, job fails -> BullMQ retries (max 3 attempts)
- Stage file cleanup failures: logged as warn, does not fail the job

**Affects these endpoint-visible states:**

- `GET /listings/:listingId/photos` — photo becomes visible only after worker sets real URL (placeholder
  `processing:{photoId}` is filtered out)
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

- `auth.service.js` -> `sendOtp()` — triggers on `POST /auth/otp/send`
- `verificationEventWorker.js` — all three verification event types

**Handlers:**

| Job type                | Email function                    | Triggered by            |
| ----------------------- | --------------------------------- | ----------------------- |
| `otp`                   | `sendOtpEmail()`                  | `POST /auth/otp/send`   |
| `verification_approved` | `sendVerificationApprovedEmail()` | verificationEventWorker |
| `verification_rejected` | `sendVerificationRejectedEmail()` | verificationEventWorker |
| `verification_pending`  | `sendVerificationPendingEmail()`  | verificationEventWorker |

Unknown job type: logged at warn level, job marked complete without sending.

---

### `verificationEventWorker` — `src/workers/verificationEventWorker.js`

**Type:** Not BullMQ — `setInterval` polling loop

**Poll interval:** 5 seconds

**Batch size:** 10 events per cycle

**Max attempts per event:** 5

**Triggered by:** Postgres trigger `trg_verification_status_changed` which fires on
`AFTER UPDATE OF status ON verification_requests`

**API routes that can trigger the trigger:**

- `POST /admin/verification-queue/:requestId/approve` -> `verification.service.approveRequest()`
- `POST /admin/verification-queue/:requestId/reject` -> `verification.service.rejectRequest()`
- `POST /pg-owners/:userId/documents` -> `verification.service.submitDocument()` -> sets status to `pending`

**Also triggered by:** Any direct SQL UPDATE on `verification_requests.status` (migration scripts, admin psql sessions)

**Actions per event:**

- `verification_approved`: correct `pg_owner_profiles.verification_status` if needed -> `enqueueNotification` +
  `enqueueEmail`
- `verification_rejected`: correct profile status -> `enqueueNotification` + `enqueueEmail`
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

**What it does:** Finds active listings expiring within 7 days that have NOT already received a warning today. Inserts
notification rows directly (not via BullMQ) inside a transaction with idempotency key
`expiry_warning:{listing_id}:{YYYY-MM-DD}`. Uses advisory lock `pg_try_advisory_xact_lock(7001)` to prevent concurrent
runs.

Post-commit: `enqueueNotification({ type: "listing_expiring" })` for each newly inserted warning.

**Idempotent:** Re-running on the same day produces no duplicates (ON CONFLICT DO NOTHING on idempotency_key).

**API impact:** Adds `listing_expiring` notification to poster's feed.

---

### `hardDeleteCleanup` — `src/cron/hardDeleteCleanup.js`

**Schedule:** `0 4 * * 0` (04:00 Sundays). Override: `CRON_HARD_DELETE` env var.

**Retention period:** `SOFT_DELETE_RETENTION_DAYS` env var (default `90`). Must be a plain decimal integer (for example
`"90"`). Values like `"90days"` or `"-30"` fall back to 90 with a warn log.

**What it does:** Hard-deletes rows with `deleted_at < NOW() - N days` across all soft-delete tables, in dependency
order to avoid FK violations:

1. `rating_reports` -> 2. `ratings` -> 3. `notifications` -> 4. `connections` (guarded: skips if not-yet-aged rating
   references it) -> 5. `interest_requests` -> 6. `saved_listings` -> 7. `listing_photos` -> 8. `listings` (guarded:
   skips if child rows not yet aged) -> 9. `verification_requests` -> 10. `pg_owner_profiles` -> 11. `student_profiles`
   -> 12. `properties` (guarded) -> 13. `institutions` -> 14. `users` (guarded: skips if any not-yet-aged child
   references it)

All in one transaction. Rollback on any error.

**API impact:** Reduces DB size. Rows aged past retention are permanently unrecoverable. No direct endpoint impact.
