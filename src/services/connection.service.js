// src/services/connection.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { enqueueNotification } from "../workers/notificationQueue.js";

// ─── Confirm connection ───────────────────────────────────────────────────────
// Either party flips their own confirmation flag. When both flags become true,
// confirmation_status transitions to 'confirmed' in the same atomic UPDATE.
// Post-commit notifications are sent to both parties only on that transition.
export const confirmConnection = async (callerId, connectionId) => {
	let client;
	let conn;
	let previousStatus;

	try {
		client = await pool.connect();
		await client.query("BEGIN");

		// Lock the row and verify party membership in one query.
		// If the caller is not a party or the row does not exist, zero rows are
		// returned and we throw 404 — existence is never leaked to non-parties.
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
			await client.query("ROLLBACK");
			throw new AppError("Connection not found", 404);
		}

		previousStatus = prevRows[0].confirmation_status;

		// Single atomic UPDATE: flips the caller's flag and conditionally promotes
		// confirmation_status to 'confirmed' when both flags become true.
		const { rows } = await client.query(
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

		// The FOR UPDATE above already guarantees the row exists and the caller is
		// a party, so rowCount === 0 here would indicate a concurrent hard-delete
		// between SELECT and UPDATE — treat as 404.
		if (!rows.length) {
			await client.query("ROLLBACK");
			throw new AppError("Connection not found", 404);
		}

		conn = rows[0];
		await client.query("COMMIT");
	} catch (err) {
		if (client) {
			try {
				await client.query("ROLLBACK");
			} catch (_) {
				// Ignore — connection may already be in an error state.
			}
		}
		throw err;
	} finally {
		if (client) client.release();
	}

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

	if (justTransitionedToConfirmed) {
		enqueueNotification({
			recipientId: conn.initiator_id,
			type: "connection_confirmed",
			entityType: "connection",
			entityId: connectionId,
		});

		enqueueNotification({
			recipientId: conn.counterpart_id,
			type: "connection_confirmed",
			entityType: "connection",
			entityId: connectionId,
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
// Both parties can view full detail including each other's confirmation status.
// Third parties receive 404 — the WHERE clause never leaks resource existence.
// other_party_name uses only display names; email is never exposed as a fallback.
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

       l.title             AS listing_title,
       l.city              AS listing_city,
       l.rent_per_month    AS listing_rent_per_month,
       l.room_type         AS listing_room_type,
       l.listing_type      AS listing_type,

       CASE WHEN c.initiator_id = $2
            THEN c.counterpart_id
            ELSE c.initiator_id
       END AS other_party_id,

       COALESCE(sp_other.full_name, pop_other.owner_full_name)
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
// Returns all connections the caller is a party to, newest first.
// other_party_name uses only display names; email is never exposed as a fallback.
export const getMyConnections = async (userId, filters) => {
	const { confirmationStatus, connectionType, cursorTime, cursorId, limit: rawLimit = 20 } = filters;
	const limit = Math.min(Math.max(1, rawLimit), 100); // Cap between 1 and 100

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

       COALESCE(sp_other.full_name, pop_other.owner_full_name)
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
