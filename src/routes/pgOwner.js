import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { contactRevealGate } from "../middleware/contactRevealGate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { upload } from "../middleware/upload.js";
import { UPLOAD_FIELD_NAME } from "../config/constants.js";
import { getPgOwnerParamsSchema, updatePgOwnerSchema } from "../validators/pgOwner.validators.js";
import { submitDocumentSchema } from "../validators/verification.validators.js";
import * as pgOwnerController from "../controllers/pgOwner.controller.js";
import * as verificationController from "../controllers/verification.controller.js";
import * as profilePhotoController from "../controllers/profilePhoto.controller.js";

export const pgOwnerRouter = Router();

pgOwnerRouter.get("/:userId/profile", authenticate, validate(getPgOwnerParamsSchema), pgOwnerController.getProfile);

pgOwnerRouter.put(
	"/:userId/photo",
	authenticate,
	authorize("pg_owner"),
	validate(getPgOwnerParamsSchema),
	upload.single(UPLOAD_FIELD_NAME),
	profilePhotoController.uploadPgOwnerPhoto,
);

pgOwnerRouter.delete(
	"/:userId/photo",
	authenticate,
	authorize("pg_owner"),
	validate(getPgOwnerParamsSchema),
	profilePhotoController.deletePgOwnerPhoto,
);

pgOwnerRouter.post(
	"/:userId/contact/reveal",
	optionalAuthenticate,
	validate(getPgOwnerParamsSchema),
	(req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		next();
	},
	contactRevealGate,
	pgOwnerController.revealContact,
);

pgOwnerRouter.put(
	"/:userId/profile",
	authenticate,
	authorize("pg_owner"),
	validate(updatePgOwnerSchema),
	pgOwnerController.updateProfile,
);

pgOwnerRouter.post(
	"/:userId/documents",
	authenticate,
	authorize("pg_owner"),
	validate(submitDocumentSchema),
	verificationController.submitDocument,
);
