// src/services/interest.service.js
//
// ─── SCHEMA COLUMN REFERENCE ─────────────────────────────────────────────────
//
// interest_requests columns (from roomies_db_setup.sql):
//   request_id        — PK (NOT interest_request_id)
//   sender_id         — the student who expressed interest (NOT student_id)
//   listing_id
//   message
//   status            — type: request_status_enum (NOT interest_request_status_enum)
//                       values: 'pending','accepted','declined','withdrawn'
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
// Every state transition fires a post-commit notification via BullMQ — never
// inside a transaction. A notification failure never rolls back a state change.

import { Queue } from "bullmq";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { NOTIFICATION_QUEUE_NAME } from "../workers/notificationWorker.js";
import { config } from "../config/env.js";

// ─── Queue singleton ──────────────────────────────────────────────────────────
const _redisConn = new URL(config.REDIS_URL);
const notificationQueue = new Queue(NOTIFICATION_QUEUE_NAME, {
	connection: {
		host: _redisConn.hostname,
		port: parseInt(_redisConn.port || "6379", 10),
		password: _redisConn.password || undefined,
		tls: _redisConn.protocol === "rediss:" ? {} : undefined,
	},
	defaultJobOptions: {
		attempts: 5,
		backoff: { type: "exponential", delay: 2000 },
		removeOnComplete: 100,
		removeOnFail: 200,
	},
});

const _enqueueNotification = (payload) => {
	notificationQueue.add("send-notification", payload).catch((err) => {
		logger.error({ err, ...payload }, "Failed to enqueue notification");
	});
};

const _buildWhatsAppLink = (phone, message) => {
	const encoded = encodeURIComponent(message);
	return `https://wa.me/${phone}?text=${encoded}`;
};

// ─── connection_type derivation ───────────────────────────────────────────────
// Maps listing_type → connection_type exactly as defined in the schema enum.
const LISTING_TYPE_TO_CONNECTION_TYPE = {
	student_room: "student_roommate",
	pg_room: "pg_stay",
	hostel_bed: "hostel_stay",
};

// ─── Create interest request ─────────────────────────────────────────────────
//
// A student expresses interest in a listing. The service receives data as an
// object and destructures { message } from it — the controller must pass a
// plain object (req.body ?? {}) not a raw string.
//
// The schema's partial unique index prevents duplicate pending/accepted requests
// from the same sender to the same listing:
//   idx_interest_requests_no_duplicates ON interest_requests (sender_id, listing_id)
//   WHERE status IN ('pending','accepted') AND deleted_at IS NULL
//
// We use INSERT … ON CONFLICT DO NOTHING to leverage that index atomically
// rather than a prior SELECT check, which would have a TOCTOU race window.
export const createInterestRequest = async (studentId, listingId, data) => {
	const { message } = data;

	// Verify listing exists, is active, and collect the poster's contact info.
	// The schema column is posted_by (not poster_id).
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

	// Single atomic INSERT that relies on the partial unique index as the
	// duplicate guard. ON CONFLICT DO NOTHING means a duplicate active request
	// simply returns zero rows — we surface a 409 in that case.
	//
	// Schema PK is request_id (not interest_request_id).
	// Schema column for the student is sender_id (not student_id).
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

	// Notify the poster — post-commit, fire-and-forget.
	_enqueueNotification({
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
//
// Routes to the appropriate handler based on targetStatus.
// The schema enum is request_status_enum with values:
//   pending, accepted, declined, withdrawn
// (no 'expired' here — that is system-only via cron/listing-delete path)
export const transitionInterestRequest = async (callerId, requestId, targetStatus) => {
	const ALLOWED_STATUSES = new Set(["accepted", "declined", "withdrawn"]);
	if (!ALLOWED_STATUSES.has(targetStatus)) {
		throw new AppError(`Invalid target status: ${targetStatus}`, 400);
	}

	if (targetStatus === "accepted") {
		return _acceptInterestRequest(callerId, requestId);
	}

	// 'declined' → poster only; 'withdrawn' → sender only.
	// The ownership clause is embedded in the UPDATE WHERE so the correct party
	// check and the state mutation are a single atomic operation.
	//
	// Schema: sender_id (not student_id), posted_by (not poster_id),
	//         status type cast to request_status_enum.
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
		// Distinguish 404 (not found) / 409 (wrong state) / 403 (wrong party).
		// Three-way check: first look up the row, then check status, then ownership.
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
			// The request exists but is no longer in a transitionable state.
			throw new AppError(
				`Interest request cannot be ${targetStatus} — current status is '${existing.status}'`,
				409,
			);
		}

		// Row is pending but the caller is neither sender nor poster for this
		// transition direction.
		throw new AppError("You are not authorised to perform this action", 403);
	}

	const ir = rows[0];

	logger.info({ callerId, requestId, targetStatus }, `Interest request ${targetStatus}`);

	if (targetStatus === "declined") {
		_enqueueNotification({
			recipientId: ir.sender_id,
			type: "interest_request_declined",
			entityType: "interest_request",
			entityId: requestId,
		});
	} else if (targetStatus === "withdrawn") {
		_enqueueNotification({
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
//
// Atomically: mark request accepted + create connection + expire other pending
// requests for the same listing. All three inside one BEGIN/COMMIT.
//
// Row-locking strategy: we lock BOTH the interest_request row AND the listing
// row (FOR UPDATE OF ir, l) to serialize concurrent acceptance attempts. Without
// locking the listing, two concurrent accepts against different ir rows for the
// same listing could both proceed and create two connections for one listing.
const _acceptInterestRequest = async (posterId, requestId) => {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");

		// Lock both ir and l to prevent concurrent acceptance of any request
		// on the same listing. FOR UPDATE OF ir, l acquires row-level locks on
		// both tables inside this transaction.
		//
		// Column names: sender_id (schema), posted_by on listings (schema),
		// request_id PK (schema).
		const { rows: irRows } = await client.query(
			`SELECT
         ir.request_id,
         ir.sender_id,
         ir.listing_id,
         ir.status,
         l.posted_by,
         l.listing_type,
         u_poster.phone  AS poster_phone,
         u_sender.phone  AS sender_phone,
         COALESCE(sp.full_name, u_sender.email) AS sender_name
       FROM interest_requests ir
       JOIN listings l
         ON l.listing_id    = ir.listing_id
        AND l.deleted_at    IS NULL
       JOIN users u_poster
         ON u_poster.user_id = l.posted_by
        AND u_poster.deleted_at IS NULL
       JOIN users u_sender
         ON u_sender.user_id = ir.sender_id
        AND u_sender.deleted_at IS NULL
       LEFT JOIN student_profiles sp
         ON sp.user_id    = ir.sender_id
        AND sp.deleted_at IS NULL
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

		// Step 1: Mark this request accepted.
		// Cast to request_status_enum — the schema enum name, not interest_request_status_enum.
		await client.query(
			`UPDATE interest_requests
       SET status = 'accepted'::request_status_enum, updated_at = NOW()
       WHERE request_id = $1`,
			[requestId],
		);

		// Step 2: Derive connection_type from listing_type.
		const connectionType = LISTING_TYPE_TO_CONNECTION_TYPE[ir.listing_type];
		if (!connectionType) {
			await client.query("ROLLBACK");
			throw new AppError(`Cannot derive connection type from listing_type '${ir.listing_type}'`, 422);
		}

		// Step 3: Create the connection row.
		// initiator = sender (student), counterpart = poster (PG owner).
		// interest_request_id FK uses request_id from interest_requests.
		const { rows: connRows } = await client.query(
			`INSERT INTO connections
         (initiator_id, counterpart_id, listing_id, connection_type, interest_request_id)
       VALUES ($1, $2, $3, $4::connection_type_enum, $5)
       RETURNING connection_id`,
			[ir.sender_id, posterId, ir.listing_id, connectionType, requestId],
		);

		const connectionId = connRows[0].connection_id;

		// Step 4: Expire all other pending requests for this listing.
		await expirePendingRequestsForListing(ir.listing_id, client, requestId);

		await client.query("COMMIT");

		logger.info(
			{ posterId, requestId, connectionId, studentId: ir.sender_id },
			"Interest request accepted — connection created",
		);

		// Post-commit notification to the sender.
		_enqueueNotification({
			recipientId: ir.sender_id,
			type: "interest_request_accepted",
			entityType: "interest_request",
			entityId: requestId,
		});

		const whatsAppLink =
			ir.sender_phone ?
				_buildWhatsAppLink(ir.sender_phone, `Hi ${ir.sender_name}, your interest request has been accepted!`)
			:	null;

		return {
			interestRequestId: requestId,
			studentId: ir.sender_id,
			listingId: ir.listing_id,
			status: "accepted",
			connectionId,
			whatsAppLink,
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
//
// Access restricted to the two parties (sender and listing poster).
// Third parties get 404. Schema columns: request_id, sender_id, posted_by.
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
	// Verify ownership — 403 if not theirs, 404 if not found.
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
//
// Called from _acceptInterestRequest (exclude the just-accepted request) and
// from listing.service.js deleteListing / updateListingStatus (no exclusion).
// Accepts an optional client for transaction participation.
//
// Schema: request_id PK, sender_id, status (request_status_enum).
export const expirePendingRequestsForListing = async (listingId, client = pool, excludeRequestId = null) => {
	const params = [listingId];
	let excludeClause = "";

	if (excludeRequestId) {
		params.push(excludeRequestId);
		excludeClause = `AND request_id != $2`;
	}

	const { rowCount } = await client.query(
		`UPDATE interest_requests
     SET status = 'withdrawn'::request_status_enum, updated_at = NOW()
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
