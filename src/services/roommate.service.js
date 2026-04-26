// src/services/roommate.service.js
//
// Business logic for the roommate-matching feed.
//
// Feed strategy:
//   1. Fetch a page of candidate student IDs (opt-in, not blocked, optional city
//      filter) ordered by looking_updated_at DESC with keyset cursor.
//   2. Score those IDs against the requesting user via Jaccard similarity.
//   3. Merge scores into the candidate rows and return.
//
// We do NOT sort by score at the DB level — that would require loading all
// candidates before paginating, which kills performance. Instead we surface
// recency-ordered candidates with score as a display field. A future
// "sortBy=compatibility" mode can fetch a larger batch (e.g. 200), sort in
// memory, and slice — same tradeoff as the existing listing search.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { scoreUsersForUser, hasPreferences } from "../db/utils/roommateCompatibility.js";

const MAX_BLOCKS_PER_USER = 200;

// ─── getRoommateFeed ──────────────────────────────────────────────────────────

export const getRoommateFeed = async (requestingUserId, filters) => {
	const { city, cursorTime, cursorId, limit = 20 } = filters;
	const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 50);

	// Whether the requesting user has any preferences set — needed to decide
	// whether to expose compatibility scores at all.
	const callerHasPrefs = await hasPreferences(requestingUserId);

	// Build the candidate query dynamically.
	// We exclude:
	//   • the requesting user themselves
	//   • users blocked BY the caller (blocker_id = caller)
	//   • users who have blocked the caller (blocked_id = caller)
	const clauses = [
		`sp.looking_for_roommate = TRUE`,
		`sp.deleted_at IS NULL`,
		`u.deleted_at IS NULL`,
		`u.account_status = 'active'`,
		`sp.user_id <> $1`,
		// Bidirectional block exclusion in a single NOT EXISTS
		`NOT EXISTS (
       SELECT 1 FROM roommate_blocks rb
       WHERE (rb.blocker_id = $1 AND rb.blocked_id = sp.user_id)
          OR (rb.blocker_id = sp.user_id AND rb.blocked_id = $1)
     )`,
	];
	const params = [requestingUserId];
	let p = 2;

	if (city) {
		const escaped = city.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
		// Match against the city stored on their most-recent active listing, falling
		// back to a simple city column on student_profiles if we add one later.
		// For now we check listings — a student has at least one active listing in that city.
		clauses.push(
			`EXISTS (
         SELECT 1 FROM listings l
         WHERE l.posted_by  = sp.user_id
           AND l.deleted_at IS NULL
           AND l.status     = 'active'
           AND LOWER(l.city) LIKE LOWER($${p}) ESCAPE '\\'
       )`,
		);
		params.push(`${escaped}%`);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		// looking_updated_at DESC, user_id ASC tie-break (UUID ordering)
		clauses.push(
			`(sp.looking_updated_at < $${p} OR (sp.looking_updated_at = $${p} AND sp.user_id > $${p + 1}::uuid))`,
		);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(safeLimit + 1);
	const limitParam = p;

	const { rows: candidates } = await pool.query(
		`SELECT
       sp.user_id,
       sp.full_name,
       sp.profile_photo_url,
       sp.bio,
       sp.roommate_bio,
       sp.course,
       sp.year_of_study,
       sp.looking_updated_at,
       u.average_rating,
       u.rating_count,
       i.name           AS institution_name,
       i.city           AS institution_city
     FROM student_profiles sp
     JOIN users u
       ON u.user_id    = sp.user_id
     LEFT JOIN institutions i
       ON i.institution_id = sp.institution_id
      AND i.deleted_at     IS NULL
     WHERE ${clauses.join(" AND ")}
     ORDER BY sp.looking_updated_at DESC, sp.user_id ASC
     LIMIT $${limitParam}`,
		params,
	);

	const hasNextPage = candidates.length > safeLimit;
	const items = hasNextPage ? candidates.slice(0, safeLimit) : candidates;

	// Fetch all preferences for candidates in one query (avoids N+1).
	let preferenceMap = {};
	let candidateHasPrefSet = {};
	if (items.length) {
		const candidateIds = items.map((r) => r.user_id);

		const { rows: prefRows } = await pool.query(
			`SELECT user_id, preference_key AS "preferenceKey", preference_value AS "preferenceValue"
       FROM user_preferences
       WHERE user_id = ANY($1::uuid[])
       ORDER BY user_id, preference_key`,
			[candidateIds],
		);

		for (const row of prefRows) {
			if (!preferenceMap[row.user_id]) preferenceMap[row.user_id] = [];
			preferenceMap[row.user_id].push({
				preferenceKey: row.preferenceKey,
				preferenceValue: row.preferenceValue,
			});
			candidateHasPrefSet[row.user_id] = true;
		}

		// Score only if the caller has preferences — otherwise every score is 0
		// and we just mark compatibilityAvailable = false.
		if (callerHasPrefs && candidateIds.length) {
			const scores = await scoreUsersForUser(requestingUserId, candidateIds);
			for (const item of items) {
				item._score = scores[item.user_id] ?? 0;
			}
		}
	}

	const nextCursor =
		hasNextPage ?
			{
				cursorTime: items[items.length - 1].looking_updated_at.toISOString(),
				cursorId: items[items.length - 1].user_id,
			}
		:	null;

	return {
		items: items.map((row) => ({
			userId: row.user_id,
			fullName: row.full_name,
			profilePhotoUrl: row.profile_photo_url,
			bio: row.bio,
			roommateBio: row.roommate_bio,
			course: row.course,
			yearOfStudy: row.year_of_study,
			averageRating: row.average_rating,
			ratingCount: row.rating_count,
			institution: row.institution_name ? { name: row.institution_name, city: row.institution_city } : null,
			compatibilityScore: callerHasPrefs ? (row._score ?? 0) : 0,
			compatibilityAvailable: callerHasPrefs && (candidateHasPrefSet[row.user_id] ?? false),
			preferences: preferenceMap[row.user_id] ?? [],
		})),
		nextCursor,
	};
};

// ─── updateRoommateProfile ────────────────────────────────────────────────────

export const updateRoommateProfile = async (requestingUserId, targetUserId, { lookingForRoommate, roommateBio }) => {
	if (requestingUserId !== targetUserId) {
		throw new AppError("Forbidden", 403);
	}

	const { rows } = await pool.query(
		`UPDATE student_profiles
     SET looking_for_roommate = $1,
         roommate_bio         = $2,
         looking_updated_at   = CASE WHEN $1 = TRUE THEN NOW() ELSE looking_updated_at END,
         updated_at           = NOW()
     WHERE user_id    = $3
       AND deleted_at IS NULL
     RETURNING user_id, looking_for_roommate, roommate_bio, looking_updated_at`,
		[lookingForRoommate, roommateBio ?? null, targetUserId],
	);

	if (!rows.length) {
		throw new AppError("Student profile not found", 404);
	}

	logger.info({ userId: targetUserId, lookingForRoommate }, "Roommate profile updated");

	return {
		userId: rows[0].user_id,
		lookingForRoommate: rows[0].looking_for_roommate,
		roommateBio: rows[0].roommate_bio,
		lookingUpdatedAt: rows[0].looking_updated_at,
	};
};

// ─── blockUser ────────────────────────────────────────────────────────────────

export const blockUser = async (requestingUserId, targetUserId) => {
	if (requestingUserId === targetUserId) {
		throw new AppError("You cannot block yourself", 422);
	}

	// Verify the target user exists and is a student
	const { rows: targetRows } = await pool.query(
		`SELECT u.user_id FROM users u
     WHERE u.user_id    = $1
       AND u.deleted_at IS NULL
       AND u.account_status = 'active'`,
		[targetUserId],
	);
	if (!targetRows.length) {
		throw new AppError("User not found", 404);
	}

	// Soft cap — prevent bloat
	const { rows: countRows } = await pool.query(
		`SELECT COUNT(*)::int AS cnt FROM roommate_blocks WHERE blocker_id = $1`,
		[requestingUserId],
	);
	if (countRows[0].cnt >= MAX_BLOCKS_PER_USER) {
		throw new AppError(`You can block at most ${MAX_BLOCKS_PER_USER} users`, 422);
	}

	await pool.query(
		`INSERT INTO roommate_blocks (blocker_id, blocked_id)
     VALUES ($1, $2)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
		[requestingUserId, targetUserId],
	);

	logger.info({ blockerId: requestingUserId, blockedId: targetUserId }, "Roommate block added");
	return { blockedUserId: targetUserId, blocked: true };
};

// ─── unblockUser ─────────────────────────────────────────────────────────────

export const unblockUser = async (requestingUserId, targetUserId) => {
	const { rowCount } = await pool.query(`DELETE FROM roommate_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [
		requestingUserId,
		targetUserId,
	]);

	if (rowCount === 0) {
		// Idempotent — if the block didn't exist, that's fine.
		logger.debug(
			{ blockerId: requestingUserId, blockedId: targetUserId },
			"Roommate unblock: no-op (block not found)",
		);
	} else {
		logger.info({ blockerId: requestingUserId, blockedId: targetUserId }, "Roommate block removed");
	}

	return { blockedUserId: targetUserId, blocked: false };
};
