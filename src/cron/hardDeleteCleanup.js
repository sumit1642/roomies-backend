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
//   listing_photos, listing_preferences, listing_amenities → listings (CASCADE, handled automatically)
//   listings → properties (FK) and users (FK)
//   verification_requests → users (FK)
//   pg_owner_profiles, student_profiles → users (FK)
//
// We run all deletes in one transaction so either all aged rows are cleaned or
// none are — no half-committed state that leaves orphaned child rows.
//
// Idempotency: the WHERE predicate (deleted_at < cutoff) is stable. Re-running
// within the same window is a safe no-op.
//
// Safety note: we deliberately do NOT hard-delete users, properties, or listings
// in this job without first ensuring all their dependents are removed. The
// ordering below handles this correctly.
//
// ─── RETENTION VALIDATION ────────────────────────────────────────────────────
//
// SOFT_DELETE_RETENTION_DAYS is validated at module load time (fail-fast pattern)
// rather than lazily at the first cron tick. The reasons:
//
//   1. An invalid value (e.g. the string "abc") would produce SQL like
//      `NOW() - ('NaN' * INTERVAL '1 day')` which is a runtime Postgres error on
//      every single cron tick, filling logs with noise and never cleaning anything.
//
//   2. A negative value (e.g. "-1") would make the cutoff move into the future
//      (NOW() - (-1 day) = tomorrow), causing the WHERE clause to match recently
//      soft-deleted rows and hard-deleting them far too soon.
//
//   3. A zero value would hard-delete rows immediately upon soft-deletion, which
//      is never the intended behaviour.
//
// The valid range is 1..3650 (one day to ten years). Values outside this range
// fall back to the safe default of 90 days with a warning log rather than
// crashing the server — hard-delete cleanup is a maintenance task, not a
// critical path, and the fallback is always safe.
//
// ─── STRICT INTEGER PARSING ──────────────────────────────────────────────────
//
// We deliberately avoid parseInt() for parsing SOFT_DELETE_RETENTION_DAYS.
// parseInt() uses a "leading numeric portion" strategy: parseInt("90days", 10)
// silently returns 90, parseInt("1e2", 10) returns 1 (stops at the non-digit
// 'e'). Both would pass the range check and result in a silently wrong retention
// period — exactly the kind of misconfiguration that is hard to notice in prod.
//
// Instead we require the trimmed env string to match /^[0-9]+$/ — a contiguous
// run of decimal digits with nothing else — before converting. Any deviation
// triggers the warning + fallback path. Only trimming leading/trailing whitespace
// is allowed as a leniency (common copy-paste artifact with no semantic intent).
//
// The validated retention is then passed as a query *parameter* (not interpolated
// into SQL text), preventing any possibility of SQL injection from a misconfigured
// environment variable and keeping the query planner's plan stable across runs.

import cron from "node-cron";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";

const SCHEDULE = process.env.CRON_HARD_DELETE ?? "0 4 * * 0"; // Sundays at 04:00
const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650; // ~10 years

// ─── Strict retention parsing (runs at module load, not per tick) ─────────────
//
// We validate once here rather than inside the job runner because:
//   a) It surfaces misconfiguration at startup, where it is most visible.
//   b) It guarantees RETENTION_DAYS is a safe integer for the life of the process
//      without re-parsing the env var on every run.
//
// Parsing strategy:
//   1. Read the raw string and trim surrounding whitespace (the only leniency).
//   2. Treat undefined or empty string as "not set" → use default at debug level.
//   3. For non-empty values, gate on /^[0-9]+$/ before any numeric conversion.
//      This rejects "90days", "1e2", "-30", "0x5A", " 30 " (post-trim "30" is
//      fine, but pre-trim with internal spaces like "9 0" is not).
//   4. Convert with Number() — safe here since the regex already guarantees a
//      pure decimal digit string, making parseInt() and Number() equivalent.
//   5. Range-check 1..3650 and warn + fallback on violation.
const _envRetention = process.env.SOFT_DELETE_RETENTION_DAYS;
const _trimmed = typeof _envRetention === "string" ? _envRetention.trim() : undefined;
const STRICT_DECIMAL_INTEGER_RE = /^[0-9]+$/;

let RETENTION_DAYS;

if (_trimmed === undefined || _trimmed === "") {
	// Not configured — this is the normal case for most deployments. Use default
	// at debug level; no operator action needed.
	logger.debug(
		{ fallback: DEFAULT_RETENTION_DAYS },
		`cron:hardDeleteCleanup — SOFT_DELETE_RETENTION_DAYS not set; using default of ${DEFAULT_RETENTION_DAYS} days`,
	);
	RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
} else if (!STRICT_DECIMAL_INTEGER_RE.test(_trimmed)) {
	// Non-empty but contains non-digit characters. parseInt() would silently
	// accept the leading numeric portion (e.g. "90days" → 90); we reject it
	// entirely and fall back so the misconfiguration is not silently swallowed.
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
	// Regex guarantees a pure decimal digit string — Number() conversion is safe.
	const _parsed = Number(_trimmed);

	if (!Number.isFinite(_parsed) || _parsed < MIN_RETENTION_DAYS || _parsed > MAX_RETENTION_DAYS) {
		// Valid integer format but outside the allowed range (e.g. "0" or "99999").
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

		// The cutoff timestamp is computed entirely inside Postgres using a
		// parameterized interval so RETENTION_DAYS is never interpolated into SQL
		// text. This has two benefits:
		//
		//   1. Safety: even though RETENTION_DAYS is already validated above, using
		//      a parameter closes off any theoretical injection path.
		//
		//   2. Stability: Postgres receives the same query text on every run and can
		//      reuse a cached query plan rather than re-planning a freshly-generated
		//      SQL string.
		//
		// `($1::int * INTERVAL '1 day')` multiplies the integer retention count by
		// a typed interval literal. This is the standard Postgres idiom for building
		// a dynamic interval from a numeric parameter.
		const cutoffExpr = `NOW() - ($1::int * INTERVAL '1 day')`;
		// All DELETE queries receive RETENTION_DAYS as their first (and only) parameter.
		const p = [RETENTION_DAYS];

		// Deletion order: deepest dependents first, then work up toward root entities.

		// 1. rating_reports (depends on ratings)
		const { rowCount: rr } = await client.query(
			`DELETE FROM rating_reports WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.rating_reports = rr;

		// 2. ratings (depends on connections and users)
		const { rowCount: ra } = await client.query(
			`DELETE FROM ratings WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.ratings = ra;

		// 3. notifications (depends on users)
		const { rowCount: no } = await client.query(
			`DELETE FROM notifications WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.notifications = no;

		// 4. connections (depends on interest_requests, listings, users)
		const { rowCount: co } = await client.query(
			`DELETE FROM connections WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.connections = co;

		// 5. interest_requests (depends on listings and users)
		const { rowCount: ir } = await client.query(
			`DELETE FROM interest_requests WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.interest_requests = ir;

		// 6. saved_listings (depends on listings and users)
		const { rowCount: sl } = await client.query(
			`DELETE FROM saved_listings WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.saved_listings = sl;

		// 7. listing_photos (ON DELETE CASCADE from listings, but we also clean
		//    explicitly-soft-deleted photos that outlived their parent listing)
		const { rowCount: lp } = await client.query(
			`DELETE FROM listing_photos WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.listing_photos = lp;

		// 8. listings (depends on properties and users; cascade handles listing_preferences
		//    and listing_amenities automatically via ON DELETE CASCADE)
		const { rowCount: li } = await client.query(
			`DELETE FROM listings WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.listings = li;

		// 9. verification_requests (depends on users)
		const { rowCount: vr } = await client.query(
			`DELETE FROM verification_requests WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.verification_requests = vr;

		// 10. pg_owner_profiles and student_profiles (depend on users)
		const { rowCount: pop } = await client.query(
			`DELETE FROM pg_owner_profiles WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.pg_owner_profiles = pop;

		const { rowCount: sp } = await client.query(
			`DELETE FROM student_profiles WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.student_profiles = sp;

		// 11. user_preferences (depends on users, no deleted_at — skip)

		// 12. properties (depends on users)
		const { rowCount: pr } = await client.query(
			`DELETE FROM properties WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.properties = pr;

		// 13. institutions (no hard dependencies from other tables after above)
		const { rowCount: ins } = await client.query(
			`DELETE FROM institutions WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
			p,
		);
		results.institutions = ins;

		// 14. users — last, after all dependents are cleared
		const { rowCount: us } = await client.query(
			`DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffExpr}`,
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
