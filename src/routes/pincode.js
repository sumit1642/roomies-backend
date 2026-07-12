// src/routes/pincode.js

import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { getPincodeSchema } from "../validators/pincode.validators.js";
import * as pincodeController from "../controllers/pincode.controller.js";

export const pincodeRouter = Router();

// Public — no auth required. Matches the rentIndexRouter pattern: this is
// public reference/context data, not user- or listing-specific.
pincodeRouter.get("/:pincode", validate(getPincodeSchema), pincodeController.getPincode);
