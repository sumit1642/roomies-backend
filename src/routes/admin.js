// src/routes/admin.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import { getQueueSchema, approveRequestSchema, rejectRequestSchema } from "../validators/verification.validators.js";
import * as verificationController from "../controllers/verification.controller.js";

export const adminRouter = Router();

// Both authenticate and authorize('admin') are applied at router level — not on
// individual routes. This means it is architecturally impossible to register an
// unprotected route on this router: the middleware chain runs unconditionally for
// every request that reaches any route defined below.
//
// Router-level authorization is a capability the system enforces, not a convention
// that relies on developer discipline. Every future admin endpoint added here is
// automatically protected without any additional middleware on the route itself.
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
