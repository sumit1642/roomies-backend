// src/services/report.service.js
//
// ─── WHAT THIS SERVICE DOES ───────────────────────────────────────────────────
//
// Handles the three-step report lifecycle:
//   1. submitReport  — any party to a connection can flag a rating on it
//   2. getReportQueue — admin reads open reports with full context
//   3. resolveReport — admin closes the report, optionally hiding the rating
//
// ─── THE REPORTER ELIGIBILITY CHECK ──────────────────────────────────────────
//
// A reporter must be a party to the connection that the rating references.
// This is enforced via a WHERE EXISTS join that mirrors the eligibility check
// used in rating submission (rating.service.js). The reasoning: if you were
// not involved in the interaction, you have no standing to dispute the rating.
//
// ─── THE AGGREGATE RECALCULATION ─────────────────────────────────────────────
//
// When a report is resolved as 'resolved_removed', we set ratings.is_visible =
// FALSE. The DB trigger `update_rating_aggregates` fires automatically on that
// UPDATE, recomputing the affected user's or property's average_rating and
// rating_count. No application code is needed for the aggregate update — the
// trigger handles it.
//
// ─── CONCURRENCY GUARD ───────────────────────────────────────────────────────
//
// Both submitReport and resolveReport use AND status = 'open' as a conditional
// transition guard. If two admins simultaneously try to resolve the same report,
// one gets rowCount = 1 and succeeds; the other gets rowCount = 0 and receives
// a 409. Same pattern as the verification queue — correct by construction.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── Submit report ────────────────────────────────────────────────────────────
export const submitReport = async (reporterId, ratingId, { reason, explanation }) => {
	// Step 1: Verify the rating exists and the reporter is a party to the
	// connection it references. We use a single combined query that:
	//   a) confirms the rating row exists and is not deleted
	//   b) confirms the reporter is initiator or counterpart on the connection
	//      that the rating is anchored to
	// If either condition fails, the EXISTS returns no rows and we throw 404
	// rather than 403 — we never confirm whether the rating exists to a caller
	// who is not a party.
	const { rows: eligibilityRows } = await pool.query(
		`SELECT r.rating_id, r.connection_id
     FROM ratings r
     JOIN connections c ON c.connection_id = r.connection_id AND c.deleted_at IS NULL
     WHERE r.rating_id   = $1
       AND r.deleted_at  IS NULL
       AND (c.initiator_id = $2 OR c.counterpart_id = $2)`,
		[ratingId, reporterId],
	);

	if (!eligibilityRows.length) {
		// Either the rating doesn't exist, or the caller isn't a party to the
		// underlying connection. We return 404 in both cases to avoid leaking
		// whether the rating exists at all.
		throw new AppError("Rating not found or you are not a party to this connection", 404);
	}

	// Step 2: INSERT the report. The partial unique index on
	// (reporter_id, rating_id) WHERE status = 'open' prevents duplicate open
	// reports from the same person on the same rating. A resolved report does
	// not block re-reporting (the partial index only covers open rows).
	const { rows } = await pool.query(
		`INSERT INTO rating_reports (reporter_id, rating_id, reason, explanation)
     VALUES ($1, $2, $3::report_reason_enum, $4)
     RETURNING report_id, reporter_id, rating_id, reason, status, created_at`,
		[reporterId, ratingId, reason, explanation ?? null],
	);

	// rowCount will be 1 on success. ON CONFLICT would produce 0, but we aren't
	// using ON CONFLICT here — we let the unique index throw a 23505 PostgreSQL
	// error which the global error handler converts to a 409.
	const report = rows[0];

	logger.info({ reporterId, ratingId, reportId: report.report_id, reason }, "Rating report submitted");

	return {
		reportId: report.report_id,
		reporterId: report.reporter_id,
		ratingId: report.rating_id,
		reason: report.reason,
		status: report.status,
		createdAt: report.created_at,
	};
};

// ─── Get report queue (admin) ─────────────────────────────────────────────────
//
// Returns open reports oldest-first (anti-starvation, same as verification queue).
// Each row includes the full rating content, the reporter's public profile, and
// the reviewee's public profile, so the admin can make a decision without a
// second request.
export const getReportQueue = async ({ cursorTime, cursorId, limit = 20 }) => {
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	const safeLimit = Math.max(1, Number(limit) || 1);

	const params = [safeLimit + 1];
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		cursorClause = `AND (rr.created_at, rr.report_id) > ($2, $3::uuid)`;
	}

	// The query joins outward from rating_reports (filtered to open) through:
	//   ratings              — to get the actual review text and scores
	//   users (reviewer)     — to get the person who wrote the review
	//   student/pg_owner profiles (reviewer) — for name/photo
	//   users (reviewee)     — for the person or property being reviewed
	//   student/pg_owner profiles (reviewee) — for name/photo
	//   properties           — when reviewee_type = 'property'
	//
	// The CASE expressions on reviewee name and photo handle the polymorphic
	// reviewee pattern (same pattern as rating.service.js public reads).
	const { rows } = await pool.query(
		`SELECT
       rr.report_id,
       rr.reporter_id,
       rr.rating_id,
       rr.reason,
       rr.explanation,
       rr.status,
       rr.created_at                           AS submitted_at,

       -- Rating detail
       r.overall_score,
       r.cleanliness_score,
       r.communication_score,
       r.reliability_score,
       r.value_score,
       r.review_text                           AS rating_comment,
       r.reviewee_type,
       r.reviewee_id,
       r.is_visible                            AS rating_is_visible,
       r.created_at                            AS rating_created_at,

       -- Reviewer (the person who wrote the rating)
       COALESCE(sp_rep.full_name, pop_rep.owner_full_name, u_rep.email)
                                               AS reporter_name,
       sp_rep.profile_photo_url                AS reporter_photo_url,

       -- Reviewer of the rating (could differ from reporter)
       COALESCE(sp_rev.full_name, pop_rev.owner_full_name, u_rev.email)
                                               AS reviewer_name,
       sp_rev.profile_photo_url                AS reviewer_photo_url,

       -- Reviewee name (polymorphic)
       CASE
         WHEN r.reviewee_type = 'user'
         THEN COALESCE(sp_rvee.full_name, pop_rvee.owner_full_name, u_rvee.email)
         ELSE p_rvee.property_name
       END                                     AS reviewee_name,

       CASE
         WHEN r.reviewee_type = 'user'
         THEN sp_rvee.profile_photo_url
         ELSE NULL
       END                                     AS reviewee_photo_url

     FROM rating_reports rr

     -- The flagged rating
     JOIN ratings r
       ON r.rating_id   = rr.rating_id
      AND r.deleted_at  IS NULL

     -- The person who filed the report
     JOIN users u_rep
       ON u_rep.user_id    = rr.reporter_id
      AND u_rep.deleted_at IS NULL
     LEFT JOIN student_profiles sp_rep
       ON sp_rep.user_id    = rr.reporter_id
      AND sp_rep.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop_rep
       ON pop_rep.user_id   = rr.reporter_id
      AND pop_rep.deleted_at IS NULL

     -- The person who wrote the rating
     JOIN users u_rev
       ON u_rev.user_id    = r.reviewer_id
      AND u_rev.deleted_at IS NULL
     LEFT JOIN student_profiles sp_rev
       ON sp_rev.user_id    = r.reviewer_id
      AND sp_rev.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop_rev
       ON pop_rev.user_id   = r.reviewer_id
      AND pop_rev.deleted_at IS NULL

     -- The reviewee (user path)
     LEFT JOIN users u_rvee
       ON u_rvee.user_id    = r.reviewee_id
      AND r.reviewee_type   = 'user'
      AND u_rvee.deleted_at IS NULL
     LEFT JOIN student_profiles sp_rvee
       ON sp_rvee.user_id    = r.reviewee_id
      AND r.reviewee_type    = 'user'
      AND sp_rvee.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop_rvee
       ON pop_rvee.user_id   = r.reviewee_id
      AND r.reviewee_type    = 'user'
      AND pop_rvee.deleted_at IS NULL

     -- The reviewee (property path)
     LEFT JOIN properties p_rvee
       ON p_rvee.property_id  = r.reviewee_id
      AND r.reviewee_type     = 'property'
      AND p_rvee.deleted_at   IS NULL

     WHERE rr.status     = 'open'
       AND rr.deleted_at IS NULL
       ${cursorClause}
     ORDER BY rr.created_at ASC, rr.report_id ASC
     LIMIT $1`,
		params,
	);

	const hasNextPage = rows.length > safeLimit;
	const items = hasNextPage ? rows.slice(0, safeLimit) : rows;

	const nextCursor =
		hasNextPage && items.length > 0 ?
			{
				cursorTime: items[items.length - 1].submitted_at.toISOString(),
				cursorId: items[items.length - 1].report_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			reportId: row.report_id,
			reporterId: row.reporter_id,
			ratingId: row.rating_id,
			reason: row.reason,
			explanation: row.explanation,
			status: row.status,
			submittedAt: row.submitted_at,
			rating: {
				overallScore: row.overall_score,
				cleanlinessScore: row.cleanliness_score,
				communicationScore: row.communication_score,
				reliabilityScore: row.reliability_score,
				valueScore: row.value_score,
				comment: row.rating_comment,
				revieweeType: row.reviewee_type,
				revieweeId: row.reviewee_id,
				isVisible: row.rating_is_visible,
				createdAt: row.rating_created_at,
				reviewer: { fullName: row.reviewer_name },
				reviewee: {
					fullName: row.reviewee_name,
					profilePhotoUrl: row.reviewee_photo_url,
				},
			},
			reporter: {
				fullName: row.reporter_name,
				profilePhotoUrl: row.reporter_photo_url,
			},
		})),
		nextCursor,
	};
};

// ─── Resolve report (admin) ───────────────────────────────────────────────────
export const resolveReport = async (adminId, reportId, { resolution, adminNotes }) => {
	// `resolved_removed` requires a transaction: we must update both the report
	// status AND set the rating's is_visible = FALSE atomically. If only one
	// succeeds we'd have an inconsistent state (report closed but rating still
	// visible, or rating hidden but report still shows as open).
	//
	// `resolved_kept` only needs one UPDATE, but we use a transaction consistently
	// for both paths to keep the code straightforward and to ensure the
	// AND status = 'open' concurrency guard works the same way in both cases.

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Update the report row. AND status = 'open' is the concurrency guard —
		// if two admins hit this simultaneously, one gets rowCount = 0 and a 409.
		const { rowCount, rows: reportRows } = await client.query(
			`UPDATE rating_reports
       SET status      = $1::report_status_enum,
           admin_notes = $2,
           reviewed_at = NOW(),
           reviewed_by = $3
       WHERE report_id  = $4
         AND status     = 'open'
         AND deleted_at IS NULL
       RETURNING rating_id`,
			[resolution, adminNotes ?? null, adminId, reportId],
		);

		if (rowCount === 0) {
			throw new AppError("Report not found or already resolved", 409);
		}

		const ratingId = reportRows[0].rating_id;

		if (resolution === "resolved_removed") {
			// Hide the rating. The DB trigger `update_rating_aggregates` fires
			// automatically after this UPDATE and recalculates the affected
			// user's/property's average_rating and rating_count. No application
			// code needed for the aggregate update.
			const { rowCount: ratingRowCount } = await client.query(
				`UPDATE ratings
         SET is_visible = FALSE
         WHERE rating_id  = $1
           AND deleted_at IS NULL`,
				[ratingId],
			);

			if (ratingRowCount === 0) {
				// Shouldn't happen given the FK from rating_reports to ratings, but
				// guard against a soft-deleted rating row just in case.
				throw new AppError("Rating not found — cannot complete removal", 409);
			}

			logger.info({ adminId, reportId, ratingId }, "Report resolved — rating hidden");
		} else {
			logger.info({ adminId, reportId, ratingId }, "Report resolved — rating kept visible");
		}

		await client.query("COMMIT");

		return {
			reportId,
			resolution,
			ratingId,
		};
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
