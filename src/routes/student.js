// src/routes/student.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAuthenticate } from "../middleware/optionalAuthenticate.js";
import { contactRevealGate } from "../middleware/contactRevealGate.js";
import { validate } from "../middleware/validate.js";
import { getStudentParamsSchema, updateStudentSchema } from "../validators/student.validators.js";
import * as studentController from "../controllers/student.controller.js";

export const studentRouter = Router();

// GET is intentionally readable by any authenticated user — students need to
// view each other's profiles to evaluate roommate compatibility. The ownership
// restriction only applies to PUT (only the owner can update their own profile,
// enforced in the service layer).
studentRouter.get("/:userId/profile", authenticate, validate(getStudentParamsSchema), studentController.getProfile);
studentRouter.put("/:userId/profile", authenticate, validate(updateStudentSchema), studentController.updateProfile);


// Public contact reveal endpoint: verified users are unlimited; guest/unverified users are capped and then redirected to login/signup by client.
studentRouter.get(
	"/:userId/contact/reveal",
	optionalAuthenticate,
	contactRevealGate,
	validate(getStudentParamsSchema),
	studentController.revealContact,
);
