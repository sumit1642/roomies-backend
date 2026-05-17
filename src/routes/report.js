// src/routes/report.js
// Report routes:
//   GET    /reports/queue                     — Admin: paginated open report queue
//   PATCH  /reports/:reportId/resolve         — Admin: resolve a report
//
// NOTE: POST /ratings/:ratingId/report (submitReport) lives on the ratings router
//       because reports are always scoped to a rating.

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import * as rc from "../controllers/report.controller.js";

export const reportRouter = Router();

// GET /reports/queue — paginated list of open reports for admin review
reportRouter.get("/queue", authenticate, ...requireAdmin, rc.getReportQueue);

// PATCH /reports/:reportId/resolve — admin marks a report as resolved
// Body: { resolution: 'resolved_kept' | 'resolved_removed', adminNotes?: string }
reportRouter.patch("/:reportId/resolve", authenticate, ...requireAdmin, rc.resolveReport);
