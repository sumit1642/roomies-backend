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

// ─── Cache-Control: no-store ordering ────────────────────────────────────────
//
// The no-store header must be set BEFORE contactRevealGate runs, not after.
// If the header middleware runs after the gate, any 429 (CONTACT_REVEAL_LIMIT_REACHED)
// short-circuit response produced by the gate would be sent WITHOUT the header,
// potentially allowing the browser or an intermediate proxy to cache a response
// that carries a loginRedirect URL — a PII-adjacent value that must not be cached.
//
// Ordering rationale for the full chain:
//   1. optionalAuthenticate  — resolves req.user if a valid token is present
//   2. validate              — rejects malformed UUIDs before the gate can
//                              increment the anonymous quota counter (a loop of
//                              invalid-UUID requests must not burn quota)
//   3. no-store header       — set HERE, before the gate, so every response from
//                              this route (200, 404, 429, 500) carries the header
//   4. contactRevealGate     — enforces quota; may short-circuit with 429
//   5. studentController.revealContact — fetches and returns the contact bundle
studentRouter.get(
	"/:userId/contact/reveal",
	optionalAuthenticate,
	validate(getStudentParamsSchema),
	// Set Cache-Control before the gate so even the gate's 429 short-circuit
	// carries no-store. This mirrors the same protection on the PG owner reveal
	// route, which also sets no-store before its gate middleware.
	(req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		next();
	},
	contactRevealGate,
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
