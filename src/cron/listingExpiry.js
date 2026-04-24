
























import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { enqueueNotification } from "../workers/notificationQueue.js";



const SCHEDULE = process.env.CRON_LISTING_EXPIRY ?? "0 2 * * *";

const runListingExpiry = async () => {
	const startedAt = Date.now();
	logger.info("cron:listingExpiry — starting run");

	const client = await pool.connect();
	let expiredListingIds = [];

	try {
		await client.query("BEGIN");

		
		
		
		const { rows: expiredRows } = await client.query(
			`UPDATE listings
			 SET status = 'expired'::listing_status_enum,
					 updated_at = NOW()
       WHERE status     = 'active'
         AND expires_at < NOW()
         AND deleted_at IS NULL
       RETURNING listing_id, posted_by`,
		);

		expiredListingIds = expiredRows.map((r) => r.listing_id);

		if (expiredListingIds.length > 0) {
			
			
			
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

			
			
			for (const row of expiredRows) {
				enqueueNotification({
					recipientId: row.posted_by,
					type: "listing_expired",
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






export const registerListingExpiryCron = () => {
	const task = cron.schedule(SCHEDULE, () => {
		
		
		
		
		runListingExpiry().catch((err) => {
			logger.error({ err }, "cron:listingExpiry — unhandled error in job runner");
		});
	});

	logger.info({ schedule: SCHEDULE }, "cron:listingExpiry — registered");
	return task;
};
