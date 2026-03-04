// src/services/interest.service.js
//
// Implements the interest request state machine and all associated queries.
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
// ─── DATABASE ENFORCEMENT ────────────────────────────────────────────────────
//
// The partial unique index UNIQUE (student_id, listing_id) WHERE status IN
// ('pending', 'accepted') means PostgreSQL enforces the "one active request per
// student per listing" rule atomically at write time. No application-level SELECT
// before INSERT is needed for correctness (though we do it anyway to give a
// better error message). A race condition between two simultaneous requests from
// the same student produces a 23505 error from PostgreSQL, which we catch and
// translate to 409.
//
// ─── NOTIFICATION HOOKS ──────────────────────────────────────────────────────
//
// Every state transition is an event the other party cares about. The hook
// points are marked with TODO(phase3:notifications) comments. In Phase 3 the
// notification service will fill these in. Nothing in the state machine logic
// changes when notifications are added — they are side effects that run after
// the transaction commits, never inside it.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── State machine transition table ──────────────────────────────────────────
//
// Keys are actor roles as determined by the service (not JWT roles — a student
// who posts their own room is a 'poster' when acting on their own listing's
// requests). Values are objects mapping current status → array of reachable
// statuses. If a (actor, currentStatus, newStatus) combination does not appear
// here, the transition is illegal and the service throws 422.
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

// ─── Private helpers ──────────────────────────────────────────────────────────

// Fetches a single interest request row with the context needed for transition
// validation: who is the requester, who is the poster, what is the current status.
// Returns null if the row doesn't exist or is soft-deleted.
const fetchInterestWithContext = async (interestId, client = pool) => {
	const { rows } = await client.query(
		`SELECT
       ir.interest_id,
       ir.student_id,
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

// Determines the caller's role relative to a specific interest request.
// Returns 'student' if the caller is the requester, 'poster' if they own
// the listing, null if they are neither (unauthorized).
// This is intentionally distinct from JWT roles — a student who posted their
// own room is a 'poster' in this context when responding to others' requests.
const resolveActorRole = (callerId, row) => {
	if (callerId === row.student_id) return "student";
	if (callerId === row.poster_id) return "poster";
	return null;
};

// Shapes a raw interest DB row into the API response format for the student's
// dashboard view, including the listing summary they need to recognise the
// context of the request.
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

// Shapes a raw interest DB row into the API response format for the poster's
// listing-management view, including the student's public profile.
const toPosterInterestShape = (row) => ({
	interestId: row.interest_id,
	status: row.status,
	message: row.message,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	student: {
		userId: row.student_id,
		fullName: row.student_name,
		institution: row.student_institution,
		profilePhotoUrl: row.student_photo_url,
		averageRating: row.student_rating,
		ratingCount: row.student_rating_count,
	},
});

// ─── Create interest request ──────────────────────────────────────────────────

export const createInterestRequest = async (studentId, listingId, message) => {
	// Guard 1: listing must be active and not deleted.
	// We also check that expires_at has not passed — an expired listing should
	// not receive new interest even if a cron hasn't flipped its status yet.
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
	// This covers the case where a student posts their own room — they should
	// not be able to send themselves an interest request.
	if (listingRows[0].posted_by === studentId) {
		throw new AppError("You cannot express interest in your own listing", 422);
	}

	// Guard 3: check for an existing active request and give a clean error
	// message. This SELECT is not strictly necessary for correctness (the
	// partial unique index on the INSERT catches races atomically), but it
	// produces a far better error message than a raw 23505 database error.
	const { rows: existingRows } = await pool.query(
		`SELECT interest_id, status
     FROM interest_requests
     WHERE student_id  = $1
       AND listing_id  = $2
       AND status IN ('pending', 'accepted')
       AND deleted_at  IS NULL`,
		[studentId, listingId],
	);

	if (existingRows.length) {
		throw new AppError(
			`You already have an active interest request for this listing (status: ${existingRows[0].status})`,
			409,
		);
	}

	// Insert the new request. status defaults to 'pending' in the DB schema,
	// but we set it explicitly here for clarity and to avoid silent schema
	// default drift.
	const { rows } = await pool.query(
		`INSERT INTO interest_requests
       (student_id, listing_id, status, message)
     VALUES ($1, $2, 'pending', $3)
     RETURNING interest_id, student_id, listing_id, status, message, created_at`,
		[studentId, listingId, message ?? null],
	);

	const request = rows[0];

	logger.info({ studentId, listingId, interestId: request.interest_id }, "Interest request created");

	// TODO(phase3:notifications): notify the listing poster that a new interest
	// request has arrived. Fire after INSERT, never inside a transaction.
	// notificationService.send(listingRows[0].posted_by, 'new_interest', { interestId })

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
	// Fetch the full context row — we need it to determine the actor's role,
	// validate the transition, and run the UPDATE with the right WHERE clause.
	const row = await fetchInterestWithContext(interestId);
	if (!row) throw new AppError("Interest request not found", 404);

	// Determine who the caller is relative to this request.
	const actorRole = resolveActorRole(callerId, row);
	if (!actorRole) {
		// The caller has no relationship to this request. Return 404, not 403 —
		// confirming that the request exists but the caller lacks permission would
		// leak information about another user's activity.
		throw new AppError("Interest request not found", 404);
	}

	// Validate the transition against the state machine.
	const allowedFromCurrent = ALLOWED_TRANSITIONS[actorRole]?.[row.status] ?? [];
	if (!allowedFromCurrent.includes(newStatus)) {
		throw new AppError(`Cannot transition from '${row.status}' to '${newStatus}' as ${actorRole}`, 422);
	}

	// Run the UPDATE with AND status = current status as an atomic safety net.
	// If another request changed the status between our SELECT and this UPDATE,
	// rowCount will be 0 and we surface a 409 rather than silently applying
	// a transition on top of an already-changed state.
	const { rowCount, rows: updatedRows } = await pool.query(
		`UPDATE interest_requests
     SET status     = $1,
         updated_at = NOW()
     WHERE interest_id = $2
       AND status      = $3
     RETURNING interest_id, student_id, listing_id, status, updated_at`,
		[newStatus, interestId, row.status],
	);

	if (rowCount === 0) {
		throw new AppError("The status of this request has changed — please refresh and try again", 409);
	}

	const updated = updatedRows[0];

	logger.info(
		{
			callerId,
			actorRole,
			interestId,
			from: row.status,
			to: newStatus,
		},
		"Interest request status updated",
	);

	// TODO(phase3:notifications): notify the other party about the status change.
	// The other party is: if actorRole === 'student', notify the poster.
	//                      if actorRole === 'poster',  notify the student.
	// const notifyUserId = actorRole === 'student' ? row.poster_id : row.student_id
	// notificationService.send(notifyUserId, 'interest_status_changed', { interestId, newStatus })

	return {
		interestId: updated.interest_id,
		listingId: updated.listing_id,
		status: updated.status,
		updatedAt: updated.updated_at,
	};
};

// ─── Get interest requests for a listing (poster view) ────────────────────────

export const getListingInterests = async (posterId, listingId, filters) => {
	const { status, cursorTime, cursorId, limit } = filters;

	// Verify the listing exists and belongs to the caller. Ownership-in-WHERE:
	// a poster who supplies a valid listingId belonging to someone else gets 404.
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

	// The poster sees each requester's public profile: name, institution, photo,
	// and rating. This is the information they need to evaluate whether to accept
	// or decline — essentially a lightweight student profile card per request.
	const { rows } = await pool.query(
		`SELECT
       ir.interest_id,
       ir.student_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       -- Student public profile
       COALESCE(sp.full_name, u.email)      AS student_name,
       sp.institution_name                   AS student_institution,
       sp.profile_photo_url                  AS student_photo_url,
       u.average_rating                      AS student_rating,
       u.rating_count                        AS student_rating_count
     FROM interest_requests ir
     JOIN users u          ON u.user_id  = ir.student_id
     LEFT JOIN student_profiles sp
       ON sp.user_id    = ir.student_id
      AND sp.deleted_at IS NULL
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

	const clauses = [`ir.student_id = $1`, `ir.deleted_at IS NULL`];
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

	// The student sees a listing summary alongside each request so they can
	// immediately recognise which property the request relates to — title, city,
	// rent, cover photo, and the poster's name are enough for recognition without
	// fetching the full listing detail.
	const { rows } = await pool.query(
		`SELECT
       ir.interest_id,
       ir.listing_id,
       ir.status,
       ir.message,
       ir.created_at,
       ir.updated_at,
       -- Listing summary
       l.title          AS listing_title,
       l.city           AS listing_city,
       l.locality       AS listing_locality,
       l.rent_per_month,
       l.room_type,
       l.listing_type,
       -- Cover photo (scalar subquery — no JOIN + GROUP BY needed)
       (
         SELECT ph.photo_url
         FROM listing_photos ph
         WHERE ph.listing_id = l.listing_id
           AND ph.is_cover   = TRUE
           AND ph.deleted_at IS NULL
         LIMIT 1
       ) AS cover_photo_url,
       -- Poster public name and rating
       COALESCE(sp2.full_name, pop.owner_full_name, u2.email) AS poster_name,
       COALESCE(p.average_rating, u2.average_rating)          AS poster_rating,
       -- Parent property name (non-null only for PG listings)
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
// Called by the listing service when a listing is deactivated, filled, or
// soft-deleted. Sets all 'pending' interest requests to 'expired' so requesters
// are not left waiting indefinitely for a response that will never come.
//
// This function is NOT exposed as an HTTP endpoint — it is an internal
// service-to-service call. It takes a `client` parameter so it can participate
// in the same transaction as the listing status change that triggered it.
// This is the correct design: expiring the requests and changing the listing
// status should be atomic — you never want a listing to be 'filled' while
// some of its requests are still 'pending'.
//
// 'accepted' requests are deliberately excluded from this expiry: if the poster
// has already accepted a request and then marks the listing as filled, the
// accepted request represents a real agreement that should remain visible in
// both parties' history. Only 'pending' requests — which represent unanswered
// signals — are expired.
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
		// TODO(phase3:notifications): notify each expired student_id that their
		// request was expired because the listing is no longer available.
	}

	return rowCount;
};
