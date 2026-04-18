// src/cron/hardDeleteCleanup.js
//
// Scheduled maintenance job: permanently remove rows that have been soft-deleted
// for more than N days across all tables that carry a deleted_at column.
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
//   listing_photos, listing_preferences, listing_amenities → listings (CASCADE)
//   listings → properties (FK) and users (FK)
//   verification_requests → users (FK)
//   pg_owner_profiles, student_profiles → users (FK)
//
// ─── THE FK-VIOLATION PROBLEM AND ITS FIX ────────────────────────────────────
//
// A naive "delete children before parents" approach has a critical gap:
// the WHERE clause `deleted_at < cutoff` creates a temporal window where a
// soft-deleted child that hasn't yet aged past the retention window will NOT be
// deleted in the children step, but will still block its parent's hard-delete
// via ON DELETE RESTRICT FK constraint.
//
// Concrete scenario:
//   - user soft-deleted 100 days ago → eligible for hard-delete (past 90-day cutoff)
//   - connection soft-deleted 30 days ago → NOT eligible (hasn't reached cutoff)
//   - Step 4 skips the connection (deleted_at < cutoff = false)
//   - Step 14 tries to DELETE FROM users → PostgreSQL raises 23503 (FK violation)
//     because the connection still references the user → entire transaction rolls back
//
// The fix: each parent-table DELETE includes NOT EXISTS guards that check whether
// any soft-deleted (but not yet aged) child row still references the parent.
// If so, the parent is skipped — it will be cleaned up in a future run once all
// its children have also aged past the retention cutoff.
//
// ─── CONNECTIONS → RATINGS FK GUARD ─────────────────────────────────────────
//
// ratings.connection_id references connections.connection_id ON DELETE RESTRICT.
// Step 2 hard-deletes aged ratings, but a connection aged enough for hard-delete
// may still have a recently-soft-deleted (not-yet-aged) rating referencing it.
// Without a guard, Step 4 (DELETE connections) would be blocked by that rating
// and the entire transaction would roll back.
//
// Fix: Step 4's DELETE skips any connection that still has a not-yet-aged
// soft-deleted rating (i.e. a rating whose deleted_at >= cutoff OR is NULL).
//
// ─── ALIAS NAMING ────────────────────────────────────────────────────────────
//
// PostgreSQL treats `no` as an unreserved keyword (used in NO ACTION, NO MAXVALUE
// etc.) and it is legal as an alias in most contexts. However, using reserved or
// near-reserved words as aliases is error-prone and confusing to human readers.
// The notifications alias is renamed to `nt` throughout this file for clarity.
//
// ─── RETENTION VALIDATION ────────────────────────────────────────────────────
//
// SOFT_DELETE_RETENTION_DAYS is validated at module load time (fail-fast pattern).
// The strict parse (/^[0-9]+$/ before numeric conversion) intentionally rejects
// values like "90days", "-30", "1e2" that parseInt() would silently accept.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";

const SCHEDULE = process.env.CRON_HARD_DELETE ?? "0 4 * * 0"; // Sundays at 04:00
const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650; // ~10 years

// ─── Strict retention parsing (runs at module load, not per tick) ─────────────
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

		// The cutoff expression: rows older than this timestamp are eligible.
		// Passed as a parameter so the query plan is stable across runs and
		// there is no possibility of SQL injection from env vars.
		const cutoffExpr = `NOW() - ($1::int * INTERVAL '1 day')`;
		const p = [RETENTION_DAYS];

		// ── Step 1: rating_reports (depends on ratings) ───────────────────────
		// No children reference rating_reports directly, so no guard needed.
		const { rowCount: rr } = await client.query(
			`DELETE FROM rating_reports
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.rating_reports = rr;

		// ── Step 2: ratings (depends on connections and users) ────────────────
		// rating_reports rows that reference this rating were deleted in step 1.
		// No other ON DELETE RESTRICT child references ratings directly.
		const { rowCount: ra } = await client.query(
			`DELETE FROM ratings
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.ratings = ra;

		// ── Step 3: notifications (depends on users) ──────────────────────────
		// No children reference notifications. Alias 'nt' used (not 'no') to
		// avoid ambiguity with PostgreSQL's unreserved keyword NO.
		const { rowCount: no } = await client.query(
			`DELETE FROM notifications
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.notifications = no;

		// ── Step 4: connections (depends on interest_requests, listings, users) ─
		//
		// ratings.connection_id ON DELETE RESTRICT means we must NOT hard-delete a
		// connection if a not-yet-aged rating still references it. Step 2 removed
		// aged ratings, but a rating soft-deleted recently (deleted_at >= cutoff)
		// or not yet soft-deleted (deleted_at IS NULL) still holds the FK.
		//
		// Guard A (ratings): skip connections that still have a live or recently
		// soft-deleted rating. We check both NULL (not soft-deleted) and
		// recent (deleted_at >= cutoff) to cover every RESTRICT scenario.
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

		// ── Step 5: interest_requests (depends on listings and users) ─────────
		// connections that reference this interest_request were deleted in step 4.
		const { rowCount: ir } = await client.query(
			`DELETE FROM interest_requests
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.interest_requests = ir;

		// ── Step 6: saved_listings (depends on listings and users) ────────────
		const { rowCount: sl } = await client.query(
			`DELETE FROM saved_listings
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.saved_listings = sl;

		// ── Step 7: listing_photos (soft-deleted photos outliving their listing) ─
		const { rowCount: lp } = await client.query(
			`DELETE FROM listing_photos
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.listing_photos = lp;

		// ── Step 8: listings ──────────────────────────────────────────────────
		// Cascade handles listing_preferences and listing_amenities automatically.
		//
		// GUARD: Only delete a listing when no soft-deleted-but-not-yet-aged child
		// rows still reference it via ON DELETE RESTRICT.
		//
		// Children that use ON DELETE RESTRICT on listings:
		//   - interest_requests (listing_id) — deleted in step 5 if aged, otherwise block
		//   - connections (listing_id) — deleted in step 4 if aged, otherwise block
		//   - saved_listings (listing_id) — deleted in step 6 if aged, otherwise block
		//
		// The NOT EXISTS guards check for soft-deleted children that have NOT yet
		// reached the cutoff — those will block a FK delete and must skip this parent.
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
			// We need the cutoff twice in the same query (for the outer WHERE and for
			// each NOT EXISTS). PostgreSQL allows referencing $1 multiple times in the
			// same parameterized query — each occurrence refers to the same value.
			p,
		);
		results.listings = li;

		// ── Step 9: verification_requests (depends on users) ──────────────────
		const { rowCount: vr } = await client.query(
			`DELETE FROM verification_requests
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.verification_requests = vr;

		// ── Step 10: pg_owner_profiles and student_profiles ───────────────────
		// These depend on users. No other ON DELETE RESTRICT children reference them.
		const { rowCount: pop } = await client.query(
			`DELETE FROM pg_owner_profiles
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.pg_owner_profiles = pop;

		const { rowCount: sp } = await client.query(
			`DELETE FROM student_profiles
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.student_profiles = sp;

		// ── Step 11: properties ───────────────────────────────────────────────
		//
		// GUARD: Only delete a property when no soft-deleted-but-not-yet-aged
		// listing still references it (listings.property_id ON DELETE RESTRICT).
		//
		// Note: ratings with reviewee_type = 'property' are polymorphic — they
		// reference property_id in the ratings.reviewee_id column, but this is NOT
		// a FK constraint in the schema (polymorphic references cannot use standard
		// FKs). So ratings do not block property deletion at the DB level.
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

		// ── Step 12: institutions ─────────────────────────────────────────────
		// student_profiles references institutions via ON DELETE SET NULL, so
		// institutions have no RESTRICT children after the profiles are cleaned.
		const { rowCount: ins } = await client.query(
			`DELETE FROM institutions
       WHERE deleted_at IS NOT NULL
         AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.institutions = ins;

		// ── Step 13: users — last, after all dependents are cleared ───────────
		//
		// GUARD: Only delete a user when no soft-deleted-but-not-yet-aged child
		// rows still reference it via ON DELETE RESTRICT.
		//
		// Children that use ON DELETE RESTRICT on users (after all cascades):
		//   - connections (initiator_id, counterpart_id)
		//   - interest_requests (sender_id)
		//   - ratings (reviewer_id)
		//   - notifications (recipient_id) — actor_id is SET NULL so only
		//     recipient_id is RESTRICT; alias 'nt' used (not 'no')
		//   - verification_requests (user_id)
		//   - student_profiles (user_id)
		//   - pg_owner_profiles (user_id)
		//
		// Steps 1–10 cleared the aged children. The NOT EXISTS guards here protect
		// against recently soft-deleted children that haven't aged past the cutoff.
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
