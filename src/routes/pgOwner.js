// src/routes/pgOwner.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { updatePgOwnerSchema } from "../validators/pgOwner.validators.js";
import * as pgOwnerController from "../controllers/pgOwner.controller.js";

export const pgOwnerRouter = Router();

pgOwnerRouter.get("/:userId/profile", authenticate, pgOwnerController.getProfile);
pgOwnerRouter.put("/:userId/profile", authenticate, validate(updatePgOwnerSchema), pgOwnerController.updateProfile);
