
































import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const UUID_V1_TO_V5_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;













export const getFeed = async (userId, filters) => {
	const { isRead, cursorTime, cursorId, limit: rawLimit = 20 } = filters;
	const limit = Math.min(Math.max(1, rawLimit), 100); 

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

	if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
		throw new AppError("notificationIds must be a non-empty array when all is not true", 400);
	}

	for (const id of notificationIds) {
		if (typeof id !== "string" || !UUID_V1_TO_V5_REGEX.test(id)) {
			throw new AppError("notificationIds must contain only valid UUID strings", 400);
		}
	}

	
	
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
