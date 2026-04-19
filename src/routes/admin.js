// src/routes/admin.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";

// ── Existing validators (Phase 1 + Phase 4) ──────────────────────────────────
import { getQueueSchema, approveRequestSchema, rejectRequestSchema } from "../validators/verification.validators.js";
import { getReportQueueSchema, resolveReportSchema } from "../validators/report.validators.js";

// ── New validators (Phase 5 admin) ───────────────────────────────────────────
import { listUsersSchema, getUserDetailSchema, updateUserStatusSchema } from "../validators/adminUser.validators.js";
import { listRatingsSchema, updateRatingVisibilitySchema } from "../validators/adminRating.validators.js";

// ── Existing controllers (Phase 1 + Phase 4) ─────────────────────────────────
import * as verificationController from "../controllers/verification.controller.js";
import * as reportController from "../controllers/report.controller.js";

// ── New controllers (Phase 5 admin) ──────────────────────────────────────────
import * as adminUserController from "../controllers/adminUser.controller.js";
import * as adminRatingController from "../controllers/adminRating.controller.js";
import * as adminAnalyticsController from "../controllers/adminAnalytics.controller.js";

export const adminRouter = Router();

// Both authenticate and authorize('admin') are applied at router level — not on
// individual routes. This means it is architecturally impossible to register an
// unprotected route on this router: the middleware chain runs unconditionally for
// every request that reaches any route defined below.
adminRouter.use(authenticate, authorize("admin"));

// ─── Verification queue (Phase 1) ─────────────────────────────────────────────

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
// Returns open rating reports oldest-first with full context.
adminRouter.get("/report-queue", validate(getReportQueueSchema), reportController.getReportQueue);

// PATCH /api/v1/admin/reports/:reportId/resolve
// Closes a report as resolved_removed or resolved_kept.
adminRouter.patch("/reports/:reportId/resolve", validate(resolveReportSchema), reportController.resolveReport);

// ─── User management (Phase 5) ────────────────────────────────────────────────

// GET /api/v1/admin/users
// Paginated user list with optional filters: role, accountStatus, isEmailVerified.
adminRouter.get("/users", validate(listUsersSchema), adminUserController.listUsers);

// GET /api/v1/admin/users/:userId
// Full detail for a single user: both profile records, activity counts,
// verification status. Registered BEFORE /:userId/status to avoid any
// possible route shadowing (though Express matches by specificity so this
// ordering is for clarity, not correctness).
adminRouter.get("/users/:userId", validate(getUserDetailSchema), adminUserController.getUserDetail);

// PATCH /api/v1/admin/users/:userId/status
// Status transition: active ↔ suspended ↔ banned, or deactivated → active.
// Enforces admin-targeting guard and concurrency guard in the service layer.
adminRouter.patch("/users/:userId/status", validate(updateUserStatusSchema), adminUserController.updateUserStatus);

// ─── Rating visibility management (Phase 5) ───────────────────────────────────

// GET /api/v1/admin/ratings
// Paginated rating feed. Filterable by isVisible, revieweeType, revieweeId.
// Useful for auditing hidden ratings or finding suspicious patterns before
// a formal report has been filed.
adminRouter.get("/ratings", validate(listRatingsSchema), adminRatingController.listRatings);

// PATCH /api/v1/admin/ratings/:ratingId/visibility
// Direct visibility toggle. Bypasses the report flow — the admin can hide
// or restore a rating without a corresponding report existing. The DB trigger
// update_rating_aggregates fires automatically to maintain cached averages.
adminRouter.patch(
	"/ratings/:ratingId/visibility",
	validate(updateRatingVisibilitySchema),
	adminRatingController.updateRatingVisibility,
);

// ─── Platform analytics (Phase 5) ─────────────────────────────────────────────

// GET /api/v1/admin/analytics/platform
// Single dashboard snapshot: user counts, listing health, connection throughput,
// and rating aggregates. Computed fresh on every request — no caching layer.
adminRouter.get("/analytics/platform", adminAnalyticsController.getPlatformAnalytics);
