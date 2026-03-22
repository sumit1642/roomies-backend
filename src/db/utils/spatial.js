// src/db/utils/spatial.js
//

import { pool } from "../client.js";

// within `radiusMeters` meters of the given (lat, lng) point.
//
// Returns an array of listing_id strings — NOT full listing rows. The caller
// (listing service search function) uses these IDs as an IN-clause filter on
// the main search query. Keeping this function ID-only avoids selecting the
// same listing columns twice and keeps query responsibilities cleanly separated.
//
// THE GEOGRAPHY CAST IS CRITICAL:
// ST_DWithin(geometry, geometry, distance) interprets `distance` in the native
// units of the coordinate system — for WGS84 (SRID 4326) that means DEGREES,
// not meters. A 3km radius expressed as 3000 degrees would cover the entire
// planet many times over.
//
// Casting both arguments to ::geography forces ST_DWithin to operate in meters
// on a spherical Earth model, which is accurate within ~0.5% anywhere on the
// globe. This is the correct approach for "find PGs near my college" where
// radii of 1km–10km are typical.
//
// ST_MakePoint takes (longitude, latitude) — X axis first, Y axis second.
// This is the opposite of the conventional (lat, lng) order used in the API
// and by humans. The parameter names in this function use (lat, lng) for the
// caller's convenience; the SQL reverses them correctly.
//
// The `client` parameter defaults to the shared pool so the function can
// participate in a transaction if needed (consistent with findUserById,
// findInstitutionByDomain, etc.), though in practice the search path never
// calls this inside a transaction.
export const findListingsNearPoint = async (lat, lng, radiusMeters, client = pool) => {
	const { rows } = await client.query(
		`SELECT l.listing_id
     FROM listings l
     LEFT JOIN properties p ON p.property_id = l.property_id
     WHERE ST_DWithin(
             COALESCE(l.location, p.location)::geography,
             ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
             $3
           )
       AND l.status     = 'active'
       AND l.deleted_at IS NULL`,
		[lat, lng, radiusMeters],
	);

	return rows.map((r) => r.listing_id);
};