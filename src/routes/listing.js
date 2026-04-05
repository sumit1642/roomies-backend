// src/routes/listing.js
//
// ─── ROUTE REGISTRATION ORDER NOTE ───────────────────────────────────────────
// Static path segments must be registered BEFORE parameterised segments that
// share the same prefix, or the parameterised route will shadow them.
// /me/saved and / (search) are registered first; /:listingId comes after.
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
	updateListingStatusSchema,
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
import { UPLOAD_FIELD_NAME } from "../config/constants.js";

export const listingRouter = Router();

// ─── Static routes first — must precede /:listingId ──────────────────────────

listingRouter.get(
	"/me/saved",
	authenticate,
	authorize("student"),
	validate(savedListingsSchema),
	listingController.getSavedListings,
);

listingRouter.get("/", authenticate, validate(searchListingsSchema), listingController.searchListings);

listingRouter.post("/", authenticate, validate(createListingSchema), listingController.createListing);

// ─── Parameterised routes — after all static routes ──────────────────────────

listingRouter.get("/:listingId", authenticate, validate(listingParamsSchema), listingController.getListing);

listingRouter.put("/:listingId", authenticate, validate(updateListingSchema), listingController.updateListing);

listingRouter.delete("/:listingId", authenticate, validate(listingParamsSchema), listingController.deleteListing);

// PATCH /:listingId/status — poster-initiated lifecycle transitions.
// Both students (their student_room listings) and PG owners (their pg_room /
// hostel_bed listings) use this endpoint. No role restriction at the route level
// because both role types can be listing posters. The service enforces ownership
// via WHERE posted_by = $2 and validates the state machine transition.
listingRouter.patch(
	"/:listingId/status",
	authenticate,
	validate(updateListingStatusSchema),
	listingController.updateListingStatus,
);

// ─── Child resource routes ────────────────────────────────────────────────────

listingRouter.get(
	"/:listingId/preferences",
	authenticate,
	validate(listingParamsSchema),
	listingController.getListingPreferences,
);

listingRouter.put(
	"/:listingId/preferences",
	authenticate,
	validate(updatePreferencesSchema),
	listingController.updateListingPreferences,
);

listingRouter.post(
	"/:listingId/save",
	authenticate,
	authorize("student"),
	validate(saveListingSchema),
	listingController.saveListing,
);

listingRouter.delete(
	"/:listingId/save",
	authenticate,
	authorize("student"),
	validate(saveListingSchema),
	listingController.unsaveListing,
);

// ─── Photo routes (child resource of /:listingId) ────────────────────────────

listingRouter.get("/:listingId/photos", authenticate, validate(uploadPhotoSchema), photoController.getPhotos);

listingRouter.post(
	"/:listingId/photos",
	authenticate,
	upload.single(UPLOAD_FIELD_NAME),
	validate(uploadPhotoSchema),
	photoController.uploadPhoto,
);

listingRouter.delete(
	"/:listingId/photos/:photoId",
	authenticate,
	validate(deletePhotoSchema),
	photoController.deletePhoto,
);

listingRouter.patch(
	"/:listingId/photos/:photoId/cover",
	authenticate,
	validate(setCoverSchema),
	photoController.setCoverPhoto,
);

listingRouter.put(
	"/:listingId/photos/reorder",
	authenticate,
	validate(reorderPhotosSchema),
	photoController.reorderPhotos,
);

// ─── Interest request routes (child resource of /:listingId) ─────────────────

import { createInterestSchema, getListingInterestsSchema } from "../validators/interest.validators.js";
import * as interestController from "../controllers/interest.controller.js";

listingRouter.post(
	"/:listingId/interests",
	authenticate,
	authorize("student"),
	validate(createInterestSchema),
	interestController.createInterestRequest,
);

listingRouter.get(
	"/:listingId/interests",
	authenticate,
	validate(getListingInterestsSchema),
	interestController.getListingInterests,
);
