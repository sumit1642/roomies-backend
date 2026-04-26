// src/cron/rentIndexRefresh.js
//
// Nightly job that recomputes p25/p50/p75 in rent_index from the last
// WINDOW_DAYS of rent_observations.
//
// Two passes per run:
//   1. Locality-level rows (city + locality + room_type), minimum 3 observations.
//   2. City-wide fallback rows (city + NULL locality + room_type), minimum 5.
//
// Uses pg_try_advisory_xact_lock so only one instance runs when the
// server is horizontally scaled (same pattern as expiryWarning.js).

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";

const SCHEDULE = process.env.CRON_RENT_INDEX ?? "0 3 * * *";
const ADVISORY_LOCK_KEY = 7002;
const WINDOW_DAYS = 180;
const MIN_SAMPLE_LOCALITY = 3;
const MIN_SAMPLE_CITY = 5;

const runRentIndexRefresh = async () => {
	const startedAt = Date.now();
	logger.info("cron:rentIndexRefresh — starting run");

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
				"cron:rentIndexRefresh — advisory lock not acquired (another runner active); skipping",
			);
			return;
		}

		// Pass 1 — locality-level rows
		const { rowCount: localityRows } = await client.query(
			`INSERT INTO rent_index (city, locality, room_type, p25, p50, p75, sample_count, computed_at)
       SELECT
         city,
         locality,
         room_type,
         ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY rent_per_month))::int,
         ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY rent_per_month))::int,
         ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY rent_per_month))::int,
         COUNT(*)::int,
         NOW()
       FROM rent_observations
       WHERE observed_at > NOW() - ($1::int * INTERVAL '1 day')
         AND locality IS NOT NULL
         AND locality <> ''
       GROUP BY city, locality, room_type
       HAVING COUNT(*) >= $2
       ON CONFLICT (city, locality, room_type)
       DO UPDATE SET
         p25          = EXCLUDED.p25,
         p50          = EXCLUDED.p50,
         p75          = EXCLUDED.p75,
         sample_count = EXCLUDED.sample_count,
         computed_at  = EXCLUDED.computed_at`,
			[WINDOW_DAYS, MIN_SAMPLE_LOCALITY],
		);

		// Pass 2 — city-wide fallback rows (locality IS NULL)
		// The unique constraint uses (city, locality, room_type) and locality IS NULL,
		// so we need a NULL-safe upsert. PostgreSQL unique constraints treat NULLs as
		// distinct, so we use a partial unique index defined in the migration instead.
		// We work around this by first deleting stale city-wide rows then reinserting.
		await client.query(`DELETE FROM rent_index WHERE locality IS NULL`);

		const { rowCount: cityRows } = await client.query(
			`INSERT INTO rent_index (city, locality, room_type, p25, p50, p75, sample_count, computed_at)
       SELECT
         city,
         NULL AS locality,
         room_type,
         ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY rent_per_month))::int,
         ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY rent_per_month))::int,
         ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY rent_per_month))::int,
         COUNT(*)::int,
         NOW()
       FROM rent_observations
       WHERE observed_at > NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY city, room_type
       HAVING COUNT(*) >= $2`,
			[WINDOW_DAYS, MIN_SAMPLE_CITY],
		);

		await client.query("COMMIT");

		logger.info(
			{
				localityRowsUpserted: localityRows,
				cityRowsInserted: cityRows,
				windowDays: WINDOW_DAYS,
				durationMs: Date.now() - startedAt,
			},
			"cron:rentIndexRefresh — run complete",
		);
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr }, "cron:rentIndexRefresh — rollback failed");
		}
		logger.error({ err, durationMs: Date.now() - startedAt }, "cron:rentIndexRefresh — run failed");
	} finally {
		client.release();
	}
};

export const registerRentIndexRefreshCron = () => {
	const task = cron.schedule(SCHEDULE, () => {
		runRentIndexRefresh().catch((err) => {
			logger.error({ err }, "cron:rentIndexRefresh — unhandled error in job runner");
		});
	});

	logger.info({ schedule: SCHEDULE }, "cron:rentIndexRefresh — registered");
	return task;
};
