// src/controllers/listingRenewal.controller.js

import { renewListing } from "../services/listingRenewal.service.js";

export const renewListingHandler = async (req, res, next) => {
	try {
		const result = await renewListing(req.user.userId, req.params.listingId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
