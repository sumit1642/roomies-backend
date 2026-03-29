// src/routes/rating.js
//
// Mounted at /api/v1/ratings.
//
// ─── ROUTE REGISTRATION ORDER ────────────────────────────────────────────────
// Static segments (me/given) must come before parameterised segments.
// See original file header for detailed rationale.
//
// ─── ROUTE SURFACE ───────────────────────────────────────────────────────────
//
//   GET  /ratings/me/given                  — authenticated
//   GET  /ratings/user/:userId              — public
//   GET  /ratings/property/:propertyId      — public
//   GET  /ratings/connection/:connectionId  — authenticated
//   POST /ratings                           — authenticated
//   POST /ratings/:ratingId/report          — authenticated (Phase 4)

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
	submitRatingSchema,
	getRatingsForConnectionSchema,
	getPublicRatingsSchema,
	getMyGivenRatingsSchema,
	getPublicPropertyRatingsSchema,
} from "../validators/rating.validators.js";
import { submitReportSchema } from "../validators/report.validators.js";
import * as ratingController from "../controllers/rating.controller.js";
import * as reportController from "../controllers/report.controller.js";

export const ratingRouter = Router();

// ─── Static routes first ──────────────────────────────────────────────────────

ratingRouter.get("/me/given", authenticate, validate(getMyGivenRatingsSchema), ratingController.getMyGivenRatings);

// ─── Parameterised routes after all static routes ─────────────────────────────

// Public — no authenticate middleware
ratingRouter.get("/user/:userId", validate(getPublicRatingsSchema), ratingController.getPublicRatings);

ratingRouter.get(
	"/property/:propertyId",
	validate(getPublicPropertyRatingsSchema),
	ratingController.getPublicPropertyRatings,
);

ratingRouter.get(
	"/connection/:connectionId",
	authenticate,
	validate(getRatingsForConnectionSchema),
	ratingController.getRatingsForConnection,
);

ratingRouter.post("/", authenticate, validate(submitRatingSchema), ratingController.submitRating);

// ─── Phase 4: Report a rating ─────────────────────────────────────────────────
//
// POST /api/v1/ratings/:ratingId/report
// Any authenticated user who is a party to the connection the rating references
// can file a report. The service enforces the party-membership check and rejects
// the reporter with a 404 if they are not a party (existence not leaked).
//
// A partial unique index on (reporter_id, rating_id) WHERE status = 'open'
// prevents duplicate open reports from the same person on the same rating.
// A resolved report does not block re-reporting (partial index covers only open
// rows), which allows the admin to re-open a second review cycle if needed.
ratingRouter.post("/:ratingId/report", authenticate, validate(submitReportSchema), reportController.submitReport);
