

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";





export const submitReport = async (reporterId, ratingId, { reason, explanation }) => {
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

       COALESCE(sp_rep.full_name, pop_rep.owner_full_name, u_rep.email)
                                               AS reporter_name,
       sp_rep.profile_photo_url                AS reporter_photo_url,

       COALESCE(sp_rev.full_name, pop_rev.owner_full_name, u_rev.email)
                                               AS reviewer_name,
       sp_rev.profile_photo_url                AS reviewer_photo_url,

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

     LEFT JOIN ratings r
       ON r.rating_id   = rr.rating_id
      AND r.deleted_at  IS NULL

     LEFT JOIN users u_rep
       ON u_rep.user_id    = rr.reporter_id
      AND u_rep.deleted_at IS NULL
     LEFT JOIN student_profiles sp_rep
       ON sp_rep.user_id    = rr.reporter_id
      AND sp_rep.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop_rep
       ON pop_rep.user_id   = rr.reporter_id
      AND pop_rep.deleted_at IS NULL

     LEFT JOIN users u_rev
       ON u_rev.user_id    = r.reviewer_id
      AND u_rev.deleted_at IS NULL
     LEFT JOIN student_profiles sp_rev
       ON sp_rev.user_id    = r.reviewer_id
      AND sp_rev.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop_rev
       ON pop_rev.user_id   = r.reviewer_id
      AND pop_rev.deleted_at IS NULL

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










export const resolveReport = async (adminId, reportId, { resolution, adminNotes }) => {
	const validResolutions = ["resolved_removed", "resolved_kept"];
	if (!validResolutions.includes(resolution)) {
		throw new AppError(`Invalid resolution. Must be one of: ${validResolutions.join(", ")}`, 400);
	}

	if (resolution === "resolved_removed" && (!adminNotes || adminNotes.trim() === "")) {
		throw new AppError("adminNotes is required when resolution is resolved_removed", 400);
	}

	const client = await pool.connect();

	let ratingId;
	
	
	let ratingWasAlreadySoftDeleted = false;

	try {
		await client.query("BEGIN");

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
			
			
			const { rowCount: ratingRowCount } = await client.query(
				`UPDATE ratings
         SET is_visible = FALSE
         WHERE rating_id  = $1
           AND deleted_at IS NULL`,
				[ratingId],
			);

			if (ratingRowCount === 0) {
				
				
				
				const { rows: ratingCheck } = await client.query(
					`SELECT deleted_at FROM ratings WHERE rating_id = $1`,
					[ratingId],
				);

				if (!ratingCheck.length) {
					throw new AppError(
						"Rating not found — this is unexpected; the report references a non-existent rating",
						409,
					);
				}

				
				
				ratingWasAlreadySoftDeleted = true;
			}
		}

		await client.query("COMMIT");

		
		
		if (ratingWasAlreadySoftDeleted) {
			logger.info(
				{ adminId, reportId, ratingId },
				"resolveReport: target rating is already soft-deleted — proceeding as resolved_removed success",
			);
		}

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
