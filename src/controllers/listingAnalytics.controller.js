// src/controllers/listingAnalytics.controller.js

import { getListingAnalytics } from "../services/listingAnalytics.service.js";

export const getListingAnalyticsHandler = async (req, res, next) => {
	try {
		const result = await getListingAnalytics(req.user.userId, req.params.listingId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
