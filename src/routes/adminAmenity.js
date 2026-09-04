// src/routes/adminAmenity.js
//
// Admin-only amenity management, mounted at /admin/amenities in routes/index.js.
// Every route here is gated by requireAdmin (email-verified AND role === 'admin').
// Read access to amenities remains public via GET /amenities (amenities.js) —
// this router only adds the write path that previously only existed through
// seeds/amenities.js (a one-time ETL script) or direct SQL.
//
// Mirrors institution.js's route structure exactly. No GET/list route here —
// GET /amenities (public, unauthenticated) already serves that purpose and
// there's no admin-only filtering need (unlike institutions' includeDeactivated
// flag) since amenities have no soft-delete state to filter on.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validate } from "../middleware/validate.js";
import { createAmenitySchema, updateAmenitySchema, amenityParamsSchema } from "../validators/amenities.validators.js";
import * as adminAmenityController from "../controllers/adminAmenity.controller.js";

export const adminAmenityRouter = Router();

adminAmenityRouter.post(
	"/",
	authenticate,
	...requireAdmin,
	validate(createAmenitySchema),
	adminAmenityController.createAmenity,
);

adminAmenityRouter.patch(
	"/:amenityId",
	authenticate,
	...requireAdmin,
	validate(updateAmenitySchema),
	adminAmenityController.updateAmenity,
);

adminAmenityRouter.delete(
	"/:amenityId",
	authenticate,
	...requireAdmin,
	validate(amenityParamsSchema),
	adminAmenityController.deleteAmenity,
);
