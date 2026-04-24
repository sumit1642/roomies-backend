

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

const SCHEDULE = process.env.CRON_EXPIRY_WARNING ?? "0 1 * * *";
const WARNING_WINDOW_DAYS = 7;
const ADVISORY_LOCK_KEY = 7001; 




const buildIdempotencyKey = (listingId, utcDateStr) => `expiry_warning:${listingId}:${utcDateStr}`;

const runExpiryWarning = async () => {
	const startedAt = Date.now();
	logger.info("cron:expiryWarning — starting run");

	
	const today = new Date().toISOString().slice(0, 10);

	const client = await pool.connect();
	try {
		
		
		
		
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
				
				insertedListings.push(row);
			}
		}

		
		
		
		
		
		
		
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
			
			
			logger.debug(
				{ candidateCount: candidates.length, durationMs: Date.now() - startedAt },
				"cron:expiryWarning — all candidates already warned; nothing enqueued",
			);
		}
	} catch (err) {
		
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr }, "cron:expiryWarning — rollback failed");
		}
		logger.error({ err, durationMs: Date.now() - startedAt }, "cron:expiryWarning — run failed");
	} finally {
		
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
