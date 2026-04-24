




import { Router } from "express";
import { pool } from "../db/client.js";

export const amenitiesRouter = Router();




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
