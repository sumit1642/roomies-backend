// src/services/pincode.service.js
//
// Public reference-data lookup for the web pincode-search confirmation chip
// (PRD: Proximity Search v2, §6.1). Read-only against the `pincodes` table
// populated by src/db/seeds/pincodes.js — no writes happen through this
// service; the table is reference data seeded out-of-band.

import { pool } from "../db/client.js";
import { AppError } from "../middleware/errorHandler.js";

export const getPincode = async (pincode) => {
	const { rows } = await pool.query(
		`SELECT pincode, city, district, state, latitude, longitude
     FROM pincodes
     WHERE pincode = $1`,
		[pincode],
	);

	if (!rows.length) {
		// Deliberately a single generic 404 for both "never existed in the
		// source data" and "existed but had zero recoverable coordinates and
		// was excluded at seed time" (PRD §5.2 step 4, §6.1) — from the
		// caller's perspective both cases are equally "we can't resolve this
		// pincode", and distinguishing them would leak seed-time internals
		// that aren't actionable for the client.
		throw new AppError("We don't recognize that pincode", 404);
	}

	return rows[0];
};
