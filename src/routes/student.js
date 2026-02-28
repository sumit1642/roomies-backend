// src/routes/student.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { updateStudentSchema } from "../validators/student.validators.js";
import * as studentController from "../controllers/student.controller.js";

export const studentRouter = Router();

studentRouter.get("/:userId/profile", authenticate, studentController.getProfile);
studentRouter.put("/:userId/profile", authenticate, validate(updateStudentSchema), studentController.updateProfile);
