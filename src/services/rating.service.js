// src/services/rating.service.js
//
// ─── WHAT THIS SERVICE DOES ───────────────────────────────────────────────────
//
// Manages submission and retrieval of ratings. Ratings are the final stage of
// the trust pipeline: interest → connection → rating. A rating can only be
// submitted once a connection with confirmation_status = 'confirmed' exists
// between the reviewer and the reviewee.
//
// ─── THE ANTI-FAKE-REVIEW GUARANTEE ──────────────────────────────────────────
//
// The ratings table has a NOT NULL FK on connection_id. The gating INSERT query
// below uses WHERE EXISTS to verify:
//   1. The connection exists, is confirmed, and the reviewer is a party to it.
//   2. The reviewee is the other party (or, for property ratings, the listing's
//      property belongs to the other party's connection).
// ON CONFLICT (reviewer_id, connection_id, reviewee_id) DO NOTHING handles the
// duplicate submission case atomically — no separate read-then-write race.
//
// ─── AGGREGATE UPDATE ────────────────────────────────────────────────────────
//
// The update_rating_aggregates trigger in the DB fires automatically after
// INSERT on the ratings table. This service does NOT manually update
// users.average_rating or properties.average_rating — the trigger handles it.
// This is explicitly designed into the schema; see roomies_db_setup.sql.
//
// ─── NOTIFICATION ────────────────────────────────────────────────────────────
//
// After a successful INSERT, a rating_received notification is enqueued for
// the reviewee (user ratings only — property ratings notify the property owner).
// Post-commit, fire-and-forget via BullMQ — same pattern as interest and
// connection services.

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
//
// The core operation. Uses a single atomic INSERT ... WHERE EXISTS ... ON CONFLICT
// pattern to simultaneously:
//   1. Verify the connection exists, is confirmed, and the reviewer is a party.
//   2. Verify the reviewee is the other party (for user ratings) or that the
//      property belongs to the connection context (for property ratings).
//   3. Insert the rating row if all checks pass.
//   4. Do nothing (idempotent) if the rating already exists.
//
// rowCount interpretation:
//   rowCount === 1  → new rating inserted successfully
//   rowCount === 0  → either the WHERE EXISTS failed (connection not valid)
//                     OR the ON CONFLICT fired (rating already exists)
//
// To distinguish the two rowCount === 0 cases, we do a follow-up read on the
// connection only — not on ratings — so we don't accidentally confirm to the
// caller that a duplicate rating exists with specific details.
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

	// ── Step 1: Polymorphic reviewee existence check ───────────────────────────
	//
	// The DB cannot enforce a FK to two tables. We check here before the INSERT
	// so a 404 is returned cleanly rather than leaving a dangling rating pointing
	// at a non-existent reviewee.
	//
	// This is a pre-check, not a transaction guard — a tiny race window exists
	// where the reviewee could be soft-deleted between this check and the INSERT.
	// That is acceptable: the INSERT would still succeed (the FK is on connection_id,
	// not reviewee_id), and a rating pointing at a deleted user/property is
	// harmless — it simply won't appear in public feeds (which filter deleted_at).
	if (revieweeType === "user") {
		const { rows } = await pool.query(`SELECT 1 FROM users WHERE user_id = $1 AND deleted_at IS NULL`, [
			revieweeId,
		]);
		if (!rows.length) {
			throw new AppError("Reviewee user not found", 404);
		}
	} else {
		// revieweeType === 'property'
		const { rows } = await pool.query(`SELECT 1 FROM properties WHERE property_id = $1 AND deleted_at IS NULL`, [
			revieweeId,
		]);
		if (!rows.length) {
			throw new AppError("Reviewee property not found", 404);
		}
	}

	// ── Step 2: Atomic gating INSERT ──────────────────────────────────────────
	//
	// The WHERE EXISTS subquery simultaneously verifies:
	//   a) The connection exists and is not soft-deleted.
	//   b) confirmation_status = 'confirmed' — real-world interaction proven.
	//   c) The reviewer is a party (initiator_id OR counterpart_id = reviewerId).
	//   d) The reviewee is the OTHER party (for user ratings) OR the property
	//      belongs to a listing tied to this connection (for property ratings).
	//
	// For property ratings, the reviewee must be the property associated with
	// the listing that created this connection. A reviewer cannot rate an
	// arbitrary property — only one they have a confirmed connection through.
	//
	// ON CONFLICT (reviewer_id, connection_id, reviewee_id) DO NOTHING:
	// matches the partial unique index idx_ratings_one_per_connection in the schema.
	// If the rating already exists, the INSERT silently does nothing and rowCount = 0.
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
         WHERE connection_id        = $2
           AND confirmation_status  = 'confirmed'
           AND deleted_at           IS NULL
           AND (initiator_id = $1 OR counterpart_id = $1)
           AND (initiator_id = $4 OR counterpart_id = $4)
           AND initiator_id != counterpart_id
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
		// Property rating: verify the property is linked to this connection via
		// the listing that created it. This prevents a student who stayed at PG-A
		// from rating PG-B by supplying a confirmed connection from PG-A.
		result = await pool.query(
			`INSERT INTO ratings
         (reviewer_id, connection_id, reviewee_type, reviewee_id,
          overall_score, cleanliness_score, communication_score,
          reliability_score, value_score, review_text)
       SELECT $1, $2, $3::reviewee_type_enum, $4, $5, $6, $7, $8, $9, $10
       WHERE EXISTS (
         SELECT 1 FROM connections c
         JOIN listings l ON l.listing_id = c.listing_id AND l.deleted_at IS NULL
         JOIN properties p ON p.property_id = l.property_id AND p.deleted_at IS NULL
         WHERE c.connection_id       = $2
           AND c.confirmation_status = 'confirmed'
           AND c.deleted_at          IS NULL
           AND (c.initiator_id = $1 OR c.counterpart_id = $1)
           AND p.property_id         = $4
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
	if (result.rowCount === 0) {
		// Determine whether we got here because the connection check failed
		// (WHERE EXISTS returned false) or because the rating already exists
		// (ON CONFLICT fired).
		const { rows: connRows } = await pool.query(
			`SELECT connection_id, confirmation_status
       FROM connections
       WHERE connection_id = $1
         AND (initiator_id = $2 OR counterpart_id = $2)
         AND deleted_at IS NULL`,
			[connectionId, reviewerId],
		);

		if (!connRows.length) {
			// Connection doesn't exist or the reviewer is not a party.
			// Return 404 — never 403. We do not confirm or deny the existence
			// of a connection that the caller isn't party to.
			throw new AppError("Connection not found", 404);
		}

		if (connRows[0].confirmation_status !== "confirmed") {
			throw new AppError("Ratings can only be submitted for confirmed connections", 422);
		}

		// Connection exists and is confirmed but rowCount is still 0 — the
		// ON CONFLICT fired, meaning this rating was already submitted.
		throw new AppError("You have already submitted a rating for this connection and reviewee", 409);
	}

	const { rating_id: ratingId, created_at: createdAt } = result.rows[0];

	logger.info({ reviewerId, connectionId, revieweeType, revieweeId, ratingId, overallScore }, "Rating submitted");

	// ── Step 4: Post-commit notification ──────────────────────────────────────
	//
	// For user ratings: notify the reviewee directly.
	// For property ratings: notify the property owner (looked up separately).
	// Both are fire-and-forget — a missed notification does not roll back the rating.
	if (revieweeType === "user") {
		_enqueueNotification({
			recipientId: revieweeId,
			type: "rating_received",
			entityType: "rating",
			entityId: ratingId,
		});
	} else {
		// Property rating: look up the owner to notify them.
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
// Returns both ratings for a connection: the caller's own rating and the other
// party's rating (if submitted). Only the two connection parties may call this.
//
// Response shape:
//   { myRating: Rating | null, theirRating: Rating | null }
//
// myRating is the row where reviewer_id = callerId.
// theirRating is the row where reviewer_id = the other party.
// null means that party has not yet submitted their rating.
export const getRatingsForConnection = async (callerId, connectionId) => {
	// Verify the caller is a party to this connection. 404 for non-parties —
	// never 403, to avoid confirming that the connection exists.
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

	// Fetch both ratings in a single query. The CASE WHEN resolves which row
	// belongs to the caller and which to the other party without two round-trips.
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

	const myRatingRow = rows.find((r) => r.reviewer_id === callerId) ?? null;
	const theirRatingRow = rows.find((r) => r.reviewer_id === otherPartyId) ?? null;

	const formatRating = (row) => {
		if (!row) return null;
		return {
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
		};
	};

	return {
		myRating: formatRating(myRatingRow),
		theirRating: formatRating(theirRatingRow),
	};
};

// ─── Get public ratings for a user ────────────────────────────────────────────
//
// Publicly readable — no authentication required at the service level (the
// route itself is unprotected). Returns paginated visible ratings for a user.
//
// Each row includes enough to render a review card:
//   - score and comment
//   - reviewer's public name and profile photo
//   - createdAt
//
// Does NOT return the reviewer's full profile. Does NOT return invisible ratings
// (is_visible = FALSE, set by admin moderation).
//
// Keyset pagination on (created_at DESC, rating_id ASC) — newest first.
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
       COALESCE(sp.full_name, u.email) AS reviewer_name,
       sp.profile_photo_url            AS reviewer_photo_url
     FROM ratings r
     JOIN users u
       ON u.user_id    = r.reviewer_id
      AND u.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = r.reviewer_id
      AND sp.deleted_at IS NULL
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
// Returns all ratings the authenticated user has submitted as a reviewer.
// Includes the reviewee's summary (name, type) so the UI can render context.
// Keyset pagination on (created_at DESC, rating_id ASC).
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

       -- Reviewee summary — resolved polymorphically.
       -- For user reviewees: prefer student full_name, fall back to email.
       -- For property reviewees: use property_name.
       CASE
         WHEN r.reviewee_type = 'user'
         THEN COALESCE(sp_rev.full_name, pop_rev.owner_full_name, u_rev.email)
         ELSE p_rev.property_name
       END AS reviewee_name,

       CASE
         WHEN r.reviewee_type = 'user'
         THEN sp_rev.profile_photo_url
         ELSE NULL
       END AS reviewee_photo_url

     FROM ratings r

     -- User reviewee joins (LEFT — only populated when reviewee_type = 'user')
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

     -- Property reviewee joins (LEFT — only populated when reviewee_type = 'property')
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
// Publicly readable — no authentication required. Returns paginated visible
// ratings for a specific property (reviewee_type = 'property', is_visible = TRUE).
//
// Mirrors getPublicRatings but for properties. Each row includes enough to
// render a review card: scores, comment, reviewer name/photo, createdAt.
//
// Pre-check: verifies the property exists (404 if not). This gives a clean
// error rather than silently returning an empty list for a non-existent property,
// which would make it impossible to distinguish "no ratings yet" from "wrong ID".
//
// Keyset pagination on (created_at DESC, rating_id ASC) — newest first.
export const getPublicPropertyRatings = async (propertyId, filters) => {
	// Property existence check — 404 for unknown or soft-deleted properties.
	const { rows: propRows } = await pool.query(
		`SELECT 1 FROM properties WHERE property_id = $1 AND deleted_at IS NULL`,
		[propertyId],
	);
	if (!propRows.length) {
		throw new AppError("Property not found", 404);
	}

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
       COALESCE(sp.full_name, u.email) AS reviewer_name,
       sp.profile_photo_url            AS reviewer_photo_url
     FROM ratings r
     JOIN users u
       ON u.user_id    = r.reviewer_id
      AND u.deleted_at IS NULL
     LEFT JOIN student_profiles sp
       ON sp.user_id    = r.reviewer_id
      AND sp.deleted_at IS NULL
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
