// src/routes/pgOwner.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { contactRevealGate } from "../middleware/contactRevealGate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { getPgOwnerParamsSchema, updatePgOwnerSchema } from "../validators/pgOwner.validators.js";
import { submitDocumentSchema } from "../validators/verification.validators.js";
import * as pgOwnerController from "../controllers/pgOwner.controller.js";
import * as verificationController from "../controllers/verification.controller.js";

export const pgOwnerRouter = Router();

pgOwnerRouter.get("/:userId/profile", authenticate, validate(getPgOwnerParamsSchema), pgOwnerController.getProfile);

// validate runs before contactRevealGate so that malformed UUIDs in the path
// are rejected before the gate increments the caller's reveal quota. Without
// this ordering, a loop of invalid-UUID requests would silently burn the
// anonymous quota ceiling without ever performing a real reveal.
pgOwnerRouter.get(
	"/:userId/contact/reveal",
	optionalAuthenticate,
	validate(getPgOwnerParamsSchema),
	contactRevealGate,
	pgOwnerController.revealContact,
);

pgOwnerRouter.put(
	"/:userId/profile",
	authenticate,
	authorize("pg_owner"),
	validate(updatePgOwnerSchema),
	pgOwnerController.updateProfile,
);

pgOwnerRouter.post(
	"/:userId/documents",
	authenticate,
	authorize("pg_owner"),
	validate(submitDocumentSchema),
	verificationController.submitDocument,
);
