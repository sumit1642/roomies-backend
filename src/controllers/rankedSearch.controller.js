// src/controllers/rankedSearch.controller.js

import { rankedSearch, persistPreferenceOverrides } from "../services/rankedSearch.service.js";

// GET /api/v1/listings/search/ranked
//
// Thin controller. All business logic (preference resolution, weight selection,
// SQL construction) lives in rankedSearch.service.js. The controller's only
// extra responsibility is the optional preference persistence side-effect, which
// is deliberately decoupled from the search itself (fire-and-forget after the
// search runs, never blocking the response).
export const getRankedListings = async (req, res, next) => {
	try {
		const { preferenceOverrides, persistPreferences, ...searchFilters } = req.query;

		const result = await rankedSearch(req.user.userId, {
			...searchFilters,
			preferenceOverrides: preferenceOverrides ?? [],
		});

		// Persist overrides if the caller opted in — runs after the response is
		// assembled so it never delays the search. Any failure is logged by the
		// service and does not affect the search result.
		if (persistPreferences && (preferenceOverrides ?? []).length > 0) {
			persistPreferenceOverrides(req.user.userId, preferenceOverrides).catch(() => {
				// Already logged inside the service; swallow here to avoid crashing
			});
		}

		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
