// src/services/notification.service.js
//
// HTTP-facing service for the notification feed. This file handles reads and
// the mark-read mutation — it does NOT insert notifications. Insertion is
// exclusively the notification worker's job (via the BullMQ queue). Keeping
// reads and writes in separate concerns means this service never competes with
// the worker for the same code path.
//
// ─── THE MESSAGE ASSEMBLY PATTERN ────────────────────────────────────────────
//
// The `message` column in the notifications table is populated by the worker at
// insert time (from the NOTIFICATION_MESSAGES map in notificationWorker.js).
// This service reads it directly from the DB rather than re-assembling it here.
// That means the client always sees the message that was current when the
// notification was created — which is the correct behaviour for a historical
// feed (you don't want old notifications to silently change wording when the
// template map is updated). If we assembled the message here at read time,
// every old notification would retroactively get the new wording on the next
// read, which could be confusing.
//
// ─── PARTIAL INDEX UTILISATION ───────────────────────────────────────────────
//
// The schema has two indexes on notifications:
//   idx_notifications_recipient_unread  — (recipient_id, created_at DESC) WHERE is_read = FALSE
//   idx_notifications_recipient_all     — (recipient_id, created_at DESC) WHERE deleted_at IS NULL
//
// getUnreadCount hits the first index directly — it queries WHERE is_read = FALSE,
// which matches the partial index predicate exactly, giving an index scan on a
// very small set regardless of total notification history.
//
// getFeed hits the second index when no isRead filter is provided (full history),
// and the first when isRead = false is specified. Both cases are covered.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

// ─── Get notification feed ────────────────────────────────────────────────────
//
// Returns the authenticated user's paginated notification feed.
// Keyset pagination on (created_at DESC, notification_id ASC):
//   - newest-first is the most useful default for a notification bell dropdown
//   - notification_id ASC is the tiebreaker for rows inserted in the same
//     millisecond (common in tests, possible in production during bursts)
//
// The isRead filter is optional. When absent, the full feed (read + unread) is
// returned. When true or false, only rows matching that read state are returned.
// This lets the client use a single endpoint for both the bell dropdown (unread
// only) and the full notification history page.
export const getFeed = async (userId, filters) => {
	const { isRead, cursorTime, cursorId, limit = 20 } = filters;

	const clauses = [`n.recipient_id = $1`, `n.deleted_at IS NULL`];
	const params = [userId];
	let p = 2;

	if (isRead !== undefined) {
		clauses.push(`n.is_read = $${p}`);
		params.push(isRead);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		// Mirrors ORDER BY (created_at DESC, notification_id ASC) exactly.
		// "Give me rows after this cursor" in a DESC-first sort means:
		//   created_at is strictly older (less than cursorTime), OR
		//   created_at is equal AND notification_id is strictly greater (tiebreaker ASC).
		clauses.push(`(n.created_at < $${p} OR (n.created_at = $${p} AND n.notification_id > $${p + 1}::uuid))`);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const { rows } = await pool.query(
		`SELECT
       n.notification_id,
       n.actor_id,
       n.notification_type  AS type,
       n.entity_type,
       n.entity_id,
       n.message,
       n.is_read,
       n.created_at
     FROM notifications n
     WHERE ${clauses.join(" AND ")}
     ORDER BY n.created_at DESC, n.notification_id ASC
     LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].created_at.toISOString(),
				cursorId: items[items.length - 1].notification_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			notificationId: row.notification_id,
			actorId: row.actor_id,
			type: row.type,
			entityType: row.entity_type,
			entityId: row.entity_id,
			message: row.message,
			isRead: row.is_read,
			createdAt: row.created_at,
		})),
		nextCursor,
	};
};

// ─── Get unread count ─────────────────────────────────────────────────────────
//
// Returns the integer count of unread notifications for the bell badge.
// This query runs on every page load, so it must be as fast as possible.
//
// The partial index idx_notifications_recipient_unread covers exactly
// WHERE is_read = FALSE AND deleted_at IS NULL, so this is an index scan
// on a small, always-current set regardless of how many read notifications
// exist in the table. Read notifications fall out of the partial index
// automatically as they are marked — the index never grows unboundedly.
export const getUnreadCount = async (userId) => {
	const { rows } = await pool.query(
		`SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE recipient_id = $1
       AND is_read      = FALSE
       AND deleted_at   IS NULL`,
		[userId],
	);

	return { count: rows[0].count };
};

// ─── Mark notifications as read ───────────────────────────────────────────────
//
// Two modes:
//   all: true            — bulk UPDATE for all unread rows belonging to this user
//   notificationIds: [...] — selective UPDATE for specific notification IDs
//
// Both cases use AND is_read = FALSE as a guard, making the operation idempotent:
// re-marking an already-read notification is a silent no-op. The client can call
// this multiple times without double-counting or side effects.
//
// The selective case uses AND recipient_id = $1 in addition to the notification
// ID list. This is a security check: without it, a user could mark any
// notification as read by supplying its UUID, even if it belongs to someone else.
// With it, only rows belonging to this user are touched — foreign IDs in the
// array simply produce no matching rows and are silently ignored.
//
// Both cases return { updated: rowCount } so the client can confirm how many
// rows were actually changed (useful for debugging and UI optimistic updates).
export const markRead = async (userId, { notificationIds, all }) => {
	if (all === true) {
		const { rowCount } = await pool.query(
			`UPDATE notifications
       SET is_read = TRUE
       WHERE recipient_id = $1
         AND is_read      = FALSE
         AND deleted_at   IS NULL`,
			[userId],
		);

		logger.info({ userId, updated: rowCount }, "All notifications marked as read");
		return { updated: rowCount };
	}

	// Selective mark-read. notificationIds is guaranteed non-empty by the Zod
	// schema (min(1)), so the ANY($2::uuid[]) clause always has at least one UUID.
	const { rowCount } = await pool.query(
		`UPDATE notifications
     SET is_read = TRUE
     WHERE recipient_id   = $1
       AND notification_id = ANY($2::uuid[])
       AND is_read         = FALSE
       AND deleted_at      IS NULL`,
		[userId, notificationIds],
	);

	logger.info({ userId, requested: notificationIds.length, updated: rowCount }, "Notifications marked as read");
	return { updated: rowCount };
};
