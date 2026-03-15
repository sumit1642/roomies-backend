// src/services/rating.service.js
//
// ─── FIXES IN THIS VERSION ────────────────────────────────────────────────────
//
// 1. SELF-RATING PREVENTION
//    User ratings: WHERE EXISTS now requires
//      ((initiator_id = $1 AND counterpart_id = $4) OR (counterpart_id = $1 AND initiator_id = $4))
//    which structurally prevents the reviewer from also being the reviewee.
//    Property ratings: added assertion that the property's owner is the
//    connection's other participant, preventing an owner from rating their
//    own property using their own connection.
//
// 2. DUPLICATE DETECTION AFTER rowCount === 0
//    After the gated INSERT returns 0 rows, we now run a targeted lookup for
//    an existing rating row matching (reviewer_id, connection_id, reviewee_id).
//    Only if that row is found do we throw 409. If the connection was valid but
//    no duplicate exists, the WHERE EXISTS failed for another reason (e.g. wrong
//    reviewee), and we surface a 422 instead of a misleading 409.
//
// 3. getRatingsForConnection RETURNS ARRAYS
//    A reviewer can submit both a user rating and a property rating against the
//    same confirmed connection (two different reviewee_type/reviewee_id combos).
//    The response now returns { myRatings: [...], theirRatings: [...] } so no
//    rating is silently dropped. Callers must handle the array shape.
//
// 4. EMAIL LEAK FIXED IN PUBLIC READ ENDPOINTS
//    getPublicRatings and getPublicPropertyRatings previously fell back to
//    u.email when no student_profiles.full_name existed (e.g. for PG owners
//    who wrote reviews). The fix adds a LEFT JOIN to pg_owner_profiles and uses
//    COALESCE(sp.full_name, pop.owner_full_name, 'Anonymous Reviewer').
//    getMyGivenRatings already had a more complete JOIN chain and is unchanged.

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
		logger.error({ err, ...payload }, "Failed to enqueue rating notification");
	});
};

// ─── Submit rating ─────────────────────────────────────────────────────────────
export const submitRating = async (reviewerId, data) => {
	const {
		connectionId,
		revieweeType,
		revieweeId,
		overallScore,
		cleanlinessScore,
		communicationScore,
		reliabilityScore,
		valueScore,
		comment,
	} = data;

	// ── Step 1: Polymorphic reviewee existence check ──────────────────────────
	if (revieweeType === "user") {
		const { rows } = await pool.query(`SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL`, [
			revieweeId,
		]);
		if (!rows.length) throw new AppError("Reviewee user not found", 404);
	} else {
		const { rows } = await pool.query(`SELECT 1 FROM properties WHERE property_id = $1 AND deleted_at IS NULL`, [
			revieweeId,
		]);
		if (!rows.length) throw new AppError("Reviewee property not found", 404);
	}

	// ── Step 2: Atomic gating INSERT ──────────────────────────────────────────
	//
	// User ratings: the WHERE EXISTS enforces cross-party constraint using an
	// explicit (initiator/counterpart) pairing that prevents self-ratings.
	// The pattern ((initiator = reviewer AND counterpart = reviewee) OR
	//              (counterpart = reviewer AND initiator = reviewee))
	// means the reviewer and reviewee MUST be the two different parties on the
	// connection — a user cannot appear on both sides simultaneously.
	//
	// Property ratings: additionally assert that the property's owner_id is the
	// other participant in the connection (not the reviewer themselves), so an
	// owner cannot rate their own property by using their own connection.
	let result;
	if (revieweeType === "user") {
		result = await pool.query(
			`INSERT INTO ratings
         (reviewer_id, connection_id, reviewee_type, reviewee_id,
          overall_score, cleanliness_score, communication_score,
          reliability_score, value_score, review_text)
       SELECT $1, $2, $3::reviewee_type_enum, $4, $5, $6, $7, $8, $9, $10
       WHERE EXISTS (
         SELECT 1 FROM connections
         WHERE connection_id       = $2
           AND confirmation_status = 'confirmed'
           AND deleted_at          IS NULL
           AND (
             (initiator_id  = $1 AND counterpart_id = $4)
             OR
             (counterpart_id = $1 AND initiator_id  = $4)
           )
       )
       ON CONFLICT (reviewer_id, connection_id, reviewee_id) DO NOTHING
       RETURNING rating_id, created_at`,
			[
				reviewerId,
				connectionId,
				revieweeType,
				revieweeId,
				overallScore,
				cleanlinessScore ?? null,
				communicationScore ?? null,
				reliabilityScore ?? null,
				valueScore ?? null,
				comment ?? null,
			],
		);
	} else {
		// Property rating: verify the property belongs to this connection AND
		// that the reviewer is the other participant (not the property's owner),
		// preventing an owner from rating their own property.
		result = await pool.query(
			`INSERT INTO ratings
         (reviewer_id, connection_id, reviewee_type, reviewee_id,
          overall_score, cleanliness_score, communication_score,
          reliability_score, value_score, review_text)
       SELECT $1, $2, $3::reviewee_type_enum, $4, $5, $6, $7, $8, $9, $10
       WHERE EXISTS (
         SELECT 1 FROM connections c
         JOIN listings l   ON l.listing_id   = c.listing_id AND l.deleted_at IS NULL
         JOIN properties p ON p.property_id  = l.property_id AND p.deleted_at IS NULL
         WHERE c.connection_id       = $2
           AND c.confirmation_status = 'confirmed'
           AND c.deleted_at          IS NULL
           AND p.property_id         = $4
           AND (
             (c.initiator_id  = $1 AND c.counterpart_id = p.owner_id)
             OR
             (c.counterpart_id = $1 AND c.initiator_id  = p.owner_id)
           )
       )
       ON CONFLICT (reviewer_id, connection_id, reviewee_id) DO NOTHING
       RETURNING rating_id, created_at`,
			[
				reviewerId,
				connectionId,
				revieweeType,
				revieweeId,
				overallScore,
				cleanlinessScore ?? null,
				communicationScore ?? null,
				reliabilityScore ?? null,
				valueScore ?? null,
				comment ?? null,
			],
		);
	}

	// ── Step 3: Interpret rowCount ─────────────────────────────────────────────
	//
	// rowCount === 0 can mean three different things:
	//   A) WHERE EXISTS failed — connection not found, not confirmed, or reviewee
	//      is not the correct other party (includes self-rating attempt)
	//   B) ON CONFLICT fired — rating already exists for this triple
	//
	// To distinguish A from B, we check the connection first, then look for an
	// existing rating. This avoids falsely reporting 409 when the real issue was
	// that the reviewee was wrong or the connection was invalid.
	if (result.rowCount === 0) {
		// Check connection validity and party membership.
		const { rows: connRows } = await pool.query(
			`SELECT connection_id, confirmation_status
       FROM connections
       WHERE connection_id = $1
         AND (initiator_id = $2 OR counterpart_id = $2)
         AND deleted_at IS NULL`,
			[connectionId, reviewerId],
		);

		if (!connRows.length) {
			// Connection doesn't exist or caller is not a party — 404.
			throw new AppError("Connection not found", 404);
		}

		if (connRows[0].confirmation_status !== "confirmed") {
			throw new AppError("Ratings can only be submitted for confirmed connections", 422);
		}

		// Connection is confirmed and caller is a party. Check for an existing
		// rating row — only then is it a genuine duplicate (409).
		const { rows: existingRating } = await pool.query(
			`SELECT rating_id FROM ratings
       WHERE reviewer_id  = $1
         AND connection_id = $2
         AND reviewee_id   = $3
         AND deleted_at    IS NULL`,
			[reviewerId, connectionId, revieweeId],
		);

		if (existingRating.length) {
			throw new AppError("You have already submitted a rating for this connection and reviewee", 409);
		}

		// WHERE EXISTS failed but no duplicate exists — the reviewee is not the
		// correct counterparty for this connection (possibly a self-rating attempt
		// or a reviewee who is not on this connection).
		throw new AppError("The reviewee is not a valid party to this connection, or you cannot rate yourself", 422);
	}

	const { rating_id: ratingId, created_at: createdAt } = result.rows[0];

	logger.info({ reviewerId, connectionId, revieweeType, revieweeId, ratingId, overallScore }, "Rating submitted");

	// ── Step 4: Post-commit notification ──────────────────────────────────────
	if (revieweeType === "user") {
		_enqueueNotification({
			recipientId: revieweeId,
			type: "rating_received",
			entityType: "rating",
			entityId: ratingId,
		});
	} else {
		pool.query(`SELECT owner_id FROM properties WHERE property_id = $1 AND deleted_at IS NULL`, [revieweeId])
			.then(({ rows }) => {
				if (rows.length) {
					_enqueueNotification({
						recipientId: rows[0].owner_id,
						type: "rating_received",
						entityType: "rating",
						entityId: ratingId,
					});
				}
			})
			.catch((err) => {
				logger.error({ err, revieweeId, ratingId }, "Failed to look up property owner for rating notification");
			});
	}

	return { ratingId, createdAt };
};

// ─── Get ratings for a connection ─────────────────────────────────────────────
//
// A reviewer can submit both a user rating and a property rating against the
// same confirmed connection (two different reviewee_id values with different
// reviewee_type). Using rows.find() would silently drop all but the first
// matching row. We now return arrays so every rating is preserved.
//
// Response shape:
//   { myRatings: Rating[], theirRatings: Rating[] }
//
// myRatings = all rows where reviewer_id = callerId
// theirRatings = all rows where reviewer_id = the other party
export const getRatingsForConnection = async (callerId, connectionId) => {
	const { rows: connRows } = await pool.query(
		`SELECT initiator_id, counterpart_id
     FROM connections
     WHERE connection_id = $1
       AND (initiator_id = $2 OR counterpart_id = $2)
       AND deleted_at IS NULL`,
		[connectionId, callerId],
	);

	if (!connRows.length) {
		throw new AppError("Connection not found", 404);
	}

	const { initiator_id: initiatorId, counterpart_id: counterpartId } = connRows[0];
	const otherPartyId = callerId === initiatorId ? counterpartId : initiatorId;

	// Fetch all ratings for both parties in one query.
	const { rows } = await pool.query(
		`SELECT
       r.rating_id,
       r.reviewer_id,
       r.reviewee_type,
       r.reviewee_id,
       r.overall_score,
       r.cleanliness_score,
       r.communication_score,
       r.reliability_score,
       r.value_score,
       r.review_text,
       r.is_visible,
       r.created_at
     FROM ratings r
     WHERE r.connection_id = $1
       AND r.reviewer_id   = ANY($2::uuid[])
       AND r.deleted_at    IS NULL
       AND r.is_visible    = TRUE`,
		[connectionId, [callerId, otherPartyId]],
	);

	const formatRating = (row) => ({
		ratingId: row.rating_id,
		reviewerId: row.reviewer_id,
		revieweeType: row.reviewee_type,
		revieweeId: row.reviewee_id,
		overallScore: row.overall_score,
		cleanlinessScore: row.cleanliness_score,
		communicationScore: row.communication_score,
		reliabilityScore: row.reliability_score,
		valueScore: row.value_score,
		comment: row.review_text,
		createdAt: row.created_at,
	});

	const myRatings = rows.filter((r) => r.reviewer_id === callerId).map(formatRating);
	const theirRatings = rows.filter((r) => r.reviewer_id === otherPartyId).map(formatRating);

	return { myRatings, theirRatings };
};

// ─── Get public ratings for a user ────────────────────────────────────────────
//
// EMAIL LEAK FIX: the previous COALESCE(sp.full_name, u.email) fell back to the
// user's email address when no student profile full_name existed (e.g. for a
// PG owner who submitted a rating). We now add a LEFT JOIN to pg_owner_profiles
// and fall back to 'Anonymous Reviewer' rather than the raw email address.
export const getPublicRatings = async (userId, filters) => {
	const { cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [
		`r.reviewee_id   = $1`,
		`r.reviewee_type = 'user'::reviewee_type_enum`,
		`r.is_visible    = TRUE`,
		`r.deleted_at    IS NULL`,
	];
	const params = [userId];
	let p = 2;

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(r.created_at < $${p} OR (r.created_at = $${p} AND r.rating_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const { rows } = await pool.query(
		`SELECT
       r.rating_id,
       r.overall_score,
       r.cleanliness_score,
       r.communication_score,
       r.reliability_score,
       r.value_score,
       r.review_text        AS comment,
       r.created_at,
       -- Never expose u.email — fall back to a non-sensitive placeholder instead.
       COALESCE(sp.full_name, pop.owner_full_name, 'Anonymous Reviewer') AS reviewer_name,
       sp.profile_photo_url AS reviewer_photo_url
     FROM ratings r
     JOIN users u
       ON u.user_id    = r.reviewer_id
      AND u.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = r.reviewer_id
      AND sp.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop
       ON pop.user_id    = r.reviewer_id
      AND pop.deleted_at IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY r.created_at DESC, r.rating_id ASC
     LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].rating_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			ratingId: row.rating_id,
			overallScore: row.overall_score,
			cleanlinessScore: row.cleanliness_score,
			communicationScore: row.communication_score,
			reliabilityScore: row.reliability_score,
			valueScore: row.value_score,
			comment: row.comment,
			createdAt: row.created_at,
			reviewer: {
				fullName: row.reviewer_name,
				profilePhotoUrl: row.reviewer_photo_url,
			},
		})),
		nextCursor,
	};
};

// ─── Get my given ratings ──────────────────────────────────────────────────────
//
// Unchanged from the original — it already has a complete JOIN chain that avoids
// email leakage via COALESCE over student and pg_owner profiles.
export const getMyGivenRatings = async (reviewerId, filters) => {
	const { cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [`r.reviewer_id = $1`, `r.deleted_at  IS NULL`];
	const params = [reviewerId];
	let p = 2;

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(r.created_at < $${p} OR (r.created_at = $${p} AND r.rating_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const { rows } = await pool.query(
		`SELECT
       r.rating_id,
       r.connection_id,
       r.reviewee_type,
       r.reviewee_id,
       r.overall_score,
       r.cleanliness_score,
       r.communication_score,
       r.reliability_score,
       r.value_score,
       r.review_text AS comment,
       r.is_visible,
       r.created_at,

       CASE
         WHEN r.reviewee_type = 'user'
         THEN COALESCE(sp_rev.full_name, pop_rev.owner_full_name, 'Anonymous User')
         ELSE p_rev.property_name
       END AS reviewee_name,

       CASE
         WHEN r.reviewee_type = 'user'
         THEN sp_rev.profile_photo_url
         ELSE NULL
       END AS reviewee_photo_url

     FROM ratings r

     LEFT JOIN users u_rev
       ON u_rev.user_id    = r.reviewee_id
      AND r.reviewee_type  = 'user'
      AND u_rev.deleted_at IS NULL

     LEFT JOIN student_profiles sp_rev
       ON sp_rev.user_id    = r.reviewee_id
      AND r.reviewee_type   = 'user'
      AND sp_rev.deleted_at IS NULL

     LEFT JOIN pg_owner_profiles pop_rev
       ON pop_rev.user_id   = r.reviewee_id
      AND r.reviewee_type   = 'user'
      AND pop_rev.deleted_at IS NULL

     LEFT JOIN properties p_rev
       ON p_rev.property_id = r.reviewee_id
      AND r.reviewee_type   = 'property'
      AND p_rev.deleted_at  IS NULL

     WHERE ${clauses.join(" AND ")}
     ORDER BY r.created_at DESC, r.rating_id ASC
     LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].rating_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			ratingId: row.rating_id,
			connectionId: row.connection_id,
			revieweeType: row.reviewee_type,
			revieweeId: row.reviewee_id,
			overallScore: row.overall_score,
			cleanlinessScore: row.cleanliness_score,
			communicationScore: row.communication_score,
			reliabilityScore: row.reliability_score,
			valueScore: row.value_score,
			comment: row.comment,
			isVisible: row.is_visible,
			createdAt: row.created_at,
			reviewee: {
				fullName: row.reviewee_name,
				profilePhotoUrl: row.reviewee_photo_url,
				type: row.reviewee_type,
			},
		})),
		nextCursor,
	};
};

// ─── Get public ratings for a property ────────────────────────────────────────
//
// EMAIL LEAK FIX: same fix as getPublicRatings — added pg_owner_profiles JOIN
// and replaced u.email fallback with 'Anonymous Reviewer'.
export const getPublicPropertyRatings = async (propertyId, filters) => {
	const { rows: propRows } = await pool.query(
		`SELECT 1 FROM properties WHERE property_id = $1 AND deleted_at IS NULL`,
		[propertyId],
	);
	if (!propRows.length) throw new AppError("Property not found", 404);

	const { cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [
		`r.reviewee_id   = $1`,
		`r.reviewee_type = 'property'::reviewee_type_enum`,
		`r.is_visible    = TRUE`,
		`r.deleted_at    IS NULL`,
	];
	const params = [propertyId];
	let p = 2;

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(`(r.created_at < $${p} OR (r.created_at = $${p} AND r.rating_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const { rows } = await pool.query(
		`SELECT
       r.rating_id,
       r.overall_score,
       r.cleanliness_score,
       r.communication_score,
       r.reliability_score,
       r.value_score,
       r.review_text        AS comment,
       r.created_at,
       -- Never expose u.email — fall back to a non-sensitive placeholder instead.
       COALESCE(sp.full_name, pop.owner_full_name, 'Anonymous Reviewer') AS reviewer_name,
       sp.profile_photo_url AS reviewer_photo_url
     FROM ratings r
     JOIN users u
       ON u.user_id    = r.reviewer_id
      AND u.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = r.reviewer_id
      AND sp.deleted_at IS NULL
     LEFT JOIN pg_owner_profiles pop
       ON pop.user_id    = r.reviewer_id
      AND pop.deleted_at IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY r.created_at DESC, r.rating_id ASC
     LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].rating_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			ratingId: row.rating_id,
			overallScore: row.overall_score,
			cleanlinessScore: row.cleanliness_score,
			communicationScore: row.communication_score,
			reliabilityScore: row.reliability_score,
			valueScore: row.value_score,
			comment: row.comment,
			createdAt: row.created_at,
			reviewer: {
				fullName: row.reviewer_name,
				profilePhotoUrl: row.reviewer_photo_url,
			},
		})),
		nextCursor,
	};
};
