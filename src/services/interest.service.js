// src/services/interest.service.js
//
//
// ─── THE STATE MACHINE ────────────────────────────────────────────────────────
//
// States:  pending → accepted | declined | withdrawn
//          accepted → declined | withdrawn
//          declined → (terminal)
//          withdrawn → (terminal)
//          expired → (terminal, system-set only)
//
// Who can trigger which transitions:
//   student (requester): pending → withdrawn, accepted → withdrawn
//   poster  (responder): pending → accepted,  pending → declined, accepted → declined
//
// The ALLOWED_TRANSITIONS map below is the single source of truth for this logic.
// Any code that needs to know "can actor X move from state Y to state Z?" should
// consult this map — never inline the logic elsewhere.

//
// ─── NOTIFICATION HOOKS ──────────────────────────────────────────────────────
//
// Every state transition is an event the other party cares about. In Phase 3
// the notification calls below will be replaced with notificationQueue.add(...)
// from the notification worker. Nothing in the state machine logic changes when
// that happens — notifications are side effects that run after the transaction
// commits, never inside it.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const ALLOWED_TRANSITIONS = {
	student: {
		pending: ["withdrawn"],
		accepted: ["withdrawn"],
	},
	poster: {
		pending: ["accepted", "declined"],
		accepted: ["declined"],
	},
};

// Maps listing_type → connection_type as defined by the schema enum.
// Called inside the accepted transition to derive the correct connection_type.
const LISTING_TYPE_TO_CONNECTION_TYPE = {
	student_room: "student_roommate",
	pg_room: "pg_stay",
	hostel_bed: "hostel_stay",
};

const fetchInterestWithContext = async (interestId, client = pool) => {
	const { rows } = await client.query(
		`SELECT
       ir.interest_id,
       ir.sender_id,
       ir.listing_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       l.posted_by AS poster_id,
       l.title     AS listing_title
     FROM interest_requests ir
     JOIN listings l ON l.listing_id = ir.listing_id
     WHERE ir.interest_id = $1
       AND ir.deleted_at  IS NULL`,
		[interestId],
	);
	return rows[0] ?? null;
};

const resolveActorRole = (callerId, row) => {
	if (callerId === row.sender_id) return "student";
	if (callerId === row.poster_id) return "poster";
	return null;
};

const toStudentInterestShape = (row) => ({
	interestId: row.interest_id,
	status: row.status,
	message: row.message,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	listing: {
		listingId: row.listing_id,
		title: row.listing_title,
		city: row.listing_city,
		locality: row.listing_locality,
		rentPerMonth: row.rent_per_month / 100, // paise → rupees
		roomType: row.room_type,
		listingType: row.listing_type,
		coverPhotoUrl: row.cover_photo_url,
		posterName: row.poster_name,
		posterRating: row.poster_rating,
		propertyName: row.property_name,
	},
});

const toPosterInterestShape = (row) => ({
	interestId: row.interest_id,
	status: row.status,
	message: row.message,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	student: {
		userId: row.sender_id,
		fullName: row.student_name,
		institution: row.student_institution,
		profilePhotoUrl: row.student_photo_url,
		averageRating: row.student_rating,
		ratingCount: row.student_rating_count,
	},
});

// ─── WhatsApp helpers ─────────────────────────────────────────────────────────

// Fetches the poster's public contact phone number for the WhatsApp deep-link.
// PG owners expose business_phone; students and PG owners without business_phone
// fall back to users.phone. Returns null if no number is on record — a missing
// number is a data quality issue, not a transaction failure.
const fetchPosterWhatsApp = async (posterId) => {
	// Try pg_owner_profiles.business_phone first (public-facing contact)
	const { rows: ownerRows } = await pool.query(
		`SELECT business_phone FROM pg_owner_profiles
     WHERE user_id = $1 AND deleted_at IS NULL`,
		[posterId],
	);
	if (ownerRows.length && ownerRows[0].business_phone) {
		return ownerRows[0].business_phone;
	}

	// Fall back to users.phone (covers student posters)
	const { rows: userRows } = await pool.query(`SELECT phone FROM users WHERE user_id = $1 AND deleted_at IS NULL`, [
		posterId,
	]);
	return userRows.length && userRows[0].phone ? userRows[0].phone : null;
};

// Normalises a raw phone string into a wa.me deep-link.
// Strips non-digits and prepends India country code (91) if absent.
// Returns null for empty/null input so callers can propagate null cleanly.
const buildWhatsAppLink = (rawPhone) => {
	if (!rawPhone) return null;
	const digits = rawPhone.replace(/\D/g, "");
	if (!digits) return null;
	// If the number already carries the country code (≥11 digits starting with 91)
	// use it as-is; otherwise prepend 91 (India default).
	const normalized = digits.length >= 11 ? digits : `91${digits}`;
	return `https://wa.me/${normalized}`;
};

// ─── Create interest request ──────────────────────────────────────────────────

export const createInterestRequest = async (studentId, listingId, message) => {
	// Guard 1: listing must be active and not expired.
	const { rows: listingRows } = await pool.query(
		`SELECT posted_by, title
     FROM listings
     WHERE listing_id = $1
       AND status     = 'active'
       AND deleted_at IS NULL
       AND expires_at > NOW()`,
		[listingId],
	);

	if (!listingRows.length) {
		throw new AppError("Listing not found or no longer active", 404);
	}

	// Guard 2: a student cannot express interest in their own listing.
	if (listingRows[0].posted_by === studentId) {
		throw new AppError("You cannot express interest in your own listing", 422);
	}

	// Guard 3: check for an existing active request — gives a better error than
	// letting the partial unique index produce a raw 23505.
	const { rows: existingRows } = await pool.query(
		`SELECT interest_id, status
     FROM interest_requests
     WHERE sender_id  = $1
       AND listing_id = $2
       AND status IN ('pending', 'accepted')
       AND deleted_at IS NULL`,
		[studentId, listingId],
	);

	if (existingRows.length) {
		throw new AppError(
			`You already have an active interest request for this listing (status: ${existingRows[0].status})`,
			409,
		);
	}

	const { rows } = await pool.query(
		`INSERT INTO interest_requests
       (sender_id, listing_id, status, message)
     VALUES ($1, $2, 'pending', $3)
     RETURNING interest_id, sender_id, listing_id, status, message, created_at`,
		[studentId, listingId, message ?? null],
	);

	const request = rows[0];

	logger.info({ studentId, listingId, interestId: request.interest_id }, "Interest request created");

	// TODO(phase3:notifications): replace with notificationQueue.add(...)
	pool.query(
		`INSERT INTO notifications (recipient_id, notification_type, entity_type, entity_id)
     VALUES ($1, 'interest_request_received', 'interest_request', $2)`,
		[listingRows[0].posted_by, request.interest_id],
	).catch((err) => {
		logger.error({ err, interestId: request.interest_id }, "Failed to insert new-interest notification");
	});

	return {
		interestId: request.interest_id,
		listingId: request.listing_id,
		status: request.status,
		message: request.message,
		createdAt: request.created_at,
	};
};

// ─── Update interest status (state machine transition) ────────────────────────

export const updateInterestStatus = async (callerId, interestId, newStatus) => {
	const row = await fetchInterestWithContext(interestId);
	if (!row) throw new AppError("Interest request not found", 404);

	const actorRole = resolveActorRole(callerId, row);
	if (!actorRole) {
		// 404, not 403 — do not confirm the resource exists to an unauthorised caller.
		throw new AppError("Interest request not found", 404);
	}

	// Validate the transition against the state machine.
	const allowedFromCurrent = ALLOWED_TRANSITIONS[actorRole]?.[row.status] ?? [];
	if (!allowedFromCurrent.includes(newStatus)) {
		throw new AppError(`Cannot transition from '${row.status}' to '${newStatus}' as ${actorRole}`, 422);
	}

	// ── Accepted transition: must create a connections row atomically ─────────
	//
	// This is the only transition that requires a transaction. All others are a
	// single UPDATE. If the connection INSERT fails, the interest status update
	// must also roll back — a partial state (accepted interest, no connection)
	// has no automated recovery path and breaks Phase 4 ratings.
	if (newStatus === "accepted") {
		return await _acceptInterestRequest(row);
	}

	// ── All other transitions: single UPDATE ──────────────────────────────────
	const { rowCount, rows: updatedRows } = await pool.query(
		`UPDATE interest_requests
     SET status     = $1,
         updated_at = NOW()
     WHERE interest_id = $2
       AND status      = $3
       AND deleted_at  IS NULL
     RETURNING interest_id, sender_id, listing_id, status, updated_at`,
		[newStatus, interestId, row.status],
	);

	if (rowCount === 0) {
		throw new AppError("Interest request not found or status has already changed — please refresh", 409);
	}

	const updated = updatedRows[0];

	logger.info(
		{ callerId, actorRole, interestId, from: row.status, to: newStatus },
		"Interest request status updated",
	);

	// TODO(phase3:notifications): replace with notificationQueue.add(...)
	const notifyUserId = actorRole === "student" ? row.poster_id : row.sender_id;
	const notificationType = newStatus === "declined" ? "interest_request_declined" : "interest_request_received";
	pool.query(
		`INSERT INTO notifications (recipient_id, notification_type, entity_type, entity_id)
     VALUES ($1, $2, 'interest_request', $3)`,
		[notifyUserId, notificationType, interestId],
	).catch((err) => {
		logger.error({ err, interestId }, "Failed to insert status-change notification");
	});

	return {
		interestId: updated.interest_id,
		listingId: updated.listing_id,
		status: updated.status,
		updatedAt: updated.updated_at,
	};
};

// ─── Accept interest request (atomic transaction) ─────────────────────────────
//
// Extracted from updateInterestStatus to keep that function readable.
// Two things happen atomically inside BEGIN/COMMIT:
//   1. interest_requests.status → 'accepted'  (with AND status='pending' guard)
//   2. connections row created                (connection_type derived from listing_type)
//
// Post-commit fire-and-forget:
//   3. Notification INSERT for the student
//   4. WhatsApp deep-link fetched and returned
const _acceptInterestRequest = async (row) => {
	// Fetch listing_type to derive connection_type.
	// row.listing_id is already validated by fetchInterestWithContext.
	const { rows: listingRows } = await pool.query(
		`SELECT listing_type FROM listings
     WHERE listing_id = $1 AND deleted_at IS NULL`,
		[row.listing_id],
	);

	if (!listingRows.length) {
		throw new AppError("Listing not found — cannot accept interest request", 404);
	}

	const connectionType = LISTING_TYPE_TO_CONNECTION_TYPE[listingRows[0].listing_type];
	if (!connectionType) {
		// Defensive: a new listing_type without a map entry should surface loudly.
		throw new AppError(`Unhandled listing type: ${listingRows[0].listing_type}`, 500);
	}

	const client = await pool.connect();
	let connectionId;
	try {
		await client.query("BEGIN");

		// Step 1: Flip interest request status.
		// AND status = 'pending' is the concurrency guard: if two poster sessions
		// race to accept the same request, only one gets rowCount > 0.
		const { rowCount, rows: updatedRows } = await client.query(
			`UPDATE interest_requests
       SET status     = 'accepted',
           updated_at = NOW()
       WHERE interest_id = $1
         AND status      = 'pending'
         AND deleted_at  IS NULL
       RETURNING interest_id, sender_id, listing_id, updated_at`,
			[row.interest_id],
		);

		if (rowCount === 0) {
			throw new AppError("Interest request has already been actioned — please refresh", 409);
		}

		const updated = updatedRows[0];

		// Step 2: Create the connections row.
		// initiator = student (sender_id), counterpart = poster (poster_id).
		// Both confirmation flags start FALSE — acceptance of an interest request
		// means two parties agreed to interact, not that the interaction happened.
		// The two-sided confirmation (phase3/connections) is the separate step that
		// sets confirmation_status = 'confirmed'.
		const { rows: connRows } = await client.query(
			`INSERT INTO connections
         (initiator_id, counterpart_id, listing_id, connection_type,
          initiator_confirmed, counterpart_confirmed, confirmation_status)
       VALUES ($1, $2, $3, $4, FALSE, FALSE, 'pending')
       RETURNING connection_id`,
			[updated.sender_id, row.poster_id, updated.listing_id, connectionType],
		);

		connectionId = connRows[0].connection_id;

		await client.query("COMMIT");

		logger.info(
			{
				interestId: updated.interest_id,
				connectionId,
				initiatorId: updated.sender_id,
				counterpartId: row.poster_id,
				connectionType,
			},
			"Interest request accepted — connection created",
		);
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}

	// ── Post-commit side effects ───────────────────────────────────────────────
	//
	// These run AFTER the transaction commits. Any failure here does not affect
	// the accepted status or the connection row — those are permanently committed.

	// TODO(phase3:notifications): replace pool.query with notificationQueue.add(...)
	pool.query(
		`INSERT INTO notifications (recipient_id, notification_type, entity_type, entity_id)
     VALUES ($1, 'interest_request_accepted', 'interest_request', $2)`,
		[row.sender_id, row.interest_id],
	).catch((err) => {
		logger.error({ err, interestId: row.interest_id }, "Failed to insert acceptance notification");
	});

	// WhatsApp deep-link: fetch post-commit. Failure returns null gracefully —
	// the connection is still created; the student can find contact info on the profile.
	const rawPhone = await fetchPosterWhatsApp(row.poster_id).catch((err) => {
		logger.error({ err, posterId: row.poster_id }, "Failed to fetch poster WhatsApp number");
		return null;
	});

	return {
		interestId: row.interest_id,
		listingId: row.listing_id,
		status: "accepted",
		connectionId,
		whatsappLink: buildWhatsAppLink(rawPhone),
		updatedAt: new Date().toISOString(),
	};
};

// ─── Get interest requests for a listing (poster view) ────────────────────────

export const getListingInterests = async (posterId, listingId, filters) => {
	const { status, cursorTime, cursorId, limit = 20 } = filters;

	const { rows: ownerCheck } = await pool.query(
		`SELECT 1 FROM listings
     WHERE listing_id = $1
       AND posted_by  = $2
       AND deleted_at IS NULL`,
		[listingId, posterId],
	);
	if (!ownerCheck.length) throw new AppError("Listing not found", 404);

	const clauses = [`ir.listing_id = $1`, `ir.deleted_at IS NULL`];
	const params = [listingId];
	let p = 2;

	if (status !== undefined) {
		clauses.push(`ir.status = $${p}`);
		params.push(status);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(ir.created_at < $${p} OR (ir.created_at = $${p} AND ir.interest_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);

	const { rows } = await pool.query(
		`SELECT
       ir.interest_id,
       ir.sender_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       COALESCE(sp.full_name, u.email)      AS student_name,
       i.name                               AS student_institution,
       sp.profile_photo_url                 AS student_photo_url,
       u.average_rating                     AS student_rating,
       u.rating_count                       AS student_rating_count
     FROM interest_requests ir
     JOIN users u          ON u.user_id  = ir.sender_id
     LEFT JOIN student_profiles sp
       ON sp.user_id    = ir.sender_id
      AND sp.deleted_at IS NULL
     LEFT JOIN institutions i
       ON i.institution_id = sp.institution_id
      AND i.deleted_at     IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY ir.created_at DESC, ir.interest_id ASC
     LIMIT $${p}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].interest_id,
			}
		:	null;

	return { items: items.map(toPosterInterestShape), nextCursor };
};

// ─── Get my interest requests (student dashboard) ─────────────────────────────

export const getMyInterestRequests = async (studentId, filters) => {
	const { status, cursorTime, cursorId, limit } = filters;

	const clauses = [`ir.sender_id = $1`, `ir.deleted_at IS NULL`];
	const params = [studentId];
	let p = 2;

	if (status !== undefined) {
		clauses.push(`ir.status = $${p}`);
		params.push(status);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(ir.created_at < $${p} OR (ir.created_at = $${p} AND ir.interest_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);

	const { rows } = await pool.query(
		`SELECT
       ir.interest_id,
       ir.listing_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       l.title          AS listing_title,
       l.city           AS listing_city,
       l.locality       AS listing_locality,
       l.rent_per_month,
       l.room_type,
       l.listing_type,
       (
         SELECT ph.photo_url
         FROM listing_photos ph
         WHERE ph.listing_id = l.listing_id
           AND ph.is_cover   = TRUE
           AND ph.deleted_at IS NULL
         LIMIT 1
       ) AS cover_photo_url,
       COALESCE(sp2.full_name, pop.owner_full_name, u2.email) AS poster_name,
       COALESCE(p.average_rating, u2.average_rating)          AS poster_rating,
       p.property_name
     FROM interest_requests ir
     JOIN listings l    ON l.listing_id  = ir.listing_id
     JOIN users u2      ON u2.user_id    = l.posted_by
     LEFT JOIN student_profiles  sp2 ON sp2.user_id  = l.posted_by AND sp2.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop ON pop.user_id  = l.posted_by AND pop.deleted_at IS NULL
     LEFT JOIN properties p          ON p.property_id = l.property_id AND p.deleted_at IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY ir.created_at DESC, ir.interest_id ASC
     LIMIT $${p}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].interest_id,
			}
		:	null;

	return { items: items.map(toStudentInterestShape), nextCursor };
};

// ─── Expire pending requests for a listing ────────────────────────────────────
//
// Called inside the same transaction as a listing status update (deactivation,
// fill, delete) so that if the listing status update rolls back, the expiry
// also rolls back. Accepts an optional client for that purpose — defaults to
// pool for standalone use.
export const expirePendingRequestsForListing = async (listingId, client = pool) => {
	const { rowCount } = await client.query(
		`UPDATE interest_requests
     SET status     = 'expired',
         updated_at = NOW()
     WHERE listing_id = $1
       AND status     = 'pending'
       AND deleted_at IS NULL`,
		[listingId],
	);

	if (rowCount > 0) {
		logger.info({ listingId, expiredCount: rowCount }, "Pending interest requests expired for listing");
		// TODO(phase3:notifications): notify each expired sender_id that their
		// request was expired because the listing is no longer available.
		// This must fire post-commit from the caller, not inside this function,
		// because this function runs inside a transaction.
	}

	return rowCount;
};
