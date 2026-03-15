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
// ─── TRANSITION DETECTION — CONCURRENCY-SAFE ─────────────────────────────────
//
// The previous implementation read previousStatus with a bare pool.query SELECT
// and then ran the UPDATE as a separate bare pool.query. Because both statements
// ran outside any transaction, two concurrent confirms (initiator and counterpart
// calling at almost the same moment) could both read previousStatus = 'pending'
// before either UPDATE committed, causing both to evaluate
// justTransitionedToConfirmed = true and enqueue duplicate notifications.
//
// The fix wraps both statements in an explicit transaction and uses
// SELECT … FOR UPDATE to acquire a row-level lock before reading previousStatus.
// PostgreSQL serializes all FOR UPDATE requests on the same row, so the second
// concurrent request blocks until the first transaction commits. When it
// resumes, it reads the post-commit previousStatus = 'confirmed', evaluates
// justTransitionedToConfirmed = false, and does not enqueue notifications.
//
// Why a transaction rather than a single-statement CTE? A single UPDATE cannot
// observe the pre-mutation value of the row it is updating inside the same
// statement — the RETURNING clause reflects the post-mutation state only. A CTE
// such as WITH prev AS (SELECT … FOR UPDATE) UPDATE … RETURNING would still read
// the pre-lock snapshot for the CTE part in many planner paths. The explicit
// BEGIN / SELECT FOR UPDATE / UPDATE / COMMIT pattern is the clearest, most
// portable, and most correct way to achieve this in PostgreSQL.
export const confirmConnection = async (callerId, connectionId) => {
	// client is declared outside try so the finally block can reference it, but
	// pool.connect() is called inside try so that if the pool is exhausted or the
	// database is unreachable the thrown error is caught normally and finally does
	// not attempt client.release() on an undefined variable.
	let client;
	let conn;
	let previousStatus;

	try {
		client = await pool.connect();
		await client.query("BEGIN");

		// Step 1: Lock the row for this transaction. The FOR UPDATE clause
		// means concurrent transactions that also attempt FOR UPDATE on the
		// same connection_id will block here until this transaction commits or
		// rolls back. The access-control predicate (initiator_id / counterpart_id)
		// is included so a non-party caller simply gets zero rows and we surface
		// a 404 without ever acquiring a lock on a row the caller has no business
		// touching.
		const { rows: prevRows } = await client.query(
			`SELECT confirmation_status
       FROM connections
       WHERE connection_id = $1
         AND (initiator_id = $2 OR counterpart_id = $2)
         AND deleted_at IS NULL
       FOR UPDATE`,
			[connectionId, callerId],
		);

		if (!prevRows.length) {
			// Not found or caller is not a party — roll back and surface 404.
			await client.query("ROLLBACK");
			throw new AppError("Connection not found", 404);
		}

		// Capture the status that was current at the moment we acquired the lock.
		// Any concurrent transaction that already held this lock has now committed,
		// so this value reflects the fully-committed state of the row.
		previousStatus = prevRows[0].confirmation_status;

		// Step 2: Atomic UPDATE — flips the calling party's flag and sets
		// confirmation_status = 'confirmed' when both flags are true, all within
		// the same lock scope. Party membership is enforced again in the WHERE
		// clause for defence-in-depth (the FOR UPDATE above already verified it).
		const { rowCount, rows } = await client.query(
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

		// This should never be zero at this point because the FOR UPDATE above
		// already verified the row exists and the caller is a party, but guard
		// anyway so a data-race between SELECT and UPDATE (e.g. concurrent
		// soft-delete) surfaces cleanly as a 404 rather than a TypeError.
		if (rowCount === 0) {
			await client.query("ROLLBACK");
			throw new AppError("Connection not found", 404);
		}

		conn = rows[0];
		await client.query("COMMIT");
	} catch (err) {
		// Attempt a rollback only when a client was actually acquired. If
		// pool.connect() itself threw, client is undefined and there is no
		// open transaction to roll back — attempting client.query() here would
		// throw a TypeError that would replace the original error in the call stack.
		if (client) {
			try {
				await client.query("ROLLBACK");
			} catch (_) {
				// Ignore — connection may already be in an error state.
			}
		}
		throw err;
	} finally {
		// Same guard: only release if pool.connect() succeeded.
		if (client) client.release();
	}

	// A genuine transition: the row was NOT confirmed when we locked it, and IS
	// confirmed after the UPDATE. Because the lock serializes concurrent requests,
	// only one transaction can observe this transition — the second concurrent
	// request will read previousStatus = 'confirmed' after the first commits, so
	// justTransitionedToConfirmed will be false for it.
	const justTransitionedToConfirmed = previousStatus !== "confirmed" && conn.confirmation_status === "confirmed";

	logger.info(
		{
			callerId,
			connectionId,
			initiatorConfirmed: conn.initiator_confirmed,
			counterpartConfirmed: conn.counterpart_confirmed,
			confirmationStatus: conn.confirmation_status,
			previousStatus,
		},
		justTransitionedToConfirmed ? "Connection confirmed by both parties" : "Connection confirmation recorded",
	);

	// ── Post-commit notifications ─────────────────────────────────────────────
	//
	// Only fire when the status JUST transitioned to 'confirmed' for the first
	// time. A single-side confirmation is silent. Re-confirming an already
	// confirmed connection does not re-send notifications.
	if (justTransitionedToConfirmed) {
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
       l.title             AS listing_title,
       l.city              AS listing_city,
       l.rent_per_month    AS listing_rent_per_month,
       l.room_type         AS listing_room_type,
       l.listing_type      AS listing_type,

       -- The "other party" profile — resolved relative to the caller.
       CASE WHEN c.initiator_id = $2
            THEN c.counterpart_id
            ELSE c.initiator_id
       END AS other_party_id,

       COALESCE(sp_other.full_name, pop_other.owner_full_name, u_other.email)
         AS other_party_name,

       sp_other.profile_photo_url AS other_party_photo_url,
       u_other.average_rating     AS other_party_rating,
       u_other.rating_count       AS other_party_rating_count

     FROM connections c

     LEFT JOIN listings l
       ON l.listing_id = c.listing_id

     JOIN users u_other
       ON u_other.user_id = CASE WHEN c.initiator_id = $2
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

       c.listing_id,
       l.title          AS listing_title,
       l.city           AS listing_city,
       l.rent_per_month AS listing_rent_per_month,
       l.listing_type   AS listing_type,

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
