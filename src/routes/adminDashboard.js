// src/routes/adminDashboard.js
//
// New scope beyond ADR-016's original endpoint inventory. Single read-only
// endpoint — gated by requireAdmin like every other admin route.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { validate } from "../middleware/validate.js";
import { getDashboardStatsSchema } from "../validators/adminDashboard.validators.js";
import * as adminDashboardController from "../controllers/adminDashboard.controller.js";

export const adminDashboardRouter = Router();

adminDashboardRouter.get(
	"/",
	authenticate,
	...requireAdmin,
	validate(getDashboardStatsSchema),
	adminDashboardController.getDashboardStats,
);
