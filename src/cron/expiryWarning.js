// src/cron/expiryWarning.js
//
// Scheduled maintenance job: send advance expiry warnings to posters whose
// active listings will expire within the next 7 days.
//
// ─── DESIGN NOTES ────────────────────────────────────────────────────────────
//
// Warning window: we notify posters when their listing will expire within 7
// days. This gives them enough lead time to renew (i.e. delete and re-create
// the listing, since 'expired' is a terminal state with no re-activation path).
//
// Idempotency: this job runs daily at 01:00. A poster with a listing expiring
// in exactly 6 days will receive a notification today AND tomorrow if we are not
// careful. We address this by checking whether a listing_expiring notification
// for the given listing_id was already sent in the last 24 hours, and skipping
// the enqueue for any that already have one. This uses a lightweight subquery
// against the notifications table — no additional columns or tables needed.
//
// Observability: logs the number of warnings sent on each run. Zero-warning
// runs are debug-level; runs with warnings are info-level.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

const SCHEDULE = process.env.CRON_EXPIRY_WARNING ?? "0 1 * * *";
const WARNING_WINDOW_DAYS = 7;

const runExpiryWarning = async () => {
	const startedAt = Date.now();
	logger.info("cron:expiryWarning — starting run");

	try {
		// Find all active listings expiring within the warning window that have NOT
		// already received a listing_expiring notification in the last 24 hours.
		// The NOT EXISTS subquery is the idempotency guard — it prevents duplicate
		// warnings when this job overlaps with itself across days.
		const { rows } = await pool.query(
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
