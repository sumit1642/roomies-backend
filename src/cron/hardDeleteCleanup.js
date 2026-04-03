// src/cron/hardDeleteCleanup.js
//
// Scheduled maintenance job: permanently remove rows that have been soft-deleted
// for more than 90 days across all tables that carry a deleted_at column.
//
// ─── DESIGN NOTES ────────────────────────────────────────────────────────────
//
// Soft-delete tables in this schema (from roomies_db_setup.sql):
//   users, student_profiles, pg_owner_profiles, user_preferences,
//   verification_requests, institutions, properties, listings, listing_photos,
//   listing_preferences (via CASCADE from listings), listing_amenities (CASCADE),
//   saved_listings, interest_requests, connections, notifications,
//   ratings, rating_reports
//
// Deletion order matters because of foreign key constraints. We delete child
// rows before parent rows. The schema uses ON DELETE CASCADE on many junction
// tables, but ON DELETE RESTRICT on the core entity tables — so we must follow
// the dependency graph manually:
//
//   rating_reports → ratings (FK: rating_id)
//   ratings → connections (FK: connection_id) and users (FK: reviewer_id)
//   notifications → users (FK: recipient_id, actor_id)
//   interest_requests → listings (FK: listing_id) and users (FK: sender_id)
//   connections → interest_requests (FK), listings (FK), users (FK)
//   saved_listings → listings (FK) and users (FK)
//   listing_photos, listing_preferences, listing_amenities → listings (CASCADE, handled automatically)
//   listings → properties (FK) and users (FK)
//   verification_requests → users (FK)
//   pg_owner_profiles, student_profiles → users (FK)
//
// We run all deletes in one transaction so either all aged rows are cleaned or
// none are — no half-committed state that leaves orphaned child rows.
//
// Idempotency: the WHERE predicate (deleted_at < NOW() - INTERVAL '90 days') is
// stable. Re-running within the same 90-day window is a safe no-op.
//
// Safety note: we deliberately do NOT hard-delete users, properties, or listings
// in this job without first ensuring all their dependents are removed. The
// ordering below handles this correctly.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";

const SCHEDULE = process.env.CRON_HARD_DELETE ?? "0 4 * * 0"; // Sundays at 04:00
const RETENTION_DAYS = parseInt(process.env.SOFT_DELETE_RETENTION_DAYS ?? "90", 10);

const runHardDeleteCleanup = async () => {
	const startedAt = Date.now();
	logger.info({ retentionDays: RETENTION_DAYS }, "cron:hardDeleteCleanup — starting run");

	const client = await pool.connect();
	const results = {};

	try {
		await client.query("BEGIN");

		const cutoff = `NOW() - INTERVAL '${RETENTION_DAYS} days'`;

		// Deletion order: deepest dependents first, then work up toward root entities.

		// 1. rating_reports (depends on ratings)
		const { rowCount: rr } = await client.query(
			`DELETE FROM rating_reports WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.rating_reports = rr;

		// 2. ratings (depends on connections and users)
		const { rowCount: ra } = await client.query(
			`DELETE FROM ratings WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.ratings = ra;

		// 3. notifications (depends on users)
		const { rowCount: no } = await client.query(
			`DELETE FROM notifications WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.notifications = no;

		// 4. connections (depends on interest_requests, listings, users)
		const { rowCount: co } = await client.query(
			`DELETE FROM connections WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.connections = co;

		// 5. interest_requests (depends on listings and users)
		const { rowCount: ir } = await client.query(
			`DELETE FROM interest_requests WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.interest_requests = ir;

		// 6. saved_listings (depends on listings and users)
		const { rowCount: sl } = await client.query(
			`DELETE FROM saved_listings WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.saved_listings = sl;

		// 7. listing_photos (ON DELETE CASCADE from listings, but we also clean
		//    explicitly-soft-deleted photos that outlived their parent listing)
		const { rowCount: lp } = await client.query(
			`DELETE FROM listing_photos WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.listing_photos = lp;

		// 8. listings (depends on properties and users; cascade handles listing_preferences
		//    and listing_amenities automatically via ON DELETE CASCADE)
		const { rowCount: li } = await client.query(
			`DELETE FROM listings WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.listings = li;

		// 9. verification_requests (depends on users)
		const { rowCount: vr } = await client.query(
			`DELETE FROM verification_requests WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.verification_requests = vr;

		// 10. pg_owner_profiles and student_profiles (depend on users)
		const { rowCount: pop } = await client.query(
			`DELETE FROM pg_owner_profiles WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.pg_owner_profiles = pop;

		const { rowCount: sp } = await client.query(
			`DELETE FROM student_profiles WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.student_profiles = sp;

		// 11. user_preferences (depends on users, no deleted_at — skip)

		// 12. properties (depends on users)
		const { rowCount: pr } = await client.query(
			`DELETE FROM properties WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.properties = pr;

		// 13. institutions (no hard dependencies from other tables after above)
		const { rowCount: ins } = await client.query(
			`DELETE FROM institutions WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.institutions = ins;

		// 14. users — last, after all dependents are cleared
		const { rowCount: us } = await client.query(
			`DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`,
		);
		results.users = us;

		await client.query("COMMIT");

		const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0);

		if (totalDeleted > 0) {
			logger.info(
				{ ...results, totalDeleted, durationMs: Date.now() - startedAt },
				"cron:hardDeleteCleanup — rows permanently deleted",
			);
		} else {
			logger.debug({ durationMs: Date.now() - startedAt }, "cron:hardDeleteCleanup — no aged rows to delete");
		}
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr }, "cron:hardDeleteCleanup — rollback failed");
		}
		logger.error({ err, durationMs: Date.now() - startedAt }, "cron:hardDeleteCleanup — run failed");
	} finally {
		client.release();
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
