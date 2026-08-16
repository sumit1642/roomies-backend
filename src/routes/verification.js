// src/routes/verification.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import * as vc from "../controllers/verification.controller.js";

export const verificationRouter = Router();

verificationRouter.post("/submit", authenticate, authorize("pg_owner"), vc.submitDocument);

// ── Admin routes ───────────────────────────────────────────────────────────────
verificationRouter.get("/queue", authenticate, ...requireAdmin, vc.getVerificationQueue);
verificationRouter.patch("/:requestId/approve", authenticate, ...requireAdmin, vc.approveRequest);
verificationRouter.patch("/:requestId/reject", authenticate, ...requireAdmin, vc.rejectRequest);
