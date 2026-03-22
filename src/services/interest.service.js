// src/services/interest.service.js
//
// ─── SCHEMA COLUMN REFERENCE ─────────────────────────────────────────────────
//
// interest_requests columns (from roomies_db_setup.sql):
//   request_id        — PK (NOT interest_request_id)
//   sender_id         — the student who expressed interest (NOT student_id)
//   listing_id
//   message
//   status            — type: request_status_enum
//                       values: 'pending','accepted','declined','withdrawn','expired'
//   created_at, updated_at, deleted_at
//
// listings columns relevant here:
//   listing_id
//   posted_by         — the poster's user_id (NOT poster_id)
//   listing_type      — drives connection_type derivation
//   status
//   deleted_at
//
// connections.interest_request_id — nullable FK added in the Phase 3 migration.
//
// ─── NOTIFICATION DELIVERY ───────────────────────────────────────────────────
//
// Every state transition fires a post-commit notification through the shared
// enqueueNotification helper. A notification failure never rolls back a state
// change.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

const _buildWhatsAppLink = (phone, message) => {
	const encoded = encodeURIComponent(message);
	return `https://wa.me/${phone}?text=${encoded}`;
};

// ─── connection_type derivation ───────────────────────────────────────────────
const LISTING_TYPE_TO_CONNECTION_TYPE = {
	student_room: "student_roommate",
	pg_room: "pg_stay",
	hostel_bed: "hostel_stay",
};

// ─── Create interest request ─────────────────────────────────────────────────
export const createInterestRequest = async (studentId, listingId, data) => {
	const { message } = data;

	const { rows: listingRows } = await pool.query(
		`SELECT l.listing_id, l.posted_by, l.status, l.title, u.phone
     FROM listings l
     JOIN users u ON u.user_id = l.posted_by AND u.deleted_at IS NULL
     WHERE l.listing_id = $1 AND l.deleted_at IS NULL`,
		[listingId],
	);

	if (!listingRows.length) {
		throw new AppError("Listing not found", 404);
	}

	const listing = listingRows[0];

	if (listing.status !== "active") {
		throw new AppError("This listing is no longer accepting interest requests", 422);
	}

	if (listing.posted_by === studentId) {
		throw new AppError("You cannot express interest in your own listing", 422);
	}

	const { rows } = await pool.query(
		`INSERT INTO interest_requests
       (sender_id, listing_id, message, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (sender_id, listing_id)
       WHERE status IN ('pending', 'accepted')
         AND deleted_at IS NULL
     DO NOTHING
     RETURNING request_id, sender_id, listing_id, message, status, created_at`,
		[studentId, listingId, message ?? null],
	);

	if (!rows.length) {
		throw new AppError("You already have a pending or accepted interest request for this listing", 409);
	}

	const request = rows[0];

	logger.info({ studentId, listingId, requestId: request.request_id }, "Interest request created");

	enqueueNotification({
		recipientId: listing.posted_by,
		type: "interest_request_received",
		entityType: "interest_request",
		entityId: request.request_id,
	});

	return {
		interestRequestId: request.request_id,
		studentId: request.sender_id,
		listingId: request.listing_id,
		message: request.message,
		status: request.status,
		createdAt: request.created_at,
	};
};

// ─── Transition interest request status ──────────────────────────────────────
export const transitionInterestRequest = async (callerId, requestId, targetStatus) => {
	const ALLOWED_STATUSES = new Set(["accepted", "declined", "withdrawn"]);
	if (!ALLOWED_STATUSES.has(targetStatus)) {
		throw new AppError(`Invalid target status: ${targetStatus}`, 400);
	}

	if (targetStatus === "accepted") {
		return _acceptInterestRequest(callerId, requestId);
	}

	const ownershipClause = targetStatus === "declined" ? `AND l.posted_by = $2` : `AND ir.sender_id = $2`;

	const { rowCount, rows } = await pool.query(
		`UPDATE interest_requests ir
     SET status     = $3::request_status_enum,
         updated_at = NOW()
     FROM listings l
     WHERE ir.request_id  = $1
       AND ir.listing_id  = l.listing_id
       AND ir.status      = 'pending'
       AND ir.deleted_at  IS NULL
       ${ownershipClause}
     RETURNING
       ir.request_id,
       ir.sender_id,
       ir.listing_id,
       ir.status,
       ir.updated_at,
       l.posted_by`,
		[requestId, callerId, targetStatus],
	);

	if (rowCount === 0) {
		const { rows: checkRows } = await pool.query(
			`SELECT request_id, status, sender_id, listing_id FROM interest_requests
       WHERE request_id = $1 AND deleted_at IS NULL`,
			[requestId],
		);

		if (!checkRows.length) {
			throw new AppError("Interest request not found", 404);
		}

		const existing = checkRows[0];

		if (existing.status !== "pending") {
			throw new AppError(
				`Interest request cannot be ${targetStatus} — current status is '${existing.status}'`,
				409,
			);
		}

		throw new AppError("You are not authorised to perform this action", 403);
	}

	const ir = rows[0];

	logger.info({ callerId, requestId, targetStatus }, `Interest request ${targetStatus}`);

	if (targetStatus === "declined") {
		enqueueNotification({
			recipientId: ir.sender_id,
			type: "interest_request_declined",
			entityType: "interest_request",
			entityId: requestId,
		});
	} else if (targetStatus === "withdrawn") {
		enqueueNotification({
			recipientId: ir.posted_by,
			type: "interest_request_withdrawn",
			entityType: "interest_request",
			entityId: requestId,
		});
	}

	return {
		interestRequestId: ir.request_id,
		studentId: ir.sender_id,
		listingId: ir.listing_id,
		status: ir.status,
		updatedAt: ir.updated_at,
	};
};

// ─── Accept interest request (internal) ──────────────────────────────────────
const _acceptInterestRequest = async (posterId, requestId) => {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");

		const { rows: irRows } = await client.query(
			`SELECT
         ir.request_id,
         ir.sender_id,
         ir.listing_id,
         ir.status,
         l.posted_by,
         l.title AS listing_title,
         l.listing_type,
         CASE
           WHEN l.listing_type = 'student_room' THEN u_poster.phone
           ELSE pop.business_phone
         END AS poster_phone,
         COALESCE(pop.business_name, sp_poster.full_name, u_poster.email) AS poster_name
       FROM interest_requests ir
       JOIN listings l
         ON l.listing_id    = ir.listing_id
        AND l.deleted_at    IS NULL
       JOIN users u_poster
         ON u_poster.user_id = l.posted_by
        AND u_poster.deleted_at IS NULL
       LEFT JOIN student_profiles sp_poster
         ON sp_poster.user_id = l.posted_by
        AND sp_poster.deleted_at IS NULL
       LEFT JOIN pg_owner_profiles pop
         ON pop.user_id = l.posted_by
        AND pop.deleted_at IS NULL
       WHERE ir.request_id = $1
         AND ir.deleted_at IS NULL
       FOR UPDATE OF ir, l`,
			[requestId],
		);

		if (!irRows.length) {
			await client.query("ROLLBACK");
			throw new AppError("Interest request not found", 404);
		}

		const ir = irRows[0];

		if (ir.posted_by !== posterId) {
			await client.query("ROLLBACK");
			throw new AppError("You are not authorised to perform this action", 403);
		}

		if (ir.status !== "pending") {
			await client.query("ROLLBACK");
			throw new AppError(`Cannot accept a request with status '${ir.status}'`, 422);
		}

		await client.query(
			`UPDATE interest_requests
       SET status = 'accepted'::request_status_enum, updated_at = NOW()
       WHERE request_id = $1`,
			[requestId],
		);

		const connectionType = LISTING_TYPE_TO_CONNECTION_TYPE[ir.listing_type];
		if (!connectionType) {
			await client.query("ROLLBACK");
			throw new AppError(`Cannot derive connection type from listing_type '${ir.listing_type}'`, 422);
		}

		const { rows: connRows } = await client.query(
			`INSERT INTO connections
         (initiator_id, counterpart_id, listing_id, connection_type, interest_request_id)
       VALUES ($1, $2, $3, $4::connection_type_enum, $5)
       RETURNING connection_id`,
			[ir.sender_id, posterId, ir.listing_id, connectionType, requestId],
		);

		const connectionId = connRows[0].connection_id;

		await expirePendingRequestsForListing(ir.listing_id, client, requestId);

		await client.query("COMMIT");

		logger.info(
			{ posterId, requestId, connectionId, studentId: ir.sender_id },
			"Interest request accepted — connection created",
		);

		enqueueNotification({
			recipientId: ir.sender_id,
			type: "interest_request_accepted",
			entityType: "interest_request",
			entityId: requestId,
		});

		const whatsappLink =
			ir.poster_phone ?
				_buildWhatsAppLink(
					ir.poster_phone,
					`Hi ${ir.poster_name}, my interest request for ${ir.listing_title} was accepted!`,
				)
			:	null;

		return {
			interestRequestId: requestId,
			studentId: ir.sender_id,
			listingId: ir.listing_id,
			status: "accepted",
			connectionId,
			whatsappLink,
			whatsAppLink: whatsappLink,
		};
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.error({ rollbackErr }, "Failed to rollback accept transaction");
		}
		throw err;
	} finally {
		client.release();
	}
};

// ─── Get single interest request ─────────────────────────────────────────────
export const getInterestRequest = async (callerId, requestId) => {
	const { rows } = await pool.query(
		`SELECT
       ir.request_id,
       ir.sender_id,
       ir.listing_id,
       ir.message,
       ir.status,
       ir.created_at,
       ir.updated_at,
       l.posted_by,
       l.title        AS listing_title,
       l.city         AS listing_city,
       l.listing_type AS listing_type,
       COALESCE(sp.full_name, u_sender.email) AS sender_name,
       sp.profile_photo_url                   AS sender_photo_url
     FROM interest_requests ir
     JOIN listings l
       ON l.listing_id  = ir.listing_id
      AND l.deleted_at  IS NULL
     JOIN users u_sender
       ON u_sender.user_id   = ir.sender_id
      AND u_sender.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = ir.sender_id
      AND sp.deleted_at IS NULL
     WHERE ir.request_id = $1
       AND (ir.sender_id = $2 OR l.posted_by = $2)
       AND ir.deleted_at IS NULL`,
		[requestId, callerId],
	);

	if (!rows.length) {
		throw new AppError("Interest request not found", 404);
	}

	const row = rows[0];

	return {
		interestRequestId: row.request_id,
		studentId: row.sender_id,
		listingId: row.listing_id,
		message: row.message,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		listing: {
			listingId: row.listing_id,
			title: row.listing_title,
			city: row.listing_city,
			listingType: row.listing_type,
		},
		student: {
			userId: row.sender_id,
			fullName: row.sender_name,
			profilePhotoUrl: row.sender_photo_url,
		},
	};
};

// ─── Get interest requests for a listing (poster's view) ─────────────────────
export const getInterestRequestsForListing = async (posterId, listingId, filters) => {
	const { rows: listingRows } = await pool.query(
		`SELECT listing_id FROM listings
     WHERE listing_id = $1 AND posted_by = $2 AND deleted_at IS NULL`,
		[listingId, posterId],
	);

	if (!listingRows.length) {
		const { rows: existRows } = await pool.query(
			`SELECT listing_id FROM listings WHERE listing_id = $1 AND deleted_at IS NULL`,
			[listingId],
		);
		if (!existRows.length) throw new AppError("Listing not found", 404);
		throw new AppError("You do not own this listing", 403);
	}

	const { status, cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [`ir.listing_id = $1`, `ir.deleted_at IS NULL`];
	const params = [listingId];
	let p = 2;

	if (status !== undefined) {
		clauses.push(`ir.status = $${p}::request_status_enum`);
		params.push(status);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(ir.created_at < $${p} OR (ir.created_at = $${p} AND ir.request_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);

	const { rows } = await pool.query(
		`SELECT
       ir.request_id,
       ir.sender_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       COALESCE(sp.full_name, u.email) AS sender_name,
       sp.profile_photo_url            AS sender_photo_url,
       u.average_rating                AS sender_rating
     FROM interest_requests ir
     JOIN users u
       ON u.user_id    = ir.sender_id
      AND u.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = ir.sender_id
      AND sp.deleted_at IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY ir.created_at DESC, ir.request_id ASC
     LIMIT $${p}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].request_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			interestRequestId: row.request_id,
			studentId: row.sender_id,
			status: row.status,
			message: row.message,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			student: {
				userId: row.sender_id,
				fullName: row.sender_name,
				profilePhotoUrl: row.sender_photo_url,
				averageRating: row.sender_rating,
			},
		})),
		nextCursor,
	};
};

// ─── Get my interest requests (student's view) ───────────────────────────────
export const getMyInterestRequests = async (studentId, filters) => {
	const { status, cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [`ir.sender_id = $1`, `ir.deleted_at IS NULL`];
	const params = [studentId];
	let p = 2;

	if (status !== undefined) {
		clauses.push(`ir.status = $${p}::request_status_enum`);
		params.push(status);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(ir.created_at < $${p} OR (ir.created_at = $${p} AND ir.request_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);

	const { rows } = await pool.query(
		`SELECT
       ir.request_id,
       ir.listing_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       l.title          AS listing_title,
       l.city           AS listing_city,
       l.listing_type   AS listing_type,
       l.rent_per_month AS listing_rent_per_month
     FROM interest_requests ir
     JOIN listings l
       ON l.listing_id = ir.listing_id
      AND l.deleted_at IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY ir.created_at DESC, ir.request_id ASC
     LIMIT $${p}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].request_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			interestRequestId: row.request_id,
			listingId: row.listing_id,
			status: row.status,
			message: row.message,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			listing: {
				listingId: row.listing_id,
				title: row.listing_title,
				city: row.listing_city,
				listingType: row.listing_type,
				rentPerMonth: row.listing_rent_per_month != null ? row.listing_rent_per_month / 100 : null,
			},
		})),
		nextCursor,
	};
};

// ─── Expire pending requests for a listing ───────────────────────────────────
export const expirePendingRequestsForListing = async (listingId, client = pool, excludeRequestId = null) => {
	const params = [listingId];
	let excludeClause = "";

	if (excludeRequestId) {
		params.push(excludeRequestId);
		excludeClause = `AND request_id != $2`;
	}

	const { rowCount } = await client.query(
		`UPDATE interest_requests
     SET status = 'expired'::request_status_enum, updated_at = NOW()
     WHERE listing_id = $1
       AND status     = 'pending'
       AND deleted_at IS NULL
       ${excludeClause}`,
		params,
	);

	if (rowCount > 0) {
		logger.info({ listingId, expiredCount: rowCount }, "Pending interest requests expired for listing");
	}

	return rowCount;
};
