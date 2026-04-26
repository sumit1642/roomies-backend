// src/routes/rentIndex.js

import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { getRentIndexSchema } from "../validators/rentIndex.validators.js";
import * as rentIndexController from "../controllers/rentIndex.controller.js";

export const rentIndexRouter = Router();

// Public — no auth required. Guests viewing a listing should see rent context.
rentIndexRouter.get("/", validate(getRentIndexSchema), rentIndexController.getRentIndex);
