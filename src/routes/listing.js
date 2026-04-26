



















import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { guestListingGate } from "../middleware/guestListingGate.js";
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




listingRouter.get(
	"/me/saved",
	authenticate,
	authorize("student"),
	validate(savedListingsSchema),
	listingController.getSavedListings,
);





listingRouter.get(
	"/",
	optionalAuthenticate,
	validate(searchListingsSchema),
	guestListingGate,
	listingController.searchListings,
);


listingRouter.post("/", authenticate, validate(createListingSchema), listingController.createListing);




listingRouter.get(
	"/:listingId",
	optionalAuthenticate,
	validate(listingParamsSchema),
	guestListingGate,
	listingController.getListing,
);


listingRouter.put("/:listingId", authenticate, validate(updateListingSchema), listingController.updateListing);

listingRouter.delete("/:listingId", authenticate, validate(listingParamsSchema), listingController.deleteListing);

listingRouter.patch(
	"/:listingId/status",
	authenticate,
	validate(updateListingStatusSchema),
	listingController.updateListingStatus,
);



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



listingRouter.get("/:listingId/photos", authenticate, validate(listingParamsSchema), photoController.getPhotos);

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
