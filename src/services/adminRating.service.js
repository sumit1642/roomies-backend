// src/services/adminRating.service.js
//
// Admin-facing rating management. Two operations:
//
//   listRatings        — paginated feed with optional filters, used by the
//                        admin panel to audit moderation decisions and find
//                        ratings that need attention before being reported.
//
//   updateRatingVisibility — direct visibility toggle that bypasses the report
//                        flow. When is_visible changes, the DB trigger
//                        update_rating_aggregates fires automatically and
//                        recalculates average_rating on users/properties.
//                        No application-layer aggregate math needed.
//
// ─── WHY SEPARATE FROM report.service.js ─────────────────────────────────────
//
// resolveReport() hides a rating as a side-effect of closing a moderation ticket.
// updateRatingVisibility() changes visibility directly with no report required —
// the admin may want to proactively hide a suspicious rating or restore one that
// was incorrectly hidden. Different semantics, different audit trail, different
// required fields (no reportId, adminNotes required on hide but attached to the
// rating row directly rather than a report row).
//
// ─── AUDIT TRAIL ─────────────────────────────────────────────────────────────
//
// We store adminNotes on the ratings row itself via a new admin_notes column.
// Wait — the ratings table does not have an admin_notes column in the schema.
// Rather than requiring a schema migration, we log the admin action with Pino
// (structured, queryable in Azure Monitor) and rely on the existing report flow
// for formal audit trails when a report exists. Direct visibility changes are
// a lighter-weight tool and the Pino log is sufficient audit evidence at this
// scale. If a formal audit column is later required, add it in a migration.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── List ratings (admin feed) ────────────────────────────────────────────────
//
// Supports three optional filters:
//   isVisible     — true = only visible, false = only hidden, absent = all
//   revieweeType  — "user" or "property"
//   revieweeId    — UUID of the specific user or property being reviewed
//
// Keyset pagination on (created_at DESC, rating_id ASC) — newest first,
// same compound cursor pattern used everywhere else in the codebase.
export const listRatings = async (filters) => {
	const { isVisible, revieweeType, revieweeId, cursorTime, cursorId, limit: rawLimit = 20 } = filters;

	const limit = Math.min(Math.max(1, rawLimit), 100);

	const clauses = [`r.deleted_at IS NULL`];
	const params = [];
	let p = 1;

	if (isVisible !== undefined) {
		clauses.push(`r.is_visible = $${p}`);
		params.push(isVisible);
		p++;
	}

	if (revieweeType !== undefined) {
		clauses.push(`r.reviewee_type = $${p}::reviewee_type_enum`);
		params.push(revieweeType);
		p++;
	}

	if (revieweeId !== undefined) {
		clauses.push(`r.reviewee_id = $${p}::uuid`);
		params.push(revieweeId);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(r.created_at < $${p} OR (r.created_at = $${p} AND r.rating_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const { rows } = await pool.query(
		`SELECT
			r.rating_id,
			r.reviewer_id,
			r.reviewee_type,
			r.reviewee_id,
			r.connection_id,
			r.overall_score,
			r.cleanliness_score,
			r.communication_score,
			r.reliability_score,
			r.value_score,
			r.review_text                              AS comment,
			r.is_visible,
			r.created_at,

			-- Reviewer identity (may be student or pg_owner)
			COALESCE(sp_rev.full_name, pop_rev.owner_full_name) AS reviewer_name,
			sp_rev.profile_photo_url                            AS reviewer_photo_url,

			-- Reviewee identity: user branch uses name lookup; property branch
			-- uses property_name. Both are nullable for soft-deleted entities.
			CASE
				WHEN r.reviewee_type = 'user'
				THEN COALESCE(sp_rvee.full_name, pop_rvee.owner_full_name)
				ELSE p_rvee.property_name
			END AS reviewee_name,

			-- Count of open reports against this rating — useful for the admin
			-- to prioritise ratings that have been flagged by users without
			-- navigating to the separate report queue.
			(
				SELECT COUNT(*)::int
				FROM rating_reports rr
				WHERE rr.rating_id  = r.rating_id
				  AND rr.status     = 'open'
				  AND rr.deleted_at IS NULL
			) AS open_report_count

		FROM ratings r

		-- Reviewer profiles
		LEFT JOIN student_profiles   sp_rev
			ON sp_rev.user_id    = r.reviewer_id
		   AND sp_rev.deleted_at IS NULL
		LEFT JOIN pg_owner_profiles  pop_rev
			ON pop_rev.user_id   = r.reviewer_id
		   AND pop_rev.deleted_at IS NULL

		-- Reviewee profiles (user branch)
		LEFT JOIN student_profiles   sp_rvee
			ON sp_rvee.user_id   = r.reviewee_id
		   AND r.reviewee_type   = 'user'
		   AND sp_rvee.deleted_at IS NULL
		LEFT JOIN pg_owner_profiles  pop_rvee
			ON pop_rvee.user_id  = r.reviewee_id
		   AND r.reviewee_type   = 'user'
		   AND pop_rvee.deleted_at IS NULL

		-- Reviewee (property branch)
		LEFT JOIN properties p_rvee
			ON p_rvee.property_id = r.reviewee_id
		   AND r.reviewee_type    = 'property'
		   AND p_rvee.deleted_at  IS NULL

		WHERE ${clauses.join(" AND ")}
		ORDER BY r.created_at DESC, r.rating_id ASC
		LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].rating_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			ratingId: row.rating_id,
			reviewerId: row.reviewer_id,
			revieweeType: row.reviewee_type,
			revieweeId: row.reviewee_id,
			connectionId: row.connection_id,
			overallScore: row.overall_score,
			cleanlinessScore: row.cleanliness_score,
			communicationScore: row.communication_score,
			reliabilityScore: row.reliability_score,
			valueScore: row.value_score,
			comment: row.comment,
			isVisible: row.is_visible,
			createdAt: row.created_at,
			openReportCount: row.open_report_count,
			reviewer: {
				fullName: row.reviewer_name,
				profilePhotoUrl: row.reviewer_photo_url,
			},
			reviewee: {
				name: row.reviewee_name,
				type: row.reviewee_type,
			},
		})),
		nextCursor,
	};
};

// ─── Update rating visibility (direct admin toggle) ───────────────────────────
//
// Sets is_visible on a rating. The DB trigger update_rating_aggregates fires
// automatically after the UPDATE — no manual aggregate recalculation needed.
//
// adminNotes is required when hiding (isVisible = false) to enforce that
// admins document their reasoning, matching the convention in resolveReport().
// It is optional when restoring visibility.
//
// We log the action with full context (adminId, ratingId, newVisibility,
// adminNotes) so the decision is permanently queryable in Azure Monitor logs
// even without a dedicated audit table in the DB.
export const updateRatingVisibility = async (adminId, ratingId, { isVisible, adminNotes }) => {
	if (!isVisible && (!adminNotes || adminNotes.trim() === "")) {
		throw new AppError("adminNotes is required when hiding a rating", 400);
	}

	// Fetch the current state first so we can detect no-ops and return the
	// correct error if the rating doesn't exist. This pre-read is a single
	// indexed lookup (rating_id PK) — no performance concern.
	const { rows: currentRows } = await pool.query(
		`SELECT rating_id, is_visible, deleted_at
		 FROM ratings
		 WHERE rating_id = $1`,
		[ratingId],
	);

	if (!currentRows.length || currentRows[0].deleted_at !== null) {
		throw new AppError("Rating not found", 404);
	}

	const currentVisibility = currentRows[0].is_visible;

	// No-op guard: if the rating is already in the requested state, return
	// success without hitting the DB trigger. This matters because the trigger
	// runs a full AVG() recalculation — unnecessary work if nothing changed.
	if (currentVisibility === isVisible) {
		logger.info(
			{ adminId, ratingId, isVisible, note: "no-op — already in requested state" },
			"adminRating.updateRatingVisibility: no change made",
		);
		return { ratingId, isVisible, changed: false };
	}

	// The UPDATE triggers update_rating_aggregates automatically, which
	// recalculates average_rating and rating_count on the affected reviewee.
	const { rowCount } = await pool.query(
		`UPDATE ratings
		 SET is_visible = $1
		 WHERE rating_id  = $2
		   AND deleted_at IS NULL`,
		[isVisible, ratingId],
	);

	if (rowCount === 0) {
		// Race condition: row was soft-deleted between our pre-read and the UPDATE.
		throw new AppError("Rating not found", 404);
	}

	logger.info(
		{
			adminId,
			ratingId,
			isVisible,
			previousVisibility: currentVisibility,
			adminNotes: adminNotes ?? null,
		},
		isVisible ?
			"adminRating.updateRatingVisibility: rating restored to visible"
		:	"adminRating.updateRatingVisibility: rating hidden by admin",
	);

	return { ratingId, isVisible, changed: true };
};
