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
// This is enforced via a single atomic INSERT ... SELECT ... RETURNING that
// mirrors the eligibility check used in rating submission (rating.service.js).
// The reasoning: if you were not involved in the interaction, you have no
// standing to dispute the rating.
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
//
// FIX (Finding 3): Replace the two-step SELECT + INSERT with a single atomic
// INSERT ... SELECT ... RETURNING.
//
// The previous code did:
//   1. SELECT eligibility (pool.query)
//   2. INSERT into rating_reports (pool.query)
//
// This TOCTOU race meant the connection could be soft-deleted, or the reporter
// could be removed from the connection, between steps 1 and 2. The new pattern
// collapses both into one statement: the INSERT only fires when the SELECT sub-
// query (equivalent to the old eligibility check) returns a row. If the sub-
// query returns nothing, the INSERT produces zero rows, and we throw 404 — the
// same observable behaviour as before, but now atomic.
export const submitReport = async (reporterId, ratingId, { reason, explanation }) => {
	// Single atomic INSERT ... SELECT:
	//   - Selects from ratings JOIN connections with the full eligibility predicate
	//   - If the sub-query returns no rows (rating not found, reporter not a party,
	//     or either row soft-deleted) the INSERT produces zero rows → 404
	//   - If the partial unique index on (reporter_id, rating_id) WHERE status='open'
	//     fires (duplicate open report), PostgreSQL raises a 23505 unique-violation
	//     which the global error handler converts to 409
	const { rows } = await pool.query(
		`INSERT INTO rating_reports (reporter_id, rating_id, reason, explanation)
     SELECT $1, r.rating_id, $3::report_reason_enum, $4
     FROM ratings r
     JOIN connections c
       ON c.connection_id = r.connection_id
      AND c.deleted_at    IS NULL
     WHERE r.rating_id   = $2
       AND r.deleted_at  IS NULL
       AND (c.initiator_id = $1 OR c.counterpart_id = $1)
     RETURNING report_id, reporter_id, rating_id, reason, status, created_at`,
		[reporterId, ratingId, reason, explanation ?? null],
	);

	if (!rows.length) {
		// Either the rating doesn't exist, or the caller isn't a party to the
		// underlying connection. We return 404 in both cases to avoid leaking
		// whether the rating exists at all.
		throw new AppError("Rating not found or you are not a party to this connection", 404);
	}

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
//
// FIX (Finding 4): Changed INNER JOINs on ratings and users (reviewer/reporter)
// to LEFT JOINs with deleted_at IS NULL predicates moved into the ON clause.
//
// The original INNER JOINs silently dropped open reports whenever:
//   - The flagged rating row was soft-deleted (ratings.deleted_at IS NOT NULL)
//   - The reporter's user row was soft-deleted (u_rep.deleted_at IS NOT NULL)
//   - The reviewer's user row was soft-deleted (u_rev.deleted_at IS NOT NULL)
//
// This left admins with an incomplete moderation queue — open reports that
// existed in the DB were invisible. Using LEFT JOINs with the predicate in the
// ON clause means the report row always appears; missing related data surfaces
// as NULLs in the reviewer/reporter columns (which the admin UI already handles
// gracefully with fallback display text).
export const getReportQueue = async ({ cursorTime, cursorId, limit = 20 }) => {
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	const hasPartialCursor = (cursorTime !== undefined) !== (cursorId !== undefined);
	if (hasPartialCursor) {
		throw new AppError("cursorTime and cursorId must be provided together", 400);
	}
	const safeLimit = Math.min(100, Math.max(1, Number(limit) || 1));

	const params = [safeLimit + 1];
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		cursorClause = `AND (rr.created_at, rr.report_id) > ($2, $3::uuid)`;
	}

	const { rows } = await pool.query(
		`SELECT
       rr.report_id,
       rr.reporter_id,
       rr.rating_id,
       rr.reason,
       rr.explanation,
       rr.status,
       rr.created_at                           AS submitted_at,

       -- Rating detail (LEFT JOIN so open reports survive rating soft-delete)
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

       -- Reporter (LEFT JOIN so reports survive reporter account soft-delete)
       COALESCE(sp_rep.full_name, pop_rep.owner_full_name, u_rep.email)
                                               AS reporter_name,
       sp_rep.profile_photo_url                AS reporter_photo_url,

       -- Reviewer of the rating (LEFT JOIN so reports survive reviewer soft-delete)
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

     -- The flagged rating: LEFT JOIN so open reports are visible even if the
     -- rating row is later soft-deleted (e.g. by a hard-delete migration pass).
     LEFT JOIN ratings r
       ON r.rating_id   = rr.rating_id
      AND r.deleted_at  IS NULL

     -- The person who filed the report: LEFT JOIN so the queue remains visible
     -- even if the reporter account is soft-deleted before the admin resolves.
     LEFT JOIN users u_rep
       ON u_rep.user_id    = rr.reporter_id
      AND u_rep.deleted_at IS NULL
     LEFT JOIN student_profiles sp_rep
       ON sp_rep.user_id    = rr.reporter_id
      AND sp_rep.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop_rep
       ON pop_rep.user_id   = rr.reporter_id
      AND pop_rep.deleted_at IS NULL

     -- The person who wrote the rating: LEFT JOIN for the same reason.
     LEFT JOIN users u_rev
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
				cursorTime: items[items.length - 1].submitted_at,
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
				reviewer: {
					fullName: row.reviewer_name,
					profilePhotoUrl: row.reviewer_photo_url,
				},
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
//
// FIX (Finding 5): Moved logger.info calls to after COMMIT so the moderation
// outcome is only logged when the transaction has successfully persisted.
//
// FIX (soft-deleted rating on resolved_removed): If the target rating row has
// already been soft-deleted (e.g. by the Phase 5 hard-delete cron running
// between report submission and resolution), the UPDATE ratings SET is_visible =
// FALSE WHERE ... AND deleted_at IS NULL will match zero rows. Previously this
// threw a 409, even though the desired outcome — the rating is not contributing
// to the average — was already achieved. The fix: after rowCount === 0 on the
// rating UPDATE, check whether the row exists at all (without the deleted_at
// filter). If the row is soft-deleted, treat that as a success equivalent to
// having just hidden it. If the row truly doesn't exist at all, then something
// is very wrong (FK violation that somehow reached this point), and we throw.
export const resolveReport = async (adminId, reportId, { resolution, adminNotes }) => {
	const validResolutions = ["resolved_removed", "resolved_kept"];
	if (!validResolutions.includes(resolution)) {
		throw new AppError(`Invalid resolution. Must be one of: ${validResolutions.join(", ")}`, 400);
	}

	if (resolution === "resolved_removed" && (!adminNotes || adminNotes.trim() === "")) {
		throw new AppError("adminNotes is required when resolution is resolved_removed", 400);
	}

	// `resolved_removed` requires a transaction: we must update both the report
	// status AND set the rating's is_visible = FALSE atomically. If only one
	// succeeds we'd have an inconsistent state (report closed but rating still
	// visible, or rating hidden but report still shows as open).
	//
	// `resolved_kept` only needs one UPDATE, but we use a transaction consistently
	// for both paths to keep the code straightforward and to ensure the
	// AND status = 'open' concurrency guard works the same way in both cases.

	const client = await pool.connect();

	// Capture the ratingId and resolution outcome so we can log them after COMMIT.
	let ratingId;

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

		ratingId = reportRows[0].rating_id;

		if (resolution === "resolved_removed") {
			// Attempt to hide the rating. The DB trigger `update_rating_aggregates`
			// fires automatically after this UPDATE and recalculates the affected
			// user's/property's average_rating and rating_count.
			//
			// We filter on AND deleted_at IS NULL because there is no point trying
			// to set is_visible = FALSE on a row that has already been physically
			// removed from the active data set by the soft-delete mechanism.
			// However, a soft-deleted rating is already invisible to all callers
			// (every read query filters on deleted_at IS NULL), so the desired
			// end state — the rating does not affect aggregates or appear to users —
			// is already achieved. We therefore check for this case explicitly and
			// treat it as a success rather than an error.
			const { rowCount: ratingRowCount } = await client.query(
				`UPDATE ratings
         SET is_visible = FALSE
         WHERE rating_id  = $1
           AND deleted_at IS NULL`,
				[ratingId],
			);

			if (ratingRowCount === 0) {
				// The UPDATE matched nothing. Determine why:
				//   - Row exists with deleted_at IS NOT NULL → already soft-deleted,
				//     which means it's already invisible. Treat as success.
				//   - Row doesn't exist at all → genuine data integrity problem.
				//     This should never happen given the FK from rating_reports to
				//     ratings, but we guard defensively.
				const { rows: ratingCheck } = await client.query(
					`SELECT deleted_at FROM ratings WHERE rating_id = $1`,
					[ratingId],
				);

				if (!ratingCheck.length) {
					// The rating row is completely absent — this violates the FK
					// constraint from rating_reports to ratings and should not be
					// possible in normal operation. Throw so this surfaces as a bug.
					throw new AppError(
						"Rating not found — this is unexpected; the report references a non-existent rating",
						409,
					);
				}

				// ratingCheck[0].deleted_at IS NOT NULL: the rating is soft-deleted.
				// Its aggregates were already adjusted when deleted_at was set (or
				// will be on the next cleanup pass). The report is correctly being
				// closed as resolved_removed — proceed to COMMIT.
				logger.info(
					{ adminId, reportId, ratingId },
					"resolveReport: target rating is already soft-deleted — proceeding as resolved_removed success",
				);
			}
		}

		await client.query("COMMIT");

		// Log the outcome only after the transaction has committed. If COMMIT
		// throws, we fall through to the catch block and no success log is
		// emitted — avoiding a false positive in monitoring dashboards.
		if (resolution === "resolved_removed") {
			logger.info({ adminId, reportId, ratingId }, "Report resolved — rating hidden");
		} else {
			logger.info({ adminId, reportId, ratingId }, "Report resolved — rating kept visible");
		}

		return {
			reportId,
			resolution,
			ratingId,
		};
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ originalError: err, rollbackError: rollbackErr }, "ROLLBACK failed during error handling");
		}
		throw err;
	} finally {
		client.release();
	}
};
