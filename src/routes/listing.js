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
import { upload } from "../middleware/upload.js";
import {
	uploadPhotoSchema,
	deletePhotoSchema,
	reorderPhotosSchema,
	setCoverSchema,
} from "../validators/photo.validators.js";
import * as photoController from "../controllers/photo.controller.js";

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

// ─── Photo routes (child resource of /:listingId) ────────────────────────────
//
// Photo routes are registered here rather than in a separate router file because
// they are semantically a child resource of listings — a photo cannot exist
// without a parent listing. Keeping them in the listing router also means the
// listingId param is already parsed and available from the parent route context.
//
// All photo mutations require the poster to own the listing — ownership is
// verified inside the service via WHERE listing_id = $1 AND posted_by = $2.
// No separate authorize() middleware is needed beyond authenticate().

// GET /api/v1/listings/:listingId/photos — world-readable (any authenticated user)
listingRouter.get("/:listingId/photos", authenticate, validate(uploadPhotoSchema), photoController.getPhotos);

// POST /api/v1/listings/:listingId/photos — upload a new photo
// upload.single('photo') runs BEFORE validate() because Multer must parse the
// multipart body before Zod can read req.body or req.file. The order matters:
// if validate ran first on a multipart request, req.body would be empty (Express
// does not parse multipart bodies — only Multer does).
listingRouter.post(
	"/:listingId/photos",
	authenticate,
	upload.single("photo"),
	validate(uploadPhotoSchema),
	photoController.uploadPhoto,
);

// DELETE /api/v1/listings/:listingId/photos/:photoId — soft-delete a photo
listingRouter.delete(
	"/:listingId/photos/:photoId",
	authenticate,
	validate(deletePhotoSchema),
	photoController.deletePhoto,
);

// PATCH /api/v1/listings/:listingId/photos/:photoId/cover — set as cover
listingRouter.patch(
	"/:listingId/photos/:photoId/cover",
	authenticate,
	validate(setCoverSchema),
	photoController.setCoverPhoto,
);

// PUT /api/v1/listings/:listingId/photos/reorder — update display_order for all photos
listingRouter.put(
	"/:listingId/photos/reorder",
	authenticate,
	validate(reorderPhotosSchema),
	photoController.reorderPhotos,
);

// ─── Interest request routes (child resource of /:listingId) ─────────────────
//
// These two routes are listing-scoped: you create an interest *on a listing*,
// and a poster views interests *for their listing*. They live here rather than
// in the interest router because the listingId context is already present in
// the URL and the action is semantically "do something related to this listing."
//
// The student dashboard (GET /interests/me) and status transitions
// (PATCH /interests/:interestId/status) live in src/routes/interest.js because
// they are scoped to the interest request itself, not to a parent listing.

import { createInterestSchema, getListingInterestsSchema } from "../validators/interest.validators.js";
import * as interestController from "../controllers/interest.controller.js";

// POST /api/v1/listings/:listingId/interests — student expresses interest.
// Students only: a PG owner cannot send interest requests to their own or
// others' listings in their pg_owner capacity. The service additionally
// checks that the student is not the poster of this listing.
listingRouter.post(
	"/:listingId/interests",
	authenticate,
	authorize("student"),
	validate(createInterestSchema),
	interestController.createInterestRequest,
);

// GET /api/v1/listings/:listingId/interests — poster views all requests on their listing.
// No role restriction at the route level because a student who posted their own
// room is technically the "poster" — they have no pg_owner role but they are
// allowed to see interest in their listing. Ownership is enforced in the service
// via WHERE posted_by = $2 on the listings join.
listingRouter.get(
	"/:listingId/interests",
	authenticate,
	validate(getListingInterestsSchema),
	interestController.getListingInterests,
);
