// src/routes/savedSearch.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
	createSavedSearchSchema,
	savedSearchParamsSchema,
	updateSavedSearchSchema,
} from "../validators/savedSearch.validators.js";
import * as savedSearchController from "../controllers/savedSearch.controller.js";

export const savedSearchRouter = Router();

savedSearchRouter.get("/", authenticate, savedSearchController.list);
savedSearchRouter.post("/", authenticate, validate(createSavedSearchSchema), savedSearchController.create);
savedSearchRouter.patch("/:searchId", authenticate, validate(updateSavedSearchSchema), savedSearchController.update);
savedSearchRouter.delete("/:searchId", authenticate, validate(savedSearchParamsSchema), savedSearchController.remove);
