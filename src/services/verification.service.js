

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";











const handleRollbackFailure = (
	rollbackErr,
	originalErr,
	context,
	message = "Rollback failed during verification operation",
) => {
	logger.error({ rollbackErr, originalErr, ...context }, message);
};



export const submitDocument = async (requestingUserId, targetUserId, { documentType, documentUrl }) => {
	
	
	
	
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const { rows: profileRows } = await client.query(
			`SELECT profile_id
       FROM pg_owner_profiles
       WHERE user_id = $1
         AND deleted_at IS NULL
       FOR UPDATE`,
			[targetUserId],
		);
		if (!profileRows.length) {
			throw new AppError("PG owner profile not found", 404);
		}

		const { rowCount: pendingRequestCount } = await client.query(
			`SELECT 1
       FROM verification_requests
       WHERE user_id = $1
         AND status = 'pending'
         AND deleted_at IS NULL
       LIMIT 1`,
			[targetUserId],
		);
		if (pendingRequestCount > 0) {
			throw new AppError("You already have a pending verification request", 409);
		}

		const { rows } = await client.query(
			`INSERT INTO verification_requests (user_id, document_type, document_url)
       VALUES ($1, $2, $3)
       RETURNING request_id, document_type, document_url, status, submitted_at`,
			[targetUserId, documentType, documentUrl],
		);

		const { rowCount: profileRowCount } = await client.query(
			`UPDATE pg_owner_profiles
       SET verification_status = 'pending',
           rejection_reason    = NULL
       WHERE user_id = $1
         AND deleted_at IS NULL`,
			[targetUserId],
		);
		if (profileRowCount === 0) {
			throw new AppError("PG owner profile not found — cannot submit verification", 409);
		}

		await client.query("COMMIT");

		logger.info(
			{ userId: targetUserId, documentType, requestId: rows[0].request_id },
			"Document submitted for verification",
		);

		return rows[0];
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error(
				{ rollbackErr, originalErr: err, userId: targetUserId },
				"Rollback failed during document submission",
			);
		}

		if (err.code === "23505" && err.constraint === "uq_verification_requests_active_pending_per_user") {
			throw new AppError("You already have a pending verification request", 409);
		}

		throw err;
	} finally {
		client.release();
	}
};



export const getVerificationQueue = async ({ cursorTime, cursorId, limit = 20 }) => {
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;

	const params = [limit + 1];
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		cursorClause = `AND (vr.submitted_at, vr.request_id) > ($2, $3::uuid)`;
	}

	const { rows } = await pool.query(
		`SELECT
      vr.request_id,
      vr.user_id,
      vr.document_type,
      vr.document_url,
      vr.submitted_at,
      pop.business_name,
      pop.owner_full_name,
      pop.verification_status,
      u.email
    FROM verification_requests vr
    JOIN pg_owner_profiles pop ON pop.user_id = vr.user_id
    JOIN users u ON u.user_id = vr.user_id
    WHERE vr.status = 'pending'
      AND vr.deleted_at IS NULL
      ${cursorClause}
    ORDER BY vr.submitted_at ASC, vr.request_id ASC
    LIMIT $1`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].submitted_at.toISOString(),
				cursorId: items[items.length - 1].request_id,
			}
		:	null;

	return { items, nextCursor };
};



export const approveRequest = async (adminUserId, requestId, { adminNotes } = {}) => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const { rowCount, rows: requestRows } = await client.query(
			`UPDATE verification_requests
       SET status      = 'verified',
           reviewed_at = NOW(),
           reviewed_by = $1,
           admin_notes = $2
       WHERE request_id = $3
         AND status = 'pending'
         AND deleted_at IS NULL
       RETURNING user_id`,
			[adminUserId, adminNotes ?? null, requestId],
		);

		if (rowCount === 0) {
			throw new AppError("Verification request not found or already resolved", 409);
		}

		const ownerId = requestRows[0].user_id;

		const { rowCount: profileRowCount } = await client.query(
			`UPDATE pg_owner_profiles
       SET verification_status = 'verified',
           verified_at         = NOW(),
           verified_by         = $1
       WHERE user_id = $2
         AND deleted_at IS NULL`,
			[adminUserId, ownerId],
		);

		if (profileRowCount === 0) {
			throw new AppError("PG owner profile not found — cannot complete approval", 409);
		}

		await client.query("COMMIT");

		logger.info({ adminUserId, requestId, ownerId }, "Verification request approved");

		return { requestId, status: "verified" };
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			handleRollbackFailure(rollbackErr, err, { adminUserId, requestId });
		}
		throw err;
	} finally {
		client.release();
	}
};

export const rejectRequest = async (adminUserId, requestId, { rejectionReason, adminNotes } = {}) => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const { rowCount, rows: requestRows } = await client.query(
			`UPDATE verification_requests
			SET status      = 'rejected',
				reviewed_at = NOW(),
				reviewed_by = $1,
				admin_notes = $2
			WHERE request_id = $3
				AND status = 'pending'
				AND deleted_at IS NULL
			RETURNING user_id`,
			[adminUserId, adminNotes ?? null, requestId],
		);

		if (rowCount === 0) {
			throw new AppError("Verification request not found or already resolved", 409);
		}

		const ownerId = requestRows[0].user_id;

		const { rowCount: profileRowCount } = await client.query(
			`UPDATE pg_owner_profiles
			SET verification_status = 'rejected',
				rejection_reason    = $1
			WHERE user_id = $2
				AND deleted_at IS NULL`,
			[rejectionReason, ownerId],
		);

		if (profileRowCount === 0) {
			throw new AppError("PG owner profile not found — cannot complete rejection", 409);
		}

		await client.query("COMMIT");

		logger.info({ adminUserId, requestId, ownerId }, "Verification request rejected");

		return { requestId, status: "rejected" };
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			handleRollbackFailure(rollbackErr, err, { adminUserId, requestId });
		}
		throw err;
	} finally {
		client.release();
	}
};
