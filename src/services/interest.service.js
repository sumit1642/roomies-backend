// src/services/interest.service.js
//
// ─── WHAT THIS SERVICE DOES ───────────────────────────────────────────────────
//
// Manages the full lifecycle of an interest request between a student and a
// listing poster. An interest request moves through a strict state machine:
//
//   pending → accepted  (poster action)   → creates a connections row atomically
//   pending → declined  (poster action)
//   pending → withdrawn (requester action)
//   pending → expired   (cron / listing deletion)
//
// Connections are only ever created inside _acceptInterestRequest, which runs
// inside an explicit transaction. This is the trust pipeline — the connection
// row is the proof that a real interaction was brokered through the platform,
// which is what makes Phase 4 ratings trustworthy.
//
// ─── NOTIFICATION DELIVERY ───────────────────────────────────────────────────
//
// Every state transition that matters to a user fires a post-commit
// notification via BullMQ. The job is enqueued after the transaction commits
// (or after the single-statement UPDATE returns), never inside a transaction.
//
// Why post-commit? If you enqueue inside a transaction and the transaction
// later rolls back, the job is already in Redis and the worker fires a
// notification for an event that never happened. Post-commit enqueue means
// the state change is durable first; the notification side-effect can fail
// independently without corrupting state.
//
// queue.add() calls use .catch() because Redis can be momentarily unreachable.
// A lost enqueue means a missed in-app notification — a UX inconvenience, not
// a data integrity failure. The connection row (or the status change row) is
// always durable in PostgreSQL regardless of the queue.
//
// ─── THE expirePendingRequestsForListing EXCEPTION ───────────────────────────
//
// expirePendingRequestsForListing runs inside a transaction called by the
// listing service (deleteListing / updateListingStatus). Notifications to the
// senders of those expired requests should fire post-commit from the *caller*,
// not from inside this function. Doing it here would require querying the
// sender IDs and enqueueing inside the caller's transaction, which creates the
// exact post-commit problem described above. This is deferred to Phase 5 cron
// work where listing expiry is handled systematically.

import { Queue } from "bullmq";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { NOTIFICATION_QUEUE_NAME } from "../workers/notificationWorker.js";
import { config } from "../config/env.js";

// ─── Queue singleton ──────────────────────────────────────────────────────────
// Lightweight until .add() is called — safe to construct at module scope.
// Shared across all functions in this module.
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

// ─── Internal helper: enqueue notification (fire-and-forget) ─────────────────
// Centralises the .catch() error logging so individual call sites stay clean.
const _enqueueNotification = (payload) => {
	notificationQueue.add("send-notification", payload).catch((err) => {
		logger.error({ err, ...payload }, "Failed to enqueue notification");
	});
};

// ─── WhatsApp deep-link helper ────────────────────────────────────────────────
// Generates a wa.me URL pre-filled with an introduction message. Used when
// building the accepted-state response so the student can contact the poster
// immediately without leaving the app.
const _buildWhatsAppLink = (phone, message) => {
	const encoded = encodeURIComponent(message);
	return `https://wa.me/${phone}?text=${encoded}`;
};

// ─── Create interest request ─────────────────────────────────────────────────
//
// A student expresses interest in a listing. The listing must be active and
// must not already have a pending/accepted interest request from this student.
//
// On success: notifies the listing poster that a new request arrived.
export const createInterestRequest = async (studentId, listingId, data) => {
	const { message } = data;

	// Verify listing exists, is active, and belongs to a real poster.
	const { rows: listingRows } = await pool.query(
		`SELECT l.listing_id, l.poster_id, l.status, l.title, u.phone
     FROM listings l
     JOIN users u ON u.user_id = l.poster_id AND u.deleted_at IS NULL
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

	if (listing.poster_id === studentId) {
		throw new AppError("You cannot express interest in your own listing", 422);
	}

	// Idempotency guard: one pending/accepted request per student per listing.
	// Using INSERT ... ON CONFLICT rather than a prior SELECT to avoid the
	// TOCTOU race where two concurrent requests both pass the SELECT check.
	const { rows } = await pool.query(
		`INSERT INTO interest_requests
       (student_id, listing_id, message, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (student_id, listing_id)
       WHERE status IN ('pending', 'accepted')
     DO NOTHING
     RETURNING interest_request_id, student_id, listing_id, message, status, created_at`,
		[studentId, listingId, message ?? null],
	);

	if (!rows.length) {
		throw new AppError("You already have a pending or accepted interest request for this listing", 409);
	}

	const request = rows[0];

	logger.info({ studentId, listingId, interestRequestId: request.interest_request_id }, "Interest request created");

	// Notify the poster that a new request arrived — post-commit, fire-and-forget.
	_enqueueNotification({
		recipientId: listing.poster_id,
		type: "interest_request_received",
		entityType: "interest_request",
		entityId: request.interest_request_id,
	});

	return {
		interestRequestId: request.interest_request_id,
		studentId: request.student_id,
		listingId: request.listing_id,
		message: request.message,
		status: request.status,
		createdAt: request.created_at,
	};
};

// ─── Transition interest request status ──────────────────────────────────────
//
// Handles declined, withdrawn, and the routing to _acceptInterestRequest for
// the accepted transition (which requires its own transaction).
//
// Access rules:
//   accepted / declined  — poster only
//   withdrawn            — student (requester) only
//
// The 404/403 discipline: non-existent requests return 404; requests that
// exist but don't belong to the caller return 403 (unlike connections, which
// use 404 for both — interest requests are more discoverable so 403 is safe).
export const transitionInterestRequest = async (callerId, interestRequestId, targetStatus) => {
	const ALLOWED_STATUSES = new Set(["accepted", "declined", "withdrawn"]);
	if (!ALLOWED_STATUSES.has(targetStatus)) {
		throw new AppError(`Invalid target status: ${targetStatus}`, 400);
	}

	if (targetStatus === "accepted") {
		return _acceptInterestRequest(callerId, interestRequestId);
	}

	// declined or withdrawn — a simple single-statement UPDATE.
	// The WHERE clause enforces both existence and ownership:
	//   declined  → poster_id = callerId (only the poster can decline)
	//   withdrawn → student_id = callerId (only the requester can withdraw)
	const ownershipClause = targetStatus === "declined" ? `AND l.poster_id = $2` : `AND ir.student_id = $2`;

	const { rowCount, rows } = await pool.query(
		`UPDATE interest_requests ir
     SET status     = $3::interest_request_status_enum,
         updated_at = NOW()
     FROM listings l
     WHERE ir.interest_request_id = $1
       AND ir.listing_id          = l.listing_id
       AND ir.status              = 'pending'
       AND ir.deleted_at          IS NULL
       ${ownershipClause}
     RETURNING
       ir.interest_request_id,
       ir.student_id,
       ir.listing_id,
       ir.status,
       ir.updated_at,
       l.poster_id`,
		[interestRequestId, callerId, targetStatus],
	);

	if (rowCount === 0) {
		// Either the request doesn't exist, isn't pending, or the caller isn't the
		// correct party. Distinguish 404 vs 403 with a follow-up read.
		const { rows: checkRows } = await pool.query(
			`SELECT interest_request_id FROM interest_requests
       WHERE interest_request_id = $1 AND deleted_at IS NULL`,
			[interestRequestId],
		);
		if (!checkRows.length) throw new AppError("Interest request not found", 404);
		throw new AppError("You are not authorised to perform this action", 403);
	}

	const ir = rows[0];

	logger.info({ callerId, interestRequestId, targetStatus }, `Interest request ${targetStatus}`);

	// Notify the other party of the transition.
	// For declined: notify the student that their request was turned down.
	// For withdrawn: notify the poster that the request was pulled back.
	if (targetStatus === "declined") {
		_enqueueNotification({
			recipientId: ir.student_id,
			type: "interest_request_declined",
			entityType: "interest_request",
			entityId: interestRequestId,
		});
	} else if (targetStatus === "withdrawn") {
		_enqueueNotification({
			recipientId: ir.poster_id,
			type: "interest_request_withdrawn",
			entityType: "interest_request",
			entityId: interestRequestId,
		});
	}

	return {
		interestRequestId: ir.interest_request_id,
		studentId: ir.student_id,
		listingId: ir.listing_id,
		status: ir.status,
		updatedAt: ir.updated_at,
	};
};

// ─── Accept interest request (internal — called by transitionInterestRequest) ─
//
// The most complex operation in this service. Accepting a request must
// atomically:
//   1. Mark the interest request as accepted.
//   2. Create the connections row.
//   3. Expire all other pending requests for the same listing.
//   4. (Optionally) mark the listing as filled.
//
// Steps 1–3 run inside an explicit transaction so they either all commit or
// all roll back. A crash between any two steps leaves the DB in a consistent
// state (no orphaned accepted request without a connection, no dangling
// pending requests for a listing that's been filled).
//
// Post-commit: notify the student that their request was accepted.
const _acceptInterestRequest = async (posterId, interestRequestId) => {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");

		// Lock the interest request row for update. This prevents a second
		// concurrent acceptance of the same request from racing through.
		const { rows: irRows } = await client.query(
			`SELECT
         ir.interest_request_id,
         ir.student_id,
         ir.listing_id,
         ir.status,
         l.poster_id,
         l.connection_type,
         u_poster.phone AS poster_phone,
         u_student.phone AS student_phone,
         COALESCE(sp.full_name, u_student.email) AS student_name
       FROM interest_requests ir
       JOIN listings l
         ON l.listing_id    = ir.listing_id
        AND l.deleted_at    IS NULL
       JOIN users u_poster
         ON u_poster.user_id = l.poster_id
        AND u_poster.deleted_at IS NULL
       JOIN users u_student
         ON u_student.user_id = ir.student_id
        AND u_student.deleted_at IS NULL
       LEFT JOIN student_profiles sp
         ON sp.user_id    = ir.student_id
        AND sp.deleted_at IS NULL
       WHERE ir.interest_request_id = $1
         AND ir.deleted_at          IS NULL
       FOR UPDATE OF ir`,
			[interestRequestId],
		);

		if (!irRows.length) {
			await client.query("ROLLBACK");
			throw new AppError("Interest request not found", 404);
		}

		const ir = irRows[0];

		if (ir.poster_id !== posterId) {
			await client.query("ROLLBACK");
			throw new AppError("You are not authorised to perform this action", 403);
		}

		if (ir.status !== "pending") {
			await client.query("ROLLBACK");
			throw new AppError(`Cannot accept a request with status '${ir.status}'`, 422);
		}

		// Step 1: Mark this request as accepted.
		await client.query(
			`UPDATE interest_requests
       SET status = 'accepted', updated_at = NOW()
       WHERE interest_request_id = $1`,
			[interestRequestId],
		);

		// Step 2: Create the connection row.
		// initiator = student (the one who expressed interest)
		// counterpart = poster (the one who accepted)
		// connection_type comes from the listing (pg_stay, hostel_stay, etc.)
		const { rows: connRows } = await client.query(
			`INSERT INTO connections
         (initiator_id, counterpart_id, listing_id, connection_type, interest_request_id)
       VALUES ($1, $2, $3, $4::connection_type_enum, $5)
       RETURNING connection_id`,
			[ir.student_id, posterId, ir.listing_id, ir.connection_type, interestRequestId],
		);

		const connectionId = connRows[0].connection_id;

		// Step 3: Expire all other pending requests for this listing.
		// This prevents a listing from accumulating accepted connections
		// (one listing → one connection is the intended invariant for most types).
		await expirePendingRequestsForListing(ir.listing_id, client, interestRequestId);

		await client.query("COMMIT");

		logger.info(
			{ posterId, interestRequestId, connectionId, studentId: ir.student_id },
			"Interest request accepted — connection created",
		);

		// Post-commit: notify the student. The transaction is committed so the
		// connection row is durable regardless of whether this enqueue succeeds.
		_enqueueNotification({
			recipientId: ir.student_id,
			type: "interest_request_accepted",
			entityType: "interest_request",
			entityId: interestRequestId,
		});

		// Build a WhatsApp deep-link so the poster can contact the student
		// immediately. The link is returned in the response body; it is not stored.
		const whatsAppLink =
			ir.student_phone ?
				_buildWhatsAppLink(ir.student_phone, `Hi ${ir.student_name}, your interest request has been accepted!`)
			:	null;

		return {
			interestRequestId,
			studentId: ir.student_id,
			listingId: ir.listing_id,
			status: "accepted",
			connectionId,
			whatsAppLink,
		};
	} catch (err) {
		// ROLLBACK is safe to call even if the transaction was already rolled back
		// (e.g. from the explicit ROLLBACK calls above) — it becomes a no-op.
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
// Returns full detail for one interest request. Access is restricted to the
// two parties (student and listing poster). Third parties get 404.
export const getInterestRequest = async (callerId, interestRequestId) => {
	const { rows } = await pool.query(
		`SELECT
       ir.interest_request_id,
       ir.student_id,
       ir.listing_id,
       ir.message,
       ir.status,
       ir.created_at,
       ir.updated_at,
       l.poster_id,
       l.title        AS listing_title,
       l.city         AS listing_city,
       l.listing_type AS listing_type,
       COALESCE(sp.full_name, u_student.email) AS student_name,
       sp.profile_photo_url                    AS student_photo_url
     FROM interest_requests ir
     JOIN listings l
       ON l.listing_id  = ir.listing_id
      AND l.deleted_at  IS NULL
     JOIN users u_student
       ON u_student.user_id   = ir.student_id
      AND u_student.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = ir.student_id
      AND sp.deleted_at IS NULL
     WHERE ir.interest_request_id = $1
       AND (ir.student_id = $2 OR l.poster_id = $2)
       AND ir.deleted_at IS NULL`,
		[interestRequestId, callerId],
	);

	if (!rows.length) {
		throw new AppError("Interest request not found", 404);
	}

	const row = rows[0];

	return {
		interestRequestId: row.interest_request_id,
		studentId: row.student_id,
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
			userId: row.student_id,
			fullName: row.student_name,
			profilePhotoUrl: row.student_photo_url,
		},
	};
};

// ─── Get interest requests for a listing (poster's view) ─────────────────────
//
// Returns all interest requests for a listing. Restricted to the listing's
// poster. Supports optional status filter and keyset pagination.
export const getInterestRequestsForListing = async (posterId, listingId, filters) => {
	// Verify poster ownership first — 403 if they don't own it, 404 if not found.
	const { rows: listingRows } = await pool.query(
		`SELECT listing_id FROM listings
     WHERE listing_id = $1 AND poster_id = $2 AND deleted_at IS NULL`,
		[listingId, posterId],
	);

	if (!listingRows.length) {
		// Could be 404 (doesn't exist) or 403 (not their listing). Use a follow-up
		// query to distinguish, consistent with the rest of the codebase.
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
		clauses.push(`ir.status = $${p}::interest_request_status_enum`);
		params.push(status);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(ir.created_at < $${p} OR (ir.created_at = $${p} AND ir.interest_request_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);

	const { rows } = await pool.query(
		`SELECT
       ir.interest_request_id,
       ir.student_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       COALESCE(sp.full_name, u.email) AS student_name,
       sp.profile_photo_url            AS student_photo_url,
       u.average_rating                AS student_rating
     FROM interest_requests ir
     JOIN users u
       ON u.user_id    = ir.student_id
      AND u.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = ir.student_id
      AND sp.deleted_at IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY ir.created_at DESC, ir.interest_request_id ASC
     LIMIT $${p}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].interest_request_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			interestRequestId: row.interest_request_id,
			studentId: row.student_id,
			status: row.status,
			message: row.message,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			student: {
				userId: row.student_id,
				fullName: row.student_name,
				profilePhotoUrl: row.student_photo_url,
				averageRating: row.student_rating,
			},
		})),
		nextCursor,
	};
};

// ─── Get my interest requests (student's view) ───────────────────────────────
//
// Returns all interest requests the authenticated student has submitted,
// newest first. Supports optional status filter and keyset pagination.
export const getMyInterestRequests = async (studentId, filters) => {
	const { status, cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [`ir.student_id = $1`, `ir.deleted_at IS NULL`];
	const params = [studentId];
	let p = 2;

	if (status !== undefined) {
		clauses.push(`ir.status = $${p}::interest_request_status_enum`);
		params.push(status);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(ir.created_at < $${p} OR (ir.created_at = $${p} AND ir.interest_request_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);

	const { rows } = await pool.query(
		`SELECT
       ir.interest_request_id,
       ir.listing_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       l.title        AS listing_title,
       l.city         AS listing_city,
       l.listing_type AS listing_type,
       l.rent_per_month AS listing_rent_per_month
     FROM interest_requests ir
     JOIN listings l
       ON l.listing_id = ir.listing_id
      AND l.deleted_at IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY ir.created_at DESC, ir.interest_request_id ASC
     LIMIT $${p}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].interest_request_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			interestRequestId: row.interest_request_id,
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
// Marks all pending interest requests for a listing as 'expired'. Called from:
//   - _acceptInterestRequest (after one request is accepted — others expire)
//   - listing.service.js deleteListing and updateListingStatus (inside their
//     transactions, so this function accepts an optional client parameter)
//
// The excludeRequestId parameter prevents the just-accepted request from being
// expired in the same call — _acceptInterestRequest passes the accepted ID here.
//
// NOTIFICATION NOTE: This function does NOT enqueue notifications to the
// affected senders. Those notifications should fire post-commit from the
// calling context (listing service), but doing so requires knowing the
// sender IDs at that call site. This is deferred to Phase 5 cron work.
// See the module-level comment for full reasoning.
export const expirePendingRequestsForListing = async (listingId, client = pool, excludeRequestId = null) => {
	const params = [listingId];
	let excludeClause = "";

	if (excludeRequestId) {
		params.push(excludeRequestId);
		excludeClause = `AND interest_request_id != $2`;
	}

	const { rowCount } = await client.query(
		`UPDATE interest_requests
     SET status = 'expired', updated_at = NOW()
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
