// src/controllers/adminRating.controller.js

import * as adminRatingService from "../services/adminRating.service.js";

// GET /api/v1/admin/ratings
// Paginated rating feed with optional filters. The validate() middleware has
// already coerced and validated req.query before this runs.
export const listRatings = async (req, res, next) => {
	try {
		const result = await adminRatingService.listRatings(req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// PATCH /api/v1/admin/ratings/:ratingId/visibility
// Direct visibility toggle. adminId comes from the authenticated admin's JWT
// payload (req.user.userId), set by the authenticate middleware.
export const updateRatingVisibility = async (req, res, next) => {
	try {
		const result = await adminRatingService.updateRatingVisibility(req.user.userId, req.params.ratingId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
