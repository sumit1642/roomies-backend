// src/db/utils/roommateCompatibility.js
//
// Jaccard similarity between two students' preference sets.
//
// A preference is the pair (preference_key, preference_value).
// Both fields must match for it to count as shared — having
// smoking=smoker vs smoking=non_smoker is a mismatch, not a partial hit.
//
// Score formula:
//   jaccard = |A ∩ B| / |A ∪ B|
//   where |A ∪ B| = |A| + |B| - |A ∩ B|
//
// Returned as an integer 0–100.
// Returns 0 when either user has no preferences (union = 0) — the caller
// should set compatibilityAvailable = false in that case.

import { pool } from "../client.js";

// scoreUsersForUser
//
// requestingUserId: UUID of the student whose feed is being built.
// candidateIds:     Array of UUIDs of the candidate students to score.
//                   Already filtered for opt-in, blocks, and city before this call.
//
// Returns: { [userId]: score 0–100 }
export const scoreUsersForUser = async (requestingUserId, candidateIds, client = pool) => {
	if (!candidateIds.length) return {};

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
	// We fetch the requesting user alongside the candidates in one query.
	const { rows: countRows } = await client.query(
		`SELECT user_id, COUNT(*)::int AS pref_count
     FROM user_preferences
     WHERE user_id = ANY($1::uuid[])
     GROUP BY user_id`,
		[[requestingUserId, ...candidateIds]],
	);

	const myCount = countRows.find((r) => r.user_id === requestingUserId)?.pref_count ?? 0;
	const countMap = Object.fromEntries(countRows.map((r) => [r.user_id, r.pref_count]));
	const sharedMap = Object.fromEntries(intersectRows.map((r) => [r.user_id, r.shared_count]));

	return candidateIds.reduce((acc, id) => {
		const shared = sharedMap[id] ?? 0;
		const theirCount = countMap[id] ?? 0;
		const union = myCount + theirCount - shared;
		// When union is 0 both users have no preferences — score 0, caller sets
		// compatibilityAvailable = false so the UI can hide the score badge.
		acc[id] = union === 0 ? 0 : Math.round((shared / union) * 100);
		return acc;
	}, {});
};

// hasPreferences
//
// Quick check: does the given user have at least one preference row?
// Used to set compatibilityAvailable on the requesting user's own side.
export const hasPreferences = async (userId, client = pool) => {
	const { rows } = await client.query(
		`SELECT EXISTS (SELECT 1 FROM user_preferences WHERE user_id = $1) AS has_prefs`,
		[userId],
	);
	return rows[0].has_prefs === true;
};
