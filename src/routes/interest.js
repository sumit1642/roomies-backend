// src/routes/interest.js
//
// Top-level interest router, mounted at /api/v1/interests.
//
// This router handles endpoints scoped to the interest request itself rather
// than to a parent listing:
//
//   GET  /interests/me                     — student's own interest dashboard
//   GET  /interests/:interestId            — single interest request detail
//   PATCH /interests/:interestId/status    — trigger a state machine transition
//
// The listing-scoped routes (POST + GET on a specific listing's interests)
// live in src/routes/listing.js as child resource routes under /:listingId.
// Splitting them this way avoids forcing the student dashboard through the
// listing router where listingId is a required path segment.
//
// ─── ROUTE ORDER NOTE ────────────────────────────────────────────────────────
// Express matches routes in registration order. Static segments must come before
// parameterised segments that share the same URL prefix. Concretely:
//
//   GET /me                        — registered FIRST (static segment)
//   GET /:interestId               — registered SECOND (param segment)
//   PATCH /:interestId/status      — registered THIRD  (param + static child)
//
// If /:interestId were registered before /me, a GET /me request would match the
// param route with interestId = "me", which would then fail UUID validation and
// return a 400 instead of hitting the dashboard handler. Correct order prevents
// this entirely.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
	interestParamsSchema,
	updateInterestStatusSchema,
	getMyInterestsSchema,
} from "../validators/interest.validators.js";
import * as interestController from "../controllers/interest.controller.js";

export const interestRouter = Router();

// ─── Static routes first ──────────────────────────────────────────────────────

// GET /api/v1/interests/me — student's own interest request dashboard.
// Students only: a PG owner does not send interest requests, they receive them.
// If a PG owner also holds a student role, they access this as their student persona.
interestRouter.get(
	"/me",
	authenticate,
	authorize("student"),
	validate(getMyInterestsSchema),
	interestController.getMyInterestRequests,
);

// ─── Parameterised routes after all static routes ─────────────────────────────

// GET /api/v1/interests/:interestId — single interest request detail.
// No role restriction at the route level — both the student who sent the request
// and the poster who received it need this endpoint. The service enforces that
// the caller is one of the two parties, returning 404 for any third party
// (existence is not confirmed to unauthorised callers).
interestRouter.get("/:interestId", authenticate, validate(interestParamsSchema), interestController.getInterestRequest);

// PATCH /api/v1/interests/:interestId/status — trigger a state machine transition.
// No role restriction at the route level — both students (withdraw) and posters
// (accept/decline) use this endpoint. The service determines the actor's role
// by comparing the caller's userId against sender_id and poster_id on the row,
// then validates the transition against the ALLOWED_TRANSITIONS table.
// A caller who is neither party gets a 404 — existence not confirmed.
interestRouter.patch(
	"/:interestId/status",
	authenticate,
	validate(updateInterestStatusSchema),
	interestController.updateInterestStatus,
);
