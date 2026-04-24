

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { contactRevealGate } from "../middleware/contactRevealGate.js";
import { validate } from "../middleware/validate.js";
import {
	getStudentParamsSchema,
	updateStudentSchema,
	getStudentPreferencesSchema,
	updateStudentPreferencesSchema,
} from "../validators/student.validators.js";
import * as studentController from "../controllers/student.controller.js";

export const studentRouter = Router();

studentRouter.get("/:userId/profile", authenticate, validate(getStudentParamsSchema), studentController.getProfile);
studentRouter.put("/:userId/profile", authenticate, validate(updateStudentSchema), studentController.updateProfile);


















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
