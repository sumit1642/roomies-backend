// src/routes/interest.js
//
// Top-level interest router, mounted at /api/v1/interests.
//
// This router handles the two endpoints that are scoped to the interest request
// itself rather than to its parent listing:
//
//   GET  /interests/me            — student's own interest dashboard
//   PATCH /interests/:interestId/status — transition the state machine
//
// The listing-scoped routes (POST + GET on a specific listing's interests)
// live in src/routes/listing.js as child resource routes under /:listingId.
// Splitting them this way avoids forcing the student dashboard through the
// listing router where listingId is a required path segment.
//
// ─── ROUTE ORDER NOTE ────────────────────────────────────────────────────────
// GET /me must be registered before GET /:interestId (if that ever exists) for
// the same reason documented in listing.js — static segments before params.
// Currently /:interestId has no GET endpoint, but the order is established
// correctly from the start.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { updateInterestStatusSchema, getMyInterestsSchema } from "../validators/interest.validators.js";
import * as interestController from "../controllers/interest.controller.js";

export const interestRouter = Router();

// GET /api/v1/interests/me — student's own interest request dashboard.
// Students only: a PG owner does not send interest requests, they receive them.
// If a PG owner also has a student profile and has sent interests, they would
// access this as their student-role persona — the route guard enforces that
// the student role is present on the JWT.
interestRouter.get(
	"/me",
	authenticate,
	authorize("student"),
	validate(getMyInterestsSchema),
	interestController.getMyInterestRequests,
);

// PATCH /api/v1/interests/:interestId/status — trigger a state machine transition.
// No role restriction at the route level — both students (withdraw) and posters
// (accept/decline) use this endpoint. The service determines the actor's role
// by inspecting whether the caller is the requester or the listing owner, then
// validates the transition against the ALLOWED_TRANSITIONS table. A caller who
// is neither gets a 404 (existence not confirmed to unauthorised callers).
interestRouter.patch(
	"/:interestId/status",
	authenticate,
	validate(updateInterestStatusSchema),
	interestController.updateInterestStatus,
);
