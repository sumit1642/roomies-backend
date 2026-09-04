// src/routes/adminListing.js
//
// ADR-016 Phase 4. Mounted at /admin/listings in routes/index.js.
// Single moderation-override endpoint — gated by requireAdmin, matching
// every other admin route file's structure exactly.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validate } from "../middleware/validate.js";
import { forceListingStatusSchema } from "../validators/adminListing.validators.js";
import * as adminListingController from "../controllers/adminListing.controller.js";

export const adminListingRouter = Router();

adminListingRouter.patch(
	"/:listingId/status",
	authenticate,
	...requireAdmin,
	validate(forceListingStatusSchema),
	adminListingController.forceListingStatus,
);
