// src/db/utils/compatibility.js
//
// Compatibility scoring between a user's lifestyle preferences and listing
// roommate preferences. This is the read-side of the EAV (Entity-Attribute-Value)
// design that spans user_preferences and listing_preferences.
//
// The score is NEVER stored in the database. It is computed fresh on every
// search request so that a user who updates their preferences immediately sees
// updated scores on their next search — no stale cache, no invalidation logic.
//
// How compatibility works:
// user_preferences rows say "this is what I am like" (e.g. food_habit = vegetarian)
// listing_preferences rows say "this is what I want in a roommate" (same keys/values)
// A match is a row where both preference_key AND preference_value are identical.
// The score is the COUNT of such matching pairs for a given (user, listing) combination.
//
// Example:
//   user prefs:    food_habit=vegetarian, smoking=non_smoker, sleep=night_owl
//   listing prefs: food_habit=vegetarian, smoking=non_smoker, pets=no_pets
//   score = 2 (food_habit and smoking match; sleep and pets don't cross-match)
//
// The score is a raw integer count, not a percentage. A listing with 5 out of 7
// preferences matched scores 5. The frontend decides how to display this — as a
// count, a fraction, a percentage, or a set of stars. Returning raw counts gives
// the frontend maximum flexibility without requiring knowledge of the total
// preference count per listing.

import { pool } from "../client.js";

// Computes compatibility scores for multiple listings in a single query.
//
// Takes an array of listing IDs and a user ID.
// Returns a plain object mapping listing_id → match_count:
//   { "uuid-a": 3, "uuid-b": 1, "uuid-c": 5 }
//
// Listings with zero matches are ABSENT from the returned object — the caller
// must default to 0 for any listing_id not present in the result (using ?? 0).
// This is intentional: the query uses a JOIN, so zero-match listings generate
// no rows rather than a row with count = 0. This is more efficient than a LEFT
// JOIN + COALESCE when the majority of listings may have at least one match.
//
// Empty listingIds array: returns an empty object immediately without touching
// the database. The ANY($1::uuid[]) clause with an empty array is technically
// valid SQL but wastes a round-trip.
//
// The `client` parameter follows the standard util pattern — defaults to pool,
// accepts a transaction client if the caller needs it inside a transaction.
export const scoreListingsForUser = async (userId, listingIds, client = pool) => {
	if (!listingIds.length) return {};

	// The JOIN condition uses BOTH preference_key AND preference_value.
	// Matching only on key (e.g. food_habit = food_habit) without checking
	// value (vegetarian = non_vegetarian) would produce false positives and
	// completely invalidate the compatibility signal.
	//
	// ANY($1::uuid[]) is preferred over IN (...) with a dynamically built
	// placeholder list because it sends the array as a single typed parameter
	// regardless of size. IN (...) would require rebuilding the SQL string for
	// each different array length, which is both fragile and potentially
	// incompatible with some pg driver versions for large arrays.
	const { rows } = await client.query(
		`SELECT
       lp.listing_id,
       COUNT(*)::int AS match_count
     FROM listing_preferences lp
     JOIN user_preferences up
       ON up.preference_key   = lp.preference_key
      AND up.preference_value = lp.preference_value
     WHERE lp.listing_id = ANY($1::uuid[])
       AND up.user_id    = $2
     GROUP BY lp.listing_id`,
		[listingIds, userId],
	);

	// Convert the rows array into a lookup object for O(1) access per listing.
	// The spread into reduce is safe here — listingIds is bounded by the search
	// LIMIT (max 100) so the result set is always small.
	return rows.reduce((acc, row) => {
		acc[row.listing_id] = row.match_count;
		return acc;
	}, {});
};
