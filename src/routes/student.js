import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { contactRevealGate } from "../middleware/contactRevealGate.js";
import { validate } from "../middleware/validate.js";
import { upload } from "../middleware/upload.js";
import { UPLOAD_FIELD_NAME } from "../config/constants.js";
import {
	getStudentParamsSchema,
	updateStudentSchema,
	getStudentPreferencesSchema,
	updateStudentPreferencesSchema,
} from "../validators/student.validators.js";
import * as studentController from "../controllers/student.controller.js";
import * as profilePhotoController from "../controllers/profilePhoto.controller.js";

export const studentRouter = Router();

studentRouter.get("/:userId/profile", authenticate, validate(getStudentParamsSchema), studentController.getProfile);
studentRouter.put("/:userId/profile", authenticate, validate(updateStudentSchema), studentController.updateProfile);

studentRouter.put(
	"/:userId/photo",
	authenticate,
	validate(getStudentParamsSchema),
	upload.single(UPLOAD_FIELD_NAME),
	profilePhotoController.uploadStudentPhoto,
);

studentRouter.delete(
	"/:userId/photo",
	authenticate,
	validate(getStudentParamsSchema),
	profilePhotoController.deleteStudentPhoto,
);

studentRouter.get(
	"/:userId/contact/reveal",
	optionalAuthenticate,
	validate(getStudentParamsSchema),
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
