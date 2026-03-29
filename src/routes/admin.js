// src/routes/admin.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { getQueueSchema, approveRequestSchema, rejectRequestSchema } from "../validators/verification.validators.js";
import { getReportQueueSchema, resolveReportSchema } from "../validators/report.validators.js";
import * as verificationController from "../controllers/verification.controller.js";
import * as reportController from "../controllers/report.controller.js";

export const adminRouter = Router();

// Both authenticate and authorize('admin') are applied at router level — not on
// individual routes. This means it is architecturally impossible to register an
// unprotected route on this router: the middleware chain runs unconditionally for
// every request that reaches any route defined below.
adminRouter.use(authenticate, authorize("admin"));

// ─── Verification queue ───────────────────────────────────────────────────────

adminRouter.get("/verification-queue", validate(getQueueSchema), verificationController.getVerificationQueue);

adminRouter.post(
	"/verification-queue/:requestId/approve",
	validate(approveRequestSchema),
	verificationController.approveRequest,
);

adminRouter.post(
	"/verification-queue/:requestId/reject",
	validate(rejectRequestSchema),
	verificationController.rejectRequest,
);

// ─── Reputation moderation (Phase 4) ──────────────────────────────────────────

// GET /api/v1/admin/report-queue
// Returns open rating reports oldest-first with full context (rating text,
// reporter profile, reviewee profile). The admin needs everything in one response
// to make a moderation decision without additional round trips.
adminRouter.get("/report-queue", validate(getReportQueueSchema), reportController.getReportQueue);

// PATCH /api/v1/admin/reports/:reportId/resolve
// Closes the report as either 'resolved_removed' (hides the rating, triggers the
// DB aggregate recalculation automatically) or 'resolved_kept' (closes the report
// without touching the rating). Both outcomes are final — no re-opening.
adminRouter.patch("/reports/:reportId/resolve", validate(resolveReportSchema), reportController.resolveReport);
