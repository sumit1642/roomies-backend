// src/routes/verification.js
// Verification request routes:
//   POST   /verification/:userId/submit       — PG owner submits a document
//   GET    /verification/queue                — Admin: paginated pending queue
//   PATCH  /verification/:requestId/approve   — Admin: approve a request
//   PATCH  /verification/:requestId/reject    — Admin: reject a request

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import * as vc from "../controllers/verification.controller.js";

export const verificationRouter = Router();

// ── PG owner routes ────────────────────────────────────────────────────────────
// A PG owner submits verification documents for their own profile
verificationRouter.post("/:userId/submit", authenticate, authorize("pg_owner"), vc.submitDocument);

// ── Admin routes ───────────────────────────────────────────────────────────────
// GET /verification/queue — paginated list of pending verification requests
verificationRouter.get("/queue", authenticate, ...requireAdmin, vc.getVerificationQueue);

// PATCH /verification/:requestId/approve
verificationRouter.patch("/:requestId/approve", authenticate, ...requireAdmin, vc.approveRequest);

// PATCH /verification/:requestId/reject
verificationRouter.patch("/:requestId/reject", authenticate, ...requireAdmin, vc.rejectRequest);
