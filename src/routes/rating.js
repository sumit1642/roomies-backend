// src/routes/rating.js
//
// Mounted at /api/v1/ratings.
//
// ─── ROUTE REGISTRATION ORDER ────────────────────────────────────────────────
// Express matches routes in registration order. Static path segments must be
// registered BEFORE parameterised segments that share the same URL prefix, or
// the parameterised route shadows them.
//
// Concretely:
//   GET /me/given              — static segment "me" — registered FIRST
//   GET /user/:userId          — parameterised — registered SECOND
//   GET /connection/:connectionId — parameterised — registered THIRD
//   POST /                     — root — registered LAST
//
// If /user/:userId or /connection/:connectionId were registered before /me/given,
// a request to /ratings/me/given would match one of the param routes with
// userId or connectionId = "me", fail UUID validation, and return 400.
//
// ─── ROUTE SURFACE ───────────────────────────────────────────────────────────
//
//   GET  /ratings/me/given                  — authenticated — ratings I've submitted
//   GET  /ratings/user/:userId              — public — ratings a user has received
//   GET  /ratings/connection/:connectionId  — authenticated — both ratings for a connection
//   POST /ratings                           — authenticated — submit a rating
//
// There is intentionally no PUT or PATCH — ratings are immutable once submitted.
// The DB unique constraint on (reviewer_id, connection_id, reviewee_id) makes
// duplicate submissions return 409 via ON CONFLICT DO NOTHING + rowCount check.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
	submitRatingSchema,
	getRatingsForConnectionSchema,
	getPublicRatingsSchema,
	getMyGivenRatingsSchema,
} from "../validators/rating.validators.js";
import * as ratingController from "../controllers/rating.controller.js";

export const ratingRouter = Router();

// ─── Static routes first ──────────────────────────────────────────────────────

// GET /api/v1/ratings/me/given — the authenticated user's submission history.
// Authenticated only — no role restriction. Both students (rating PG owners and
// properties) and PG owners (rating students) use this endpoint to review what
// they've written.
ratingRouter.get("/me/given", authenticate, validate(getMyGivenRatingsSchema), ratingController.getMyGivenRatings);

// ─── Parameterised routes after all static routes ─────────────────────────────

// GET /api/v1/ratings/user/:userId — public rating history for any user.
// No authenticate middleware — this is a public profile read. Students
// browsing a PG owner's listings can see their reputation without logging in.
// (If a future product decision requires login to view ratings, add authenticate
// here — the service has no caller-identity dependency.)
ratingRouter.get("/user/:userId", validate(getPublicRatingsSchema), ratingController.getPublicRatings);

// GET /api/v1/ratings/connection/:connectionId — both ratings for one connection.
// Only the two connection parties can call this. Returns { myRating, theirRating }
// resolved relative to the authenticated caller. Third parties get 404 (enforced
// in service via WHERE clause — existence not revealed to unauthorised callers).
ratingRouter.get(
	"/connection/:connectionId",
	authenticate,
	validate(getRatingsForConnectionSchema),
	ratingController.getRatingsForConnection,
);

// POST /api/v1/ratings — submit a rating.
// Authenticated — the reviewer identity comes from req.user.userId, never from
// the request body (the body carries connectionId, revieweeType, revieweeId, scores).
// No role restriction at the route level — both students and PG owners submit
// ratings. The service enforces that the caller is a party to the referenced
// connection and that confirmation_status = 'confirmed'.
ratingRouter.post("/", authenticate, validate(submitRatingSchema), ratingController.submitRating);
