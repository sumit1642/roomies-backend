// src/routes/listing.js
//
// ─── ROUTE REGISTRATION ORDER NOTE ───────────────────────────────────────────
// Express matches routes in registration order. Static path segments must be
// registered BEFORE parameterised segments that share the same prefix, or the
// parameterised route will shadow them.
//
// Concrete example in this file:
//   GET /me/saved   — static segment "me"
//   GET /:listingId — parameterised segment
//
// If /:listingId were registered first, a request to /me/saved would match it
// with listingId = "me", which would then fail UUID validation and return a 400
// instead of hitting the saved listings handler. By registering /me/saved first,
// Express short-circuits correctly.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
	listingParamsSchema,
	searchListingsSchema,
	createListingSchema,
	updateListingSchema,
	updatePreferencesSchema,
	saveListingSchema,
	savedListingsSchema,
} from "../validators/listing.validators.js";
import * as listingController from "../controllers/listing.controller.js";

export const listingRouter = Router();

// ─── Static routes first — must precede /:listingId ──────────────────────────

// GET /api/v1/listings/me/saved — student's saved listings feed.
// Students only: saving a listing is a student-specific action (a PG owner
// does not bookmark their own listings for later consideration).
listingRouter.get(
	"/me/saved",
	authenticate,
	authorize("student"),
	validate(savedListingsSchema),
	listingController.getSavedListings,
);

// GET /api/v1/listings — search / browse all active listings.
// Any authenticated user can search — students find PG rooms, PG owners may
// browse the market to understand pricing. No role restriction at the route
// level. The service filters appropriately (expired listings excluded, etc.).
listingRouter.get("/", authenticate, validate(searchListingsSchema), listingController.searchListings);

// POST /api/v1/listings — create a listing.
// No authorize() here — both students (student_room) and PG owners (pg_room,
// hostel_bed) create listings. The service layer enforces which listing_type
// each role is allowed to create, including the PG owner verification check.
listingRouter.post("/", authenticate, validate(createListingSchema), listingController.createListing);

// ─── Parameterised routes — after all static routes ──────────────────────────

// GET /api/v1/listings/:listingId — public listing detail.
// Any authenticated user can read any listing detail. Students need this to
// evaluate a listing before expressing interest. No role restriction.
listingRouter.get("/:listingId", authenticate, validate(listingParamsSchema), listingController.getListing);

listingRouter.put("/:listingId", authenticate, validate(updateListingSchema), listingController.updateListing);

listingRouter.delete("/:listingId", authenticate, validate(listingParamsSchema), listingController.deleteListing);

// ─── Child resource routes ────────────────────────────────────────────────────

// GET /api/v1/listings/:listingId/preferences — world-readable (any authenticated user).
// Preferences are part of the public listing profile — students need them to
// understand what kind of roommate the poster is looking for.
listingRouter.get(
	"/:listingId/preferences",
	authenticate,
	validate(listingParamsSchema),
	listingController.getListingPreferences,
);

// PUT /api/v1/listings/:listingId/preferences — poster only (enforced in service).
listingRouter.put(
	"/:listingId/preferences",
	authenticate,
	validate(updatePreferencesSchema),
	listingController.updateListingPreferences,
);

// POST /api/v1/listings/:listingId/save — student only.
listingRouter.post(
	"/:listingId/save",
	authenticate,
	authorize("student"),
	validate(saveListingSchema),
	listingController.saveListing,
);

// DELETE /api/v1/listings/:listingId/save — student only.
listingRouter.delete(
	"/:listingId/save",
	authenticate,
	authorize("student"),
	validate(saveListingSchema),
	listingController.unsaveListing,
);
