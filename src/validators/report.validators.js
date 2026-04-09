// src/validators/report.validators.js
//
// Validation schemas for the rating report pipeline (Phase 4 moderation).
//
// The reporter must be a party to the connection the rating references — this
// is a semantic constraint that requires database context, so it is enforced
// in the service layer, not here. Zod handles the structural layer only:
// are the right fields present and the right types?

import { z } from "zod";
import { keysetPaginationQuerySchema } from "./pagination.validators.js";

// ─── Submit report ────────────────────────────────────────────────────────────
// POST /api/v1/ratings/:ratingId/report
//
// `reason` is drawn from the report_reason_enum defined in the DB schema.
// `explanation` is optional but encouraged — the admin sees it in the queue.
export const submitReportSchema = z.object({
	params: z.object({
		ratingId: z.uuid({ error: "Invalid rating ID" }),
	}),
	body: z.object({
		reason: z.enum(["fake", "abusive", "conflict_of_interest", "other"], {
			error: "reason must be one of: fake, abusive, conflict_of_interest, other",
		}),
		explanation: z.string().trim().min(1).max(2000).optional(),
	}),
});

// ─── Admin report queue ───────────────────────────────────────────────────────
// GET /api/v1/admin/report-queue
//
// Keyset paginated, oldest-first (same anti-starvation pattern as the
// verification queue). The admin sees all open reports.
export const getReportQueueSchema = z.object({
	query: keysetPaginationQuerySchema,
});

// ─── Resolve report ───────────────────────────────────────────────────────────
// PATCH /api/v1/admin/reports/:reportId/resolve
//
// Two outcomes only: `resolved_removed` hides the rating (triggers the DB
// aggregate recalculation) or `resolved_kept` closes the report without
// touching the rating. There is no third option — an admin must commit to
// a decision.
export const resolveReportSchema = z.object({
	params: z.object({
		reportId: z.uuid({ error: "Invalid report ID" }),
	}),
	body: z
		.object({
			resolution: z.enum(["resolved_removed", "resolved_kept"], {
				error: "resolution must be one of: resolved_removed, resolved_kept",
			}),
			adminNotes: z.string().trim().min(1).max(1000).optional(),
		})
		.refine((data) => data.resolution !== "resolved_removed" || Boolean(data.adminNotes?.trim()), {
			message: "adminNotes is required when resolution is resolved_removed",
			path: ["adminNotes"],
		}),
});
