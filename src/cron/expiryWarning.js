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
// Idempotency: the NOT EXISTS subquery checks for a listing_expiring notification
// in the last 24 hours, preventing duplicate messages per listing per day.
//
// Concurrent-runner guard: even with the NOT EXISTS check, two concurrent cron
// runners can both read the candidate set before either commits a notification —
// the classic TOCTOU race. We prevent this with a session-level advisory lock
// (`pg_try_advisory_lock`). Because the lock is session-scoped, it is released
// automatically when the pooled connection is returned, so there is no risk of
// a lock leak if the job crashes mid-run. If a second runner cannot acquire the
// lock it simply exits early — the first runner is already doing the work.
//
// The advisory lock key (7001) is an arbitrary stable integer chosen to avoid
// collision with any other advisory lock used in this codebase. Document it
// here: 7001 = expiryWarning cron.
//
// Observability: logs the number of warnings sent on each run.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

const SCHEDULE = process.env.CRON_EXPIRY_WARNING ?? "0 1 * * *";
const WARNING_WINDOW_DAYS = 7;
const ADVISORY_LOCK_KEY = 7001; // stable key: 7001 = expiryWarning cron

const runExpiryWarning = async () => {
	const startedAt = Date.now();
	logger.info("cron:expiryWarning — starting run");

	const client = await pool.connect();
	try {
		// Attempt to acquire a session-level advisory lock. If another instance of
		// this cron is already running, pg_try_advisory_lock returns false and we
		// exit immediately — the other runner handles this tick. The lock is
		// automatically released when the client is returned to the pool.
		const { rows: lockRows } = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [
			ADVISORY_LOCK_KEY,
		]);

		if (!lockRows[0].acquired) {
			logger.info(
				{ durationMs: Date.now() - startedAt },
				"cron:expiryWarning — advisory lock not acquired (another runner is active); skipping this tick",
			);
			return;
		}

		// Find all active listings expiring within the warning window that have NOT
		// already received a listing_expiring notification in the last 24 hours.
		const { rows } = await client.query(
			`SELECT l.listing_id, l.posted_by, l.expires_at
       FROM listings l
       WHERE l.status     = 'active'
         AND l.deleted_at IS NULL
         AND l.expires_at  > NOW()
         AND l.expires_at  <= NOW() + INTERVAL '${WARNING_WINDOW_DAYS} days'
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.entity_id         = l.listing_id
             AND n.entity_type       = 'listing'
             AND n.notification_type = 'listing_expiring'
             AND n.created_at        > NOW() - INTERVAL '24 hours'
             AND n.deleted_at        IS NULL
         )`,
		);

		if (rows.length > 0) {
			for (const row of rows) {
				enqueueNotification({
					recipientId: row.posted_by,
					type: "listing_expiring",
					entityType: "listing",
					entityId: row.listing_id,
				});
			}

			logger.info(
				{
					warningSent: rows.length,
					durationMs: Date.now() - startedAt,
				},
				"cron:expiryWarning — expiry warnings enqueued",
			);
		} else {
			logger.debug({ durationMs: Date.now() - startedAt }, "cron:expiryWarning — no listings approaching expiry");
		}
	} catch (err) {
		logger.error({ err, durationMs: Date.now() - startedAt }, "cron:expiryWarning — run failed");
	} finally {
		// Releasing the client back to the pool implicitly releases the
		// session-level advisory lock — no explicit unlock needed.
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
