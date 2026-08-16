// src/db/utils/roommateCompatibility.js
import { pool } from "../client.js";
import { logger } from "../../logger/index.js";

export const scoreUsersForUser = async (requestingUserId, candidateIds, client = pool) => {
	if (!candidateIds.length) return {};

	try {
		// Step 1 — intersection: pairs where BOTH users have the same key+value.
		const { rows: intersectRows } = await client.query(
			`SELECT
         up_b.user_id,
         COUNT(*)::int AS shared_count
       FROM user_preferences up_a
       JOIN user_preferences up_b
         ON up_b.preference_key   = up_a.preference_key
        AND up_b.preference_value = up_a.preference_value
       WHERE up_a.user_id = $1
         AND up_b.user_id = ANY($2::uuid[])
         AND up_b.user_id <> $1
       GROUP BY up_b.user_id`,
			[requestingUserId, candidateIds],
		);

		// Step 2 — individual preference counts for union computation.
		// FIX: pass a single array $1 for ANY($1::uuid[]) — previously the code
		// spread [requestingUserId, ...candidateIds] which bound multiple positional
		// params while the SQL only had one placeholder ($1), causing a DB error.
		const allIds = [requestingUserId, ...candidateIds];
		const { rows: countRows } = await client.query(
			`SELECT user_id, COUNT(*)::int AS pref_count
       FROM user_preferences
       WHERE user_id = ANY($1::uuid[])
       GROUP BY user_id`,
			[allIds],
		);

		const myCount = countRows.find((r) => r.user_id === requestingUserId)?.pref_count ?? 0;
		const countMap = Object.fromEntries(countRows.map((r) => [r.user_id, r.pref_count]));
		const sharedMap = Object.fromEntries(intersectRows.map((r) => [r.user_id, r.shared_count]));

		return candidateIds.reduce((acc, id) => {
			const shared = sharedMap[id] ?? 0;
			const theirCount = countMap[id] ?? 0;
			const union = myCount + theirCount - shared;
			acc[id] = union === 0 ? 0 : Math.round((shared / union) * 100);
			return acc;
		}, {});
	} catch (err) {
		logger.error(
			{ err, requestingUserId, candidateCount: candidateIds.length },
			"scoreUsersForUser: DB error computing compatibility scores — returning empty scores",
		);
		return {};
	}
};

export const hasPreferences = async (userId, client = pool) => {
	try {
		const { rows } = await client.query(
			`SELECT EXISTS (SELECT 1 FROM user_preferences WHERE user_id = $1) AS has_prefs`,
			[userId],
		);
		return rows[0].has_prefs === true;
	} catch (err) {
		logger.error({ err, userId }, "hasPreferences: DB error checking user preferences — returning false");
		return false;
	}
};
