// src/controllers/adminListing.controller.js
//
// ADR-016 Phase 4. Follows the same thin-controller shape as
// adminUser.controller.js / adminAmenity.controller.js — no logic here,
// just service call + envelope.

import * as adminListingService from "../services/adminListing.service.js";
import { adminMutationEnvelope } from "../utils/adminResponse.js";

export const forceListingStatus = async (req, res, next) => {
	try {
		const result = await adminListingService.forceListingStatus(req.user.userId, req.params.listingId, req.body);
		res.json(
			adminMutationEnvelope(result, {
				actorId: req.user.userId,
				action: "listing.forceStatus",
			}),
		);
	} catch (err) {
		next(err);
	}
};
