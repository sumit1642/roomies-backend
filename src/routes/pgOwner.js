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

// Contact reveal is POST rather than GET for two reasons:
//   1. GET requests can be prefetched by browsers and cached by intermediaries,
//      risking PII leakage via caches or browser history even before the user
//      intends to reveal the contact.
//   2. POST semantics correctly model the intent: the caller is performing an
//      action (consuming a quota slot and disclosing PII) rather than merely
//      reading a resource.
//
// Cache-Control: no-store is set inline here so the response is never stored by
// the browser or any intermediate proxy, regardless of what the client or CDN
// defaults to.
//
// validate runs before contactRevealGate so that malformed UUIDs in the path
// are rejected before the gate increments the caller's reveal quota.
pgOwnerRouter.post(
	"/:userId/contact/reveal",
	optionalAuthenticate,
	validate(getPgOwnerParamsSchema),
	contactRevealGate,
	(req, res, next) => {
		// Prevent any caching of the PII response by browsers, CDNs, or proxies.
		res.setHeader("Cache-Control", "no-store");
		next();
	},
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
