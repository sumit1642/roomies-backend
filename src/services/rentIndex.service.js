// src/services/rentIndex.service.js

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";

const paiseToRupees = (paise) => (paise != null ? Math.round(paise / 100) : null);

export const getRentIndex = async ({ city, locality, roomType }) => {
	// Normalize: trim + lowercase, then treat empty string as null.
	// This ensures "   " → null, consistent with DB trigger behaviour.
	const normCity = city?.trim().toLowerCase() || null;
	const normLocality = locality?.trim().toLowerCase() || null;

	const { rows } = await pool.query(
		`SELECT
       COALESCE(ri_loc.p25,          ri_city.p25)          AS p25,
       COALESCE(ri_loc.p50,          ri_city.p50)          AS p50,
       COALESCE(ri_loc.p75,          ri_city.p75)          AS p75,
       COALESCE(ri_loc.sample_count, ri_city.sample_count) AS sample_count,
       COALESCE(ri_loc.computed_at,  ri_city.computed_at)  AS computed_at,
       CASE
         WHEN ri_loc.rent_index_id  IS NOT NULL THEN 'locality'
         WHEN ri_city.rent_index_id IS NOT NULL THEN 'city'
         ELSE NULL
       END AS resolution
     FROM (SELECT 1) AS _dual
     LEFT JOIN rent_index ri_loc
       ON ri_loc.city      = $1
      AND ri_loc.locality  = $2
      AND ri_loc.room_type = $3::room_type_enum
     LEFT JOIN rent_index ri_city
       ON ri_city.city      = $1
      AND ri_city.locality  IS NULL
      AND ri_city.room_type = $3::room_type_enum`,
		[normCity, normLocality, roomType],
	);

	const row = rows[0];

	if (row.p50 == null) {
		throw new AppError("No rent index data available for this city / room type combination yet", 404);
	}

	return {
		city: normCity,
		locality: normLocality,
		roomType,
		resolution: row.resolution,
		p25: paiseToRupees(row.p25),
		p50: paiseToRupees(row.p50),
		p75: paiseToRupees(row.p75),
		sampleCount: row.sample_count,
		computedAt: row.computed_at,
	};
};
