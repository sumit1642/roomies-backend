// src/cron/listingExpiry.js
//
// Scheduled maintenance job: expire active listings whose expires_at timestamp
// has passed.
//
// ─── DESIGN NOTES ────────────────────────────────────────────────────────────
//
// Idempotency: the UPDATE predicate (status = 'active' AND expires_at < NOW())
// means re-running this job any number of times produces the same result — rows
// already transitioned to 'expired' do not match and are not touched.
//
// Observability: every run logs how many rows were affected. Zero-row runs are
// logged at debug level so they appear in verbose mode without cluttering
// production dashboards. Runs that expire rows are logged at info level.
//
// Pending request cleanup: when a listing expires, any still-pending interest
// requests on it become permanently unreachable — the listing cannot be
// re-activated from 'expired' state. We expire those requests in the same
// transaction so the DB is always consistent: no pending request points at
// an expired listing after this job runs.
//
// Notification: after the transaction commits we enqueue listing_expiring
// notifications for the affected posters. Using the shared enqueueNotification
// helper means a Redis failure never rolls back the DB state change.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

// How often this job runs. '0 2 * * *' = 02:00 every night in the server's
// local timezone. Adjust via the CRON_LISTING_EXPIRY env var if needed.
const SCHEDULE = process.env.CRON_LISTING_EXPIRY ?? "0 2 * * *";

const runListingExpiry = async () => {
	const startedAt = Date.now();
	logger.info("cron:listingExpiry — starting run");

	const client = await pool.connect();
	let expiredListingIds = [];

	try {
		await client.query("BEGIN");

		// Transition all active, past-expiry listings to 'expired' in one statement.
		// RETURNING captures the listing_id and posted_by values we need for the
		// interest-request cleanup and notifications below — no second query needed.
		const { rows: expiredRows } = await client.query(
			`UPDATE listings
       SET status = 'expired'::listing_status_enum
       WHERE status     = 'active'
         AND expires_at < NOW()
         AND deleted_at IS NULL
       RETURNING listing_id, posted_by`,
		);

		expiredListingIds = expiredRows.map((r) => r.listing_id);

		if (expiredListingIds.length > 0) {
			// Bulk-expire all pending interest requests across every newly-expired
			// listing. Using ANY($1::uuid[]) lets us do this in one query instead of
			// N queries, which is important when many listings expire at once.
			const { rowCount: requestsExpired } = await client.query(
				`UPDATE interest_requests
         SET status = 'expired'::request_status_enum, updated_at = NOW()
         WHERE listing_id = ANY($1::uuid[])
           AND status     = 'pending'
           AND deleted_at IS NULL`,
				[expiredListingIds],
			);

			logger.info(
				{
					expiredListings: expiredListingIds.length,
					expiredRequests: requestsExpired,
					durationMs: Date.now() - startedAt,
				},
				"cron:listingExpiry — listings expired",
			);

			await client.query("COMMIT");

			// Post-commit: notify each affected poster. Fire-and-forget — a Redis
			// hiccup must not trigger a rollback of the DB state we just committed.
			for (const row of expiredRows) {
				enqueueNotification({
					recipientId: row.posted_by,
					type: "listing_expiring", // closest available type for "has now expired"
					entityType: "listing",
					entityId: row.listing_id,
				});
			}
		} else {
			await client.query("COMMIT");
			logger.debug({ durationMs: Date.now() - startedAt }, "cron:listingExpiry — no listings to expire");
		}
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr }, "cron:listingExpiry — rollback failed");
		}
		logger.error({ err, durationMs: Date.now() - startedAt }, "cron:listingExpiry — run failed");
	} finally {
		client.release();
	}
};

// ─── Register the cron schedule ───────────────────────────────────────────────
//
// Returns the scheduled task so server.js can call task.stop() during graceful
// shutdown. node-cron tasks hold no async work open after stop(), so they do
// not need to be awaited during shutdown — stop() is synchronous.
export const registerListingExpiryCron = () => {
	const task = cron.schedule(SCHEDULE, () => {
		// We intentionally do not await the promise here. node-cron fires the
		// callback synchronously on each tick; if we were to block the tick we
		// would prevent the scheduler from firing other jobs. The async work runs
		// in the background and logs its own completion/failure.
		runListingExpiry().catch((err) => {
			logger.error({ err }, "cron:listingExpiry — unhandled error in job runner");
		});
	});

	logger.info({ schedule: SCHEDULE }, "cron:listingExpiry — registered");
	return task;
};
