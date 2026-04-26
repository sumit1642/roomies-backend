import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { storageService } from "../storage/index.js";

const SCHEDULE = process.env.CRON_HARD_DELETE ?? "0 4 * * 0";
const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;

const _envRetention = process.env.SOFT_DELETE_RETENTION_DAYS;
const _trimmed = typeof _envRetention === "string" ? _envRetention.trim() : undefined;
const STRICT_DECIMAL_INTEGER_RE = /^[0-9]+$/;

let RETENTION_DAYS;

if (_trimmed === undefined || _trimmed === "") {
	logger.debug(
		{ fallback: DEFAULT_RETENTION_DAYS },
		`cron:hardDeleteCleanup — SOFT_DELETE_RETENTION_DAYS not set; using default of ${DEFAULT_RETENTION_DAYS} days`,
	);
	RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
} else if (!STRICT_DECIMAL_INTEGER_RE.test(_trimmed)) {
	logger.warn(
		{
			provided: _envRetention,
			trimmed: _trimmed,
			fallback: DEFAULT_RETENTION_DAYS,
			validRange: `${MIN_RETENTION_DAYS}–${MAX_RETENTION_DAYS}`,
			hint: "Must be a plain decimal integer with no prefix, suffix, or sign (e.g. '90')",
		},
		`cron:hardDeleteCleanup — SOFT_DELETE_RETENTION_DAYS="${_envRetention}" is not a plain decimal integer; ` +
			`falling back to ${DEFAULT_RETENTION_DAYS} days`,
	);
	RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
} else {
	const _parsed = Number(_trimmed);

	if (!Number.isFinite(_parsed) || _parsed < MIN_RETENTION_DAYS || _parsed > MAX_RETENTION_DAYS) {
		logger.warn(
			{
				provided: _envRetention,
				parsed: _parsed,
				fallback: DEFAULT_RETENTION_DAYS,
				validRange: `${MIN_RETENTION_DAYS}–${MAX_RETENTION_DAYS}`,
			},
			`cron:hardDeleteCleanup — SOFT_DELETE_RETENTION_DAYS="${_envRetention}" is out of the valid range ` +
				`(${MIN_RETENTION_DAYS}–${MAX_RETENTION_DAYS}); falling back to ${DEFAULT_RETENTION_DAYS} days`,
		);
		RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
	} else {
		RETENTION_DAYS = _parsed;
	}
}

const runHardDeleteCleanup = async () => {
	const startedAt = Date.now();
	logger.info({ retentionDays: RETENTION_DAYS }, "cron:hardDeleteCleanup — starting run");

	let client;
	const results = {};

	try {
		client = await pool.connect();
		await client.query("BEGIN");

		const cutoffExpr = `NOW() - ($1::int * INTERVAL '1 day')`;
		const p = [RETENTION_DAYS];

		const { rowCount: rr } = await client.query(
			`DELETE FROM rating_reports
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.rating_reports = rr;

		const { rowCount: ra } = await client.query(
			`DELETE FROM ratings
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.ratings = ra;

		const { rowCount: no } = await client.query(
			`DELETE FROM notifications
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.notifications = no;

		const { rowCount: co } = await client.query(
			`DELETE FROM connections
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}
         AND NOT EXISTS (
           SELECT 1 FROM ratings ra
           WHERE ra.connection_id = connections.connection_id
             AND (ra.deleted_at IS NULL OR ra.deleted_at >= ${cutoffExpr})
         )`,
			p,
		);
		results.connections = co;

		const { rowCount: ir } = await client.query(
			`DELETE FROM interest_requests
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.interest_requests = ir;

		const { rowCount: sl } = await client.query(
			`DELETE FROM saved_listings
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.saved_listings = sl;

		const { rowCount: lp } = await client.query(
			`DELETE FROM listing_photos
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.listing_photos = lp;

		const { rowCount: li } = await client.query(
			`DELETE FROM listings
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}
         AND NOT EXISTS (
           SELECT 1 FROM interest_requests ir
           WHERE ir.listing_id  = listings.listing_id
             AND ir.deleted_at  IS NOT NULL
             AND ir.deleted_at  >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM connections co
           WHERE co.listing_id  = listings.listing_id
             AND co.deleted_at  IS NOT NULL
             AND co.deleted_at  >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM saved_listings sl
           WHERE sl.listing_id  = listings.listing_id
             AND sl.deleted_at  IS NOT NULL
             AND sl.deleted_at  >= ${cutoffExpr}
         )`,

			p,
		);
		results.listings = li;

		const { rowCount: vr } = await client.query(
			`DELETE FROM verification_requests
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.verification_requests = vr;

		const { rowCount: pop } = await client.query(
			`DELETE FROM pg_owner_profiles
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.pg_owner_profiles = pop;

		const { rows: photoRows } = await client.query(
			`SELECT profile_photo_url FROM student_profiles
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}
         AND profile_photo_url IS NOT NULL`,
			p,
		);

		const { rowCount: sp } = await client.query(
			`DELETE FROM student_profiles
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.student_profiles = sp;

		for (const { profile_photo_url } of photoRows) {
			try {
				await storageService.delete(profile_photo_url);
			} catch (storageErr) {
				logger.error(
					{ storageErr, profile_photo_url },
					"cron:hardDeleteCleanup — failed to delete profile photo blob",
				);
			}
		}

		const { rowCount: pr } = await client.query(
			`DELETE FROM properties
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}
         AND NOT EXISTS (
           SELECT 1 FROM listings li
           WHERE li.property_id = properties.property_id
             AND li.deleted_at  IS NOT NULL
             AND li.deleted_at  >= ${cutoffExpr}
         )`,
			p,
		);
		results.properties = pr;

		const { rowCount: ins } = await client.query(
			`DELETE FROM institutions
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.institutions = ins;

		const { rowCount: us } = await client.query(
			`DELETE FROM users
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}
         AND NOT EXISTS (
           SELECT 1 FROM connections co
           WHERE (co.initiator_id = users.user_id OR co.counterpart_id = users.user_id)
             AND co.deleted_at  IS NOT NULL
             AND co.deleted_at  >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM interest_requests ir
           WHERE ir.sender_id   = users.user_id
             AND ir.deleted_at  IS NOT NULL
             AND ir.deleted_at  >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM ratings ra
           WHERE ra.reviewer_id = users.user_id
             AND ra.deleted_at  IS NOT NULL
             AND ra.deleted_at  >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM notifications nt
           WHERE nt.recipient_id = users.user_id
             AND nt.deleted_at   IS NOT NULL
             AND nt.deleted_at   >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM verification_requests vr
           WHERE vr.user_id    = users.user_id
             AND vr.deleted_at IS NOT NULL
             AND vr.deleted_at >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM student_profiles sp
           WHERE sp.user_id    = users.user_id
             AND sp.deleted_at IS NOT NULL
             AND sp.deleted_at >= ${cutoffExpr}
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_owner_profiles pop
           WHERE pop.user_id   = users.user_id
             AND pop.deleted_at IS NOT NULL
             AND pop.deleted_at >= ${cutoffExpr}
         )`,
			p,
		);
		results.users = us;

		await client.query("COMMIT");

		const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0);

		if (totalDeleted > 0) {
			logger.info(
				{ ...results, totalDeleted, retentionDays: RETENTION_DAYS, durationMs: Date.now() - startedAt },
				"cron:hardDeleteCleanup — rows permanently deleted",
			);
		} else {
			logger.debug(
				{ retentionDays: RETENTION_DAYS, durationMs: Date.now() - startedAt },
				"cron:hardDeleteCleanup — no aged rows to delete",
			);
		}
	} catch (err) {
		if (client) {
			try {
				await client.query("ROLLBACK");
			} catch (rollbackErr) {
				logger.error({ rollbackErr }, "cron:hardDeleteCleanup — rollback failed");
			}
		}
		logger.error(
			{ err, retentionDays: RETENTION_DAYS, durationMs: Date.now() - startedAt },
			"cron:hardDeleteCleanup — run failed",
		);
	} finally {
		if (client) {
			client.release();
		}
	}
};

export const registerHardDeleteCleanupCron = () => {
	const task = cron.schedule(SCHEDULE, () => {
		runHardDeleteCleanup().catch((err) => {
			logger.error({ err }, "cron:hardDeleteCleanup — unhandled error in job runner");
		});
	});

	logger.info({ schedule: SCHEDULE, retentionDays: RETENTION_DAYS }, "cron:hardDeleteCleanup — registered");
	return task;
};
