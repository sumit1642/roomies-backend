// src/services/connection.service.js
//
// ─── WHAT A CONNECTION IS ─────────────────────────────────────────────────────
//
// A connections row is created atomically when a poster accepts an interest
// request (see interest.service.js _acceptInterestRequest). At birth, both
// confirmation flags are FALSE and confirmation_status is 'pending'.
//
// This service handles everything that happens AFTER that creation:
//   1. Either party independently confirms the real-world interaction happened.
//   2. When both have confirmed, confirmation_status flips to 'confirmed'.
//   3. Phase 4 ratings become submittable once status = 'confirmed'.
//
// ─── THE ACTOR RESOLUTION PATTERN ────────────────────────────────────────────
//
// Connections are two-party resources. The caller's role (initiator vs.
// counterpart) is resolved by comparing req.user.userId against the two party
// IDs on the row. If neither matches, the caller is a third party and receives
// 404 — not 403. Returning 403 would confirm the resource exists, which leaks
// information. The WHERE clause itself enforces this: if the caller is not a
// party, no row is returned and rowCount === 0 → 404.
//
// ─── NOTIFICATION DELIVERY ───────────────────────────────────────────────────
//
// Post-commit notifications are enqueued via BullMQ rather than inserted
// directly with pool.query. The job survives process crashes; the worker
// retries up to 5 times with exponential backoff before landing in the
// BullMQ failed set. queue.add() itself uses .catch() because it can fail
// if Redis is momentarily unreachable — a missed notification is a UX
// inconvenience, not a data integrity problem.

import { Queue } from "bullmq";
import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { NOTIFICATION_QUEUE_NAME } from "../workers/notificationWorker.js";
import { config } from "../config/env.js";

// Singleton queue — lightweight until .add() is called, safe at module scope.
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

// ─── Confirm connection ───────────────────────────────────────────────────────
//
// Each party flips their own flag independently by calling this endpoint.
// The atomicity requirement: checking whether both flags are now true AND
// setting confirmation_status = 'confirmed' must happen in a single UPDATE,
// not as a read-then-write sequence. A read-then-write has a race window where
// two concurrent confirmations both read "only one flag true", both skip the
// status flip, and the connection is permanently stuck at 'pending' despite
// both parties having confirmed.
//
// The CASE WHEN expressions in the UPDATE solve this cleanly:
//   - The correct flag for the calling party is flipped to TRUE.
//   - confirmation_status is set to 'confirmed' if and only if BOTH flags
//     are true after this write — evaluated inside the same atomic statement.
//   - A caller who is not a party gets rowCount === 0 → 404.
//   - A double-confirm from the same party is idempotent (flag was already
//     TRUE, no change, but the UPDATE still succeeds with the row returned).
//
// The WHERE clause `AND (initiator_id = $2 OR counterpart_id = $2)` is the
// access control gate. It is not a separate check — it is part of the UPDATE
// itself, so access verification and state mutation are truly atomic.
export const confirmConnection = async (callerId, connectionId) => {
	// A single atomic UPDATE that simultaneously:
	//   1. Flips the correct party's confirmation flag to TRUE
	//   2. Sets confirmation_status = 'confirmed' if both flags are now TRUE
	//   3. Enforces access control (caller must be initiator or counterpart)
	//
	// Why no transaction wrapper? This is a single statement. PostgreSQL
	// guarantees each statement is atomic regardless of an explicit transaction
	// wrapper. Adding BEGIN/COMMIT around a single UPDATE adds latency (two extra
	// round-trips) with zero additional safety.
	const { rowCount, rows } = await pool.query(
		`UPDATE connections
     SET
       initiator_confirmed   = CASE
                                 WHEN initiator_id = $2
                                 THEN TRUE
                                 ELSE initiator_confirmed
                               END,
       counterpart_confirmed = CASE
                                 WHEN counterpart_id = $2
                                 THEN TRUE
                                 ELSE counterpart_confirmed
                               END,
       confirmation_status   = CASE
                                 WHEN (initiator_confirmed  OR initiator_id  = $2)
                                  AND (counterpart_confirmed OR counterpart_id = $2)
                                 THEN 'confirmed'::confirmation_status_enum
                                 ELSE confirmation_status
                               END,
       updated_at = NOW()
     WHERE connection_id = $1
       AND (initiator_id = $2 OR counterpart_id = $2)
       AND deleted_at IS NULL
     RETURNING
       connection_id,
       initiator_id,
       counterpart_id,
       initiator_confirmed,
       counterpart_confirmed,
       confirmation_status,
       updated_at`,
		[connectionId, callerId],
	);

	// rowCount === 0 means either the connection does not exist OR the caller is
	// not a party. 404 in both cases — never 403, which would confirm existence.
	if (rowCount === 0) {
		throw new AppError("Connection not found", 404);
	}

	const conn = rows[0];
	const justConfirmed = conn.confirmation_status === "confirmed";

	logger.info(
		{
			callerId,
			connectionId,
			initiatorConfirmed: conn.initiator_confirmed,
			counterpartConfirmed: conn.counterpart_confirmed,
			confirmationStatus: conn.confirmation_status,
		},
		justConfirmed ? "Connection confirmed by both parties" : "Connection confirmation recorded",
	);

	// ── Post-commit notifications ─────────────────────────────────────────────
	//
	// Only fire when status just flipped to 'confirmed' — a single-side
	// confirmation is silent. Both parties receive the notification via two
	// separate queue.add() calls so a Redis failure on one doesn't prevent
	// the other from being enqueued.
	if (justConfirmed) {
		notificationQueue
			.add("send-notification", {
				recipientId: conn.initiator_id,
				type: "connection_confirmed",
				entityType: "connection",
				entityId: connectionId,
			})
			.catch((err) => {
				logger.error(
					{ err, connectionId, recipientId: conn.initiator_id },
					"Failed to enqueue connection_confirmed notification for initiator",
				);
			});

		notificationQueue
			.add("send-notification", {
				recipientId: conn.counterpart_id,
				type: "connection_confirmed",
				entityType: "connection",
				entityId: connectionId,
			})
			.catch((err) => {
				logger.error(
					{ err, connectionId, recipientId: conn.counterpart_id },
					"Failed to enqueue connection_confirmed notification for counterpart",
				);
			});
	}

	return {
		connectionId: conn.connection_id,
		initiatorConfirmed: conn.initiator_confirmed,
		counterpartConfirmed: conn.counterpart_confirmed,
		confirmationStatus: conn.confirmation_status,
		updatedAt: conn.updated_at,
	};
};

// ─── Get single connection (detail view) ─────────────────────────────────────
//
// Returns full detail for one connection. Access is restricted to the two
// parties — the WHERE clause enforces this. Third parties get 404.
//
// The response shape includes:
//   - Both confirmation flags, so each party can see whether the other has
//     confirmed yet (drives UI state like "waiting for X to confirm")
//   - The other party's public profile summary (name, photo, rating)
//   - The listing summary (title, city, rent, type)
//   - connection_id in the response so Phase 4 can reference it for ratings
//
// The "other party" summary resolves dynamically: if the caller is the
// initiator, the response shows the counterpart's profile, and vice versa.
// This is done with CASE WHEN in the SELECT so the query returns the correct
// profile without a second round-trip.
export const getConnection = async (callerId, connectionId) => {
	const { rows } = await pool.query(
		`SELECT
       c.connection_id,
       c.initiator_id,
       c.counterpart_id,
       c.listing_id,
       c.connection_type,
       c.start_date,
       c.end_date,
       c.initiator_confirmed,
       c.counterpart_confirmed,
       c.confirmation_status,
       c.interest_request_id,
       c.created_at,
       c.updated_at,

       -- Listing summary — may be NULL if the listing was hard-deleted
       -- (connection.listing_id is SET NULL ON DELETE in the schema)
       l.title             AS listing_title,
       l.city              AS listing_city,
       l.rent_per_month    AS listing_rent_per_month,
       l.room_type         AS listing_room_type,
       l.listing_type      AS listing_type,

       -- The "other party" profile — resolved relative to the caller.
       -- If caller = initiator → other = counterpart, and vice versa.
       -- CASE WHEN picks the correct user_id to join against.
       CASE WHEN c.initiator_id = $2
            THEN c.counterpart_id
            ELSE c.initiator_id
       END AS other_party_id,

       -- Full name: prefer profile name over email fallback, same pattern
       -- as interest service (COALESCE across student and pg_owner profiles).
       COALESCE(sp_other.full_name, pop_other.owner_full_name, u_other.email)
         AS other_party_name,

       sp_other.profile_photo_url AS other_party_photo_url,
       u_other.average_rating     AS other_party_rating,
       u_other.rating_count       AS other_party_rating_count

     FROM connections c

     -- Listing join: LEFT because listing_id is nullable (admin-created connections)
     -- and because ON DELETE SET NULL means the listing row may be gone.
     LEFT JOIN listings l
       ON l.listing_id = c.listing_id

     -- Other-party user join: resolved dynamically via CASE WHEN.
     -- The inline subquery approach avoids two separate joins (one for each role)
     -- and keeps the SELECT list clean.
     JOIN users u_other
       ON u_other.user_id = CASE WHEN c.initiator_id = $2
                                 THEN c.counterpart_id
                                 ELSE c.initiator_id
                            END
       AND u_other.deleted_at IS NULL

     -- Profile joins for the other party — both LEFT because a user can be
     -- either a student or a PG owner (or both), and we want whichever name
     -- is available without failing if one profile type is missing.
     LEFT JOIN student_profiles sp_other
       ON sp_other.user_id    = u_other.user_id
      AND sp_other.deleted_at IS NULL

     LEFT JOIN pg_owner_profiles pop_other
       ON pop_other.user_id   = u_other.user_id
      AND pop_other.deleted_at IS NULL

     WHERE c.connection_id = $1
       AND (c.initiator_id = $2 OR c.counterpart_id = $2)
       AND c.deleted_at IS NULL`,
		[connectionId, callerId],
	);

	if (!rows.length) {
		throw new AppError("Connection not found", 404);
	}

	const row = rows[0];

	return {
		connectionId: row.connection_id,
		connectionType: row.connection_type,
		confirmationStatus: row.confirmation_status,
		initiatorConfirmed: row.initiator_confirmed,
		counterpartConfirmed: row.counterpart_confirmed,
		startDate: row.start_date,
		endDate: row.end_date,
		interestRequestId: row.interest_request_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		listing:
			row.listing_id ?
				{
					listingId: row.listing_id,
					title: row.listing_title,
					city: row.listing_city,
					// Paise → rupees, same conversion rule as listing service
					rentPerMonth: row.listing_rent_per_month != null ? row.listing_rent_per_month / 100 : null,
					roomType: row.listing_room_type,
					listingType: row.listing_type,
				}
			:	null,
		otherParty: {
			userId: row.other_party_id,
			fullName: row.other_party_name,
			profilePhotoUrl: row.other_party_photo_url,
			averageRating: row.other_party_rating,
			ratingCount: row.other_party_rating_count,
		},
	};
};

// ─── Get my connections (dashboard feed) ─────────────────────────────────────
//
// Returns all connections the authenticated user is a party to (either as
// initiator or counterpart), newest first. Supports optional filtering by
// confirmation_status and connection_type.
//
// Keyset pagination: compound cursor (created_at DESC, connection_id ASC).
// The secondary sort on connection_id ASC provides a stable tiebreaker for
// rows with identical created_at values (common in automated tests where rows
// are inserted in the same millisecond). The cursor clause mirrors the ORDER BY
// exactly using PostgreSQL row value comparison.
//
// The LIMIT + 1 trick detects whether a next page exists without a separate
// COUNT(*) query, which is expensive on large tables and stale by the time it
// returns. Fetching one extra row costs a single extra row of I/O — negligible.
export const getMyConnections = async (userId, filters) => {
	const { confirmationStatus, connectionType, cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [`(c.initiator_id = $1 OR c.counterpart_id = $1)`, `c.deleted_at IS NULL`];
	const params = [userId];
	let p = 2;

	if (confirmationStatus !== undefined) {
		clauses.push(`c.confirmation_status = $${p}::confirmation_status_enum`);
		params.push(confirmationStatus);
		p++;
	}

	if (connectionType !== undefined) {
		clauses.push(`c.connection_type = $${p}::connection_type_enum`);
		params.push(connectionType);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		// Row value comparison that mirrors ORDER BY (created_at DESC, connection_id ASC).
		// "Give me rows that come AFTER this cursor position in the sort order" means:
		//   created_at is strictly earlier (older, since we sort DESC), OR
		//   created_at is equal AND connection_id is strictly greater (tiebreaker ASC).
		clauses.push(`(c.created_at < $${p} OR (c.created_at = $${p} AND c.connection_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const { rows } = await pool.query(
		`SELECT
       c.connection_id,
       c.initiator_id,
       c.counterpart_id,
       c.connection_type,
       c.confirmation_status,
       c.initiator_confirmed,
       c.counterpart_confirmed,
       c.start_date,
       c.end_date,
       c.created_at,
       c.updated_at,

       -- Listing summary for the dashboard card
       c.listing_id,
       l.title          AS listing_title,
       l.city           AS listing_city,
       l.rent_per_month AS listing_rent_per_month,
       l.listing_type   AS listing_type,

       -- Other party resolved dynamically
       CASE WHEN c.initiator_id = $1
            THEN c.counterpart_id
            ELSE c.initiator_id
       END AS other_party_id,

       COALESCE(sp_other.full_name, pop_other.owner_full_name, u_other.email)
         AS other_party_name,

       sp_other.profile_photo_url AS other_party_photo_url,
       u_other.average_rating     AS other_party_rating

     FROM connections c

     LEFT JOIN listings l
       ON l.listing_id = c.listing_id

     JOIN users u_other
       ON u_other.user_id = CASE WHEN c.initiator_id = $1
                                 THEN c.counterpart_id
                                 ELSE c.initiator_id
                            END
       AND u_other.deleted_at IS NULL

     LEFT JOIN student_profiles sp_other
       ON sp_other.user_id    = u_other.user_id
      AND sp_other.deleted_at IS NULL

     LEFT JOIN pg_owner_profiles pop_other
       ON pop_other.user_id   = u_other.user_id
      AND pop_other.deleted_at IS NULL

     WHERE ${clauses.join(" AND ")}
     ORDER BY c.created_at DESC, c.connection_id ASC
     LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].connection_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			connectionId: row.connection_id,
			connectionType: row.connection_type,
			confirmationStatus: row.confirmation_status,
			initiatorConfirmed: row.initiator_confirmed,
			counterpartConfirmed: row.counterpart_confirmed,
			startDate: row.start_date,
			endDate: row.end_date,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			listing:
				row.listing_id ?
					{
						listingId: row.listing_id,
						title: row.listing_title,
						city: row.listing_city,
						rentPerMonth: row.listing_rent_per_month != null ? row.listing_rent_per_month / 100 : null,
						listingType: row.listing_type,
					}
				:	null,
			otherParty: {
				userId: row.other_party_id,
				fullName: row.other_party_name,
				profilePhotoUrl: row.other_party_photo_url,
				averageRating: row.other_party_rating,
			},
		})),
		nextCursor,
	};
};
