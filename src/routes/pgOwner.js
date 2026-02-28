// src/routes/pgOwner.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { getPgOwnerParamsSchema, updatePgOwnerSchema } from "../validators/pgOwner.validators.js";
import * as pgOwnerController from "../controllers/pgOwner.controller.js";

export const pgOwnerRouter = Router();

// GET is intentionally readable by any authenticated user — students need to
// view PG owner profiles to evaluate listings and credibility. The ownership
// restriction only applies to PUT (enforced in the service layer).
pgOwnerRouter.get("/:userId/profile", authenticate, validate(getPgOwnerParamsSchema), pgOwnerController.getProfile);
pgOwnerRouter.put("/:userId/profile", authenticate, validate(updatePgOwnerSchema), pgOwnerController.updateProfile);
