// src/cron/expiryWarning.js
//
// Scheduled maintenance job: send advance expiry warnings to posters whose
// active listings will expire within the next 7 days.
//
// ─── DESIGN NOTES ────────────────────────────────────────────────────────────
//
// Warning window: we notify posters when their listing will expire within 7
// days. This gives them enough lead time to renew.
//
// ─── IDEMPOTENCY — DURABLE INSERT BEFORE COMMIT ──────────────────────────────
//
// Previous design: SELECT candidate listings inside the transaction, COMMIT,
// then call enqueueNotification for each row. This created a TOCTOU window:
// two concurrent runners could both pass the NOT EXISTS check before either
// committed, then both enqueue jobs, resulting in duplicate notifications even
// though the BullMQ worker's idempotency_key ON CONFLICT prevents duplicate DB
// rows. Double-enqueuing is harmless for final correctness but wastes Redis
// resources and creates noisy log entries.
//
// Current design: for each candidate listing we INSERT a notifications row
// directly inside the transaction, using ON CONFLICT (idempotency_key) DO
// NOTHING with a deterministic key derived from the listing_id and the UTC
// calendar date. Only the rows actually inserted (rowCount contribution from
// the INSERT) are enqueued post-commit. Because the INSERT and the COMMIT are
// atomic, a concurrent runner that tries the same INSERT will hit the UNIQUE
// constraint and insert zero rows — it will enqueue nothing, which is correct.
//
// The idempotency_key format is:
//   expiry_warning:{listing_id}:{YYYY-MM-DD}
// where the date is the UTC calendar day at the time the cron runs. This means:
//   1. Exactly one notification per listing per calendar day — the 24-hour
//      NOT EXISTS window of the old design is now enforced at the unique-index
//      level rather than through a soft SELECT check.
//   2. Re-running the cron multiple times on the same day (e.g. after a crash)
//      safely produces no duplicates.
//   3. The next UTC calendar day produces a new key, so a listing expiring in
//      a future window can still be warned on a subsequent day if needed.
//
// ─── CONCURRENT-RUNNER GUARD ─────────────────────────────────────────────────
//
// We continue to hold a transaction-scoped advisory lock
// (pg_try_advisory_xact_lock) to prevent two runners from even attempting the
// SELECT + INSERT simultaneously. The advisory lock is the first line of
// defence; the UNIQUE constraint on idempotency_key is the second.
//
// WHY TRANSACTION-SCOPED AND NOT SESSION-SCOPED: see the original design notes
// above the ADVISORY_LOCK_KEY constant. Summary: transaction-scoped locks
// are released automatically on COMMIT/ROLLBACK, preventing stale lock
// retention across connection-pool reuse.
//
// ─── NOTIFICATION WORKER MESSAGE ─────────────────────────────────────────────
//
// The notifications row inserted here carries message = null. The notification
// worker's NOTIFICATION_MESSAGES map (notificationWorker.js) provides the
// human-readable text when the job is processed. Storing null here and letting
// the worker fill in the message is consistent with how all other notification
// inserts work — the message is applied at INSERT time in the worker, not here.
//
// ─── OBSERVABILITY ───────────────────────────────────────────────────────────
//
// Logs the number of warnings enqueued (rows returned by the INSERT, not just
// rows selected) so the number reflects actual new notifications, not
// re-selections of already-warned listings.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

const SCHEDULE = process.env.CRON_EXPIRY_WARNING ?? "0 1 * * *";
const WARNING_WINDOW_DAYS = 7;
const ADVISORY_LOCK_KEY = 7001; // stable key: 7001 = expiryWarning cron

// Build a deterministic idempotency key for a given listing on the current UTC
// calendar day. The key is stable for the entire day regardless of what time
// the cron fires, which prevents duplicates on re-runs within the same day.
const buildIdempotencyKey = (listingId, utcDateStr) => `expiry_warning:${listingId}:${utcDateStr}`;

const runExpiryWarning = async () => {
	const startedAt = Date.now();
	logger.info("cron:expiryWarning — starting run");

	// UTC calendar date as YYYY-MM-DD, used for idempotency key construction.
	const today = new Date().toISOString().slice(0, 10);

	const client = await pool.connect();
	try {
		// Begin the transaction BEFORE acquiring the lock.
		// pg_try_advisory_xact_lock REQUIRES an active transaction — it is bound
		// to the transaction lifecycle and released automatically on COMMIT or
		// ROLLBACK.
		await client.query("BEGIN");

		const { rows: lockRows } = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [
			ADVISORY_LOCK_KEY,
		]);

		if (!lockRows[0].acquired) {
			await client.query("ROLLBACK");
			logger.info(
				{ durationMs: Date.now() - startedAt },
				"cron:expiryWarning — advisory lock not acquired (another runner is active); skipping this tick",
			);
			return;
		}

		// Find all active listings expiring within the warning window that do not
		// already have a listing_expiring notification for today's idempotency key.
		// We filter using a direct idempotency_key match rather than a 24-hour
		// window timestamp check, so the uniqueness semantics are exact and
		// consistent with the INSERT below.
		const { rows: candidates } = await client.query(
			`SELECT l.listing_id, l.posted_by, l.expires_at
       FROM listings l
       WHERE l.status     = 'active'
         AND l.deleted_at IS NULL
         AND l.expires_at  > NOW()
         AND l.expires_at  <= NOW() + make_interval(days => $1)
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.idempotency_key = $2 || l.listing_id::text || $3
             AND n.deleted_at      IS NULL
         )`,
			[WARNING_WINDOW_DAYS, `expiry_warning:`, `:${today}`],
		);

		if (candidates.length === 0) {
			await client.query("COMMIT");
			logger.debug({ durationMs: Date.now() - startedAt }, "cron:expiryWarning — no listings approaching expiry");
			return;
		}

		// For each candidate, attempt a durable INSERT of the notification row
		// inside this transaction with the deterministic idempotency key.
		// ON CONFLICT DO NOTHING means a concurrent runner that somehow slipped
		// through the advisory lock will insert zero rows for that listing.
		// We collect only the listing_ids for which the INSERT actually succeeded
		// (i.e. the row was new) so we only enqueue jobs for those.
		const insertedListings = [];

		for (const row of candidates) {
			const key = buildIdempotencyKey(row.listing_id, today);
			const { rowCount } = await client.query(
				`INSERT INTO notifications
           (recipient_id, notification_type, entity_type, entity_id, idempotency_key)
         VALUES ($1, 'listing_expiring'::notification_type_enum, 'listing', $2, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
				[row.posted_by, row.listing_id, key],
			);

			if (rowCount === 1) {
				// Row was freshly inserted — safe to enqueue after commit.
				insertedListings.push(row);
			}
		}

		// COMMIT atomically persists all inserted notification rows and releases
		// the advisory lock. Post-commit enqueueing below is therefore safe: if
		// enqueueNotification fails for any listing, the notification row is
		// already durably stored, and the BullMQ worker will process it on the
		// next retry triggered by some other code path (or the notification will
		// remain undelivered until the next cron run, which is acceptable because
		// there are still multiple days until expiry).
		await client.query("COMMIT");

		if (insertedListings.length > 0) {
			for (const row of insertedListings) {
				enqueueNotification({
					recipientId: row.posted_by,
					type: "listing_expiring",
					entityType: "listing",
					entityId: row.listing_id,
				});
			}

			logger.info(
				{
					warningSent: insertedListings.length,
					skipped: candidates.length - insertedListings.length,
					durationMs: Date.now() - startedAt,
				},
				"cron:expiryWarning — expiry warnings enqueued",
			);
		} else {
			// All candidates already had their notification rows inserted (race
			// with another runner that committed first). Nothing to enqueue.
			logger.debug(
				{ candidateCount: candidates.length, durationMs: Date.now() - startedAt },
				"cron:expiryWarning — all candidates already warned; nothing enqueued",
			);
		}
	} catch (err) {
		// ROLLBACK releases the advisory lock if it was acquired.
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr }, "cron:expiryWarning — rollback failed");
		}
		logger.error({ err, durationMs: Date.now() - startedAt }, "cron:expiryWarning — run failed");
	} finally {
		// No pg_advisory_unlock call needed — the transaction ending handles it.
		client.release();
	}
};

export const registerExpiryWarningCron = () => {
	const task = cron.schedule(SCHEDULE, () => {
		runExpiryWarning().catch((err) => {
			logger.error({ err }, "cron:expiryWarning — unhandled error in job runner");
		});
	});

	logger.info({ schedule: SCHEDULE }, "cron:expiryWarning — registered");
	return task;
};
