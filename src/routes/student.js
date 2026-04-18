// src/routes/student.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { contactRevealGate } from "../middleware/contactRevealGate.js";
import { validate } from "../middleware/validate.js";
import {
	getStudentParamsSchema,
	updateStudentSchema,
	getStudentPreferencesSchema,
	updateStudentPreferencesSchema,
} from "../validators/student.validators.js";
import * as studentController from "../controllers/student.controller.js";

export const studentRouter = Router();

studentRouter.get("/:userId/profile", authenticate, validate(getStudentParamsSchema), studentController.getProfile);
studentRouter.put("/:userId/profile", authenticate, validate(updateStudentSchema), studentController.updateProfile);

// validate runs before contactRevealGate so that malformed UUIDs in the path
// are rejected before the gate increments the caller's reveal quota. Without
// this ordering, a loop of invalid-UUID requests would silently burn the
// anonymous quota ceiling without ever performing a real reveal.
//
// Cache-Control: no-store is set before the controller runs so the PII response
// is never stored by the browser, CDN, or any intermediate proxy. The PG owner
// reveal route (POST) avoids caching by virtue of being a POST. This GET route
// must explicitly opt out since GET responses are cacheable by default.
// Setting the header inline here (rather than in the controller) keeps the
// no-store guarantee in the route definition where it is visible alongside the
// other security middleware, making it harder to accidentally remove.
studentRouter.get(
	"/:userId/contact/reveal",
	optionalAuthenticate,
	validate(getStudentParamsSchema),
	contactRevealGate,
	(req, res, next) => {
		// Prevent any caching of the PII response by browsers, CDNs, or proxies.
		// This mirrors the same protection already applied to the PG owner reveal route.
		res.setHeader("Cache-Control", "no-store");
		next();
	},
	studentController.revealContact,
);

studentRouter.get(
	"/:userId/preferences",
	authenticate,
	validate(getStudentPreferencesSchema),
	studentController.getPreferences,
);

studentRouter.put(
	"/:userId/preferences",
	authenticate,
	validate(updateStudentPreferencesSchema),
	studentController.updatePreferences,
);
