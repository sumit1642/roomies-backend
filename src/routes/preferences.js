// src/routes/preferences.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import * as preferencesController from "../controllers/preferences.controller.js";

export const preferencesRouter = Router();

preferencesRouter.get("/meta", authenticate, preferencesController.getMetadata);
