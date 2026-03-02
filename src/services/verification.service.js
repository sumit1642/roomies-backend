// src/services/verification.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── Document submission ──────────────────────────────────────────────────────

export const submitDocument = async (requestingUserId, targetUserId, { documentType, documentUrl }) => {
	// Route-level ownership check catches cross-user attacks by comparing JWT
	// claims. This guard is different — it verifies actual database state: that a
	// non-deleted pg_owner_profiles row exists for this user. A student who somehow
	// obtained a pg_owner role would pass the ownership check but fail here.
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const { rows: profileRows } = await pool.query(
		`SELECT profile_id
     FROM pg_owner_profiles
     WHERE user_id = $1
       AND deleted_at IS NULL`,
		[targetUserId],
	);
	if (!profileRows.length) {
		throw new AppError("PG owner profile not found", 404);
	}

	// Single-table INSERT — no transaction needed because there are no other
	// coupled writes. The pg_owner_profiles status flip to 'pending' happens
	// explicitly when an admin acts on the request, not automatically on submission.
	const { rows } = await pool.query(
		`INSERT INTO verification_requests (user_id, document_type, document_url)
     VALUES ($1, $2, $3)
     RETURNING request_id, document_type, document_url, status, submitted_at`,
		[targetUserId, documentType, documentUrl],
	);

	logger.info(
		{ userId: targetUserId, documentType, requestId: rows[0].request_id },
		"Document submitted for verification",
	);

	return rows[0];
};

// ─── Admin queue ──────────────────────────────────────────────────────────────

export const getVerificationQueue = async ({ cursorTime, cursorId, limit = 20 }) => {
	// Keyset pagination — stable under concurrent inserts.
	// Offset pagination is not used here because new submissions arriving while an
	// admin is paginating would cause rows to shift, leading to duplicates on one
	// page and gaps on the next. The keyset cursor is anchored to a specific data
	// value and is unaffected by concurrent writes before or after the cursor point.
	//
	// The compound cursor (submitted_at + request_id) is necessary because
	// submitted_at alone is not unique. PostgreSQL's row value comparison
	// `(col1, col2) > ($1, $2)` evaluates as a true lexicographic comparison that
	// mirrors the ORDER BY clause exactly — not application-level cursor arithmetic.
	//
	// Oldest-first ordering (submitted_at ASC) ensures every submission is
	// eventually reviewed regardless of queue volume. Newest-first would allow
	// older submissions to starve as new ones keep appearing at the front.
	const hasCursor = cursorTime !== undefined && cursorId !== undefined;

	const params = [limit + 1]; // fetch one extra to determine if a next page exists
	let cursorClause = "";

	if (hasCursor) {
		params.push(cursorTime, cursorId);
		cursorClause = `AND (vr.submitted_at, vr.request_id) > ($2, $3::uuid)`;
	}

	// Three-way JOIN — returns everything the admin needs to make a decision
	// without any additional requests. Driving from verification_requests
	// (filtered to pending) allows the composite index on (status, submitted_at)
	// to be used for the initial filtered scan.
	//
	// vr.user_id is included so the admin UI can construct a deep-link to the
	// PG owner's profile page (/pg-owners/:userId/profile) from each queue row,
	// without requiring a second request.
	//
	// Explicit column selection: no SELECT * from a JOIN — ambiguous column names
	// and silent breakage on schema changes.
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

	// The extra row tells us whether there are more pages without a separate COUNT.
	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	// Build the cursor from the last item in the current page.
	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].submitted_at.toISOString(),
				cursorId: items[items.length - 1].request_id,
			}
		:	null;

	return { items, nextCursor };
};

// ─── Admin resolution ─────────────────────────────────────────────────────────

export const approveRequest = async (adminUserId, requestId, { adminNotes } = {}) => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Update the request row first.
		// AND status = 'pending' makes the transition conditional at the query level:
		// if two admins act simultaneously, one will get rowCount = 0 and receive a
		// 409 rather than both "succeeding" and producing a silent redundant write.
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
			// Either the request does not exist or it has already been reviewed.
			throw new AppError("Verification request not found or already resolved", 409);
		}

		const ownerId = requestRows[0].user_id;

		// Update the profile status in the same transaction.
		// Both writes must commit together — a partially-applied state (request
		// says 'verified' but profile still says 'pending') has no automated
		// recovery path and would leave the PG owner in an inconsistent state.
		// rowCount is checked here for the same reason as above: if the profile row
		// is absent or soft-deleted (data integrity issue or race with a hard-delete),
		// we must not commit — the verification_requests UPDATE would be orphaned.
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
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};

export const rejectRequest = async (adminUserId, requestId, { rejectionReason, adminNotes } = {}) => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		// Same conditional-transition pattern as approveRequest.
		// AND status = 'pending' is the concurrency safety net.
		const { rowCount, rows: requestRows } = await client.query(
			`
			UPDATE verification_requests
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

		// Write rejection_reason to the profile so the PG owner sees a meaningful
		// explanation when they check their status. Without this they would only
		// know they were rejected, not what to fix or resubmit.
		// rowCount checked for consistency with approveRequest — a missing or
		// soft-deleted profile row must abort the transaction, not silently commit
		// an orphaned verification_requests status change.
		const { rowCount: profileRowCount } = await client.query(
			`
			UPDATE pg_owner_profiles
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
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
};
