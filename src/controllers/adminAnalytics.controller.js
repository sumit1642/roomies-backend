// src/controllers/adminAnalytics.controller.js

import * as adminAnalyticsService from "../services/adminAnalytics.service.js";

// GET /api/v1/admin/analytics/platform
// Returns a single dashboard snapshot. Auth and admin-role enforcement happen
// at the router level — this controller only orchestrates the service call
// and shapes the HTTP response.
export const getPlatformAnalytics = async (req, res, next) => {
	try {
		const data = await adminAnalyticsService.getPlatformAnalytics();
		res.json({ status: "success", data });
	} catch (err) {
		next(err);
	}
};
