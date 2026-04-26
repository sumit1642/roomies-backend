// src/services/rentIndex.service.js
//
// Public query interface for the rent_index table.
//
// getRentIndex: fetches the precomputed percentiles for a given
//   city + optional locality + room_type combination.
//   Falls back to city-wide data (locality IS NULL) when no
//   locality-specific row exists, matching the same fallback logic
//   used when enriching listing responses.

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";

// Converts paise to rupees for the JSON response.
const paiseToRupees = (paise) => (paise != null ? Math.round(paise / 100) : null);

export const getRentIndex = async ({ city, locality, roomType }) => {
	// Try locality-specific row first, then city-wide fallback.
	// Both lookups in one query using COALESCE across two LEFT JOINs.
	const normLocality = locality ? locality.toLowerCase().trim() : null;

	const { rows } = await pool.query(
		`SELECT
       COALESCE(ri_loc.p25,    ri_city.p25)         AS p25,
       COALESCE(ri_loc.p50,    ri_city.p50)         AS p50,
       COALESCE(ri_loc.p75,    ri_city.p75)         AS p75,
       COALESCE(ri_loc.sample_count, ri_city.sample_count) AS sample_count,
       COALESCE(ri_loc.computed_at,  ri_city.computed_at)  AS computed_at,
       CASE WHEN ri_loc.rent_index_id IS NOT NULL THEN 'locality' ELSE 'city' END AS resolution
     FROM (SELECT 1) AS _dual
     LEFT JOIN rent_index ri_loc
       ON ri_loc.city      = $1
      AND ri_loc.locality  = $2
      AND ri_loc.room_type = $3::room_type_enum
     LEFT JOIN rent_index ri_city
       ON ri_city.city      = $1
      AND ri_city.locality  IS NULL
      AND ri_city.room_type = $3::room_type_enum`,
		[city, normLocality, roomType],
	);

	const row = rows[0];

	if (!row || row.p50 == null) {
		// No data for this combination yet — 404 is the right response so the
		// caller knows not to display a deviation badge.
		throw new AppError("No rent index data available for this city / room type combination yet", 404);
	}

	return {
		city,
		locality: locality ?? null,
		roomType,
		resolution: row.resolution, // 'locality' | 'city'
		p25: paiseToRupees(row.p25),
		p50: paiseToRupees(row.p50),
		p75: paiseToRupees(row.p75),
		sampleCount: row.sample_count,
		computedAt: row.computed_at,
	};
};
