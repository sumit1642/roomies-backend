// src/routes/amenities.js
// Public read-only endpoint to list all amenities.
// Used by the frontend AmenityPicker component when creating/editing properties and listings.
// No auth required — amenity catalog is not sensitive.

import { Router } from "express";
import { pool } from "../db/client.js";

export const amenitiesRouter = Router();

// GET /api/v1/amenities
// Returns all amenities grouped by category, ordered by category then name.
// Response: { status: "success", data: { items: Amenity[] } }
amenitiesRouter.get("/", async (req, res, next) => {
	try {
		const { rows } = await pool.query(
			`SELECT
         amenity_id   AS "amenityId",
         name,
         category,
         icon_name    AS "iconName"
       FROM amenities
       ORDER BY category, name`,
		);
		res.json({ status: "success", data: { items: rows } });
	} catch (err) {
		next(err);
	}
});
