// src/routes/institution.js
//
// Admin-only institution management, mounted at /admin/institutions in
// routes/index.js. Every route here is gated by requireAdmin (email-verified
// AND role === 'admin') — there is no public or student-facing institution
// endpoint; institutions are only ever read internally via
// db/utils/institutions.js's findInstitutionByDomain() during registration.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validate } from "../middleware/validate.js";
import {
	institutionParamsSchema,
	listInstitutionsSchema,
	createInstitutionSchema,
	updateInstitutionSchema,
} from "../validators/institution.validators.js";
import * as institutionController from "../controllers/institution.controller.js";

export const institutionRouter = Router();

institutionRouter.get(
	"/",
	authenticate,
	...requireAdmin,
	validate(listInstitutionsSchema),
	institutionController.listInstitutions,
);

institutionRouter.post(
	"/",
	authenticate,
	...requireAdmin,
	validate(createInstitutionSchema),
	institutionController.createInstitution,
);

institutionRouter.get(
	"/:institutionId",
	authenticate,
	...requireAdmin,
	validate(institutionParamsSchema),
	institutionController.getInstitution,
);

institutionRouter.put(
	"/:institutionId",
	authenticate,
	...requireAdmin,
	validate(updateInstitutionSchema),
	institutionController.updateInstitution,
);

institutionRouter.patch(
	"/:institutionId/deactivate",
	authenticate,
	...requireAdmin,
	validate(institutionParamsSchema),
	institutionController.deactivateInstitution,
);

institutionRouter.patch(
	"/:institutionId/reactivate",
	authenticate,
	...requireAdmin,
	validate(institutionParamsSchema),
	institutionController.reactivateInstitution,
);
