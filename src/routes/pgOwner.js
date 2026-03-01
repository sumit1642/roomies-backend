// src/routes/pgOwner.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { getPgOwnerParamsSchema, updatePgOwnerSchema } from "../validators/pgOwner.validators.js";
import { submitDocumentSchema } from "../validators/verification.validators.js";
import * as pgOwnerController from "../controllers/pgOwner.controller.js";
import * as verificationController from "../controllers/verification.controller.js";

export const pgOwnerRouter = Router();

// GET is intentionally readable by any authenticated user — students need to
// view PG owner profiles to evaluate listings and credibility. The ownership
// restriction only applies to PUT (enforced in the service layer).
pgOwnerRouter.get("/:userId/profile", authenticate, validate(getPgOwnerParamsSchema), pgOwnerController.getProfile);
pgOwnerRouter.put("/:userId/profile", authenticate, validate(updatePgOwnerSchema), pgOwnerController.updateProfile);

// Document submission for PG owner verification.
// Ownership is enforced in the service layer — the authenticated user must match
// the :userId param. The service also guards that a pg_owner_profiles row exists,
// which the route layer cannot see from JWT claims alone.
pgOwnerRouter.post(
	"/:userId/documents",
	authenticate,
	validate(submitDocumentSchema),
	verificationController.submitDocument,
);
