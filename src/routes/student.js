// src/routes/student.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
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
