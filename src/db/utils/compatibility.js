// src/db/utils/compatibility.js
//


import { pool } from "../client.js";


export const scoreListingsForUser = async (userId, listingIds, client = pool) => {
	if (!listingIds.length) return {};
 
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
 
	return rows.reduce((acc, row) => {
		acc[row.listing_id] = row.match_count;
		return acc;
	}, {});
};
