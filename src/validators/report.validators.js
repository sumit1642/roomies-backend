








import { z } from "zod";
import { keysetPaginationQuerySchema } from "./pagination.validators.js";






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






export const getReportQueueSchema = z.object({
	query: keysetPaginationQuerySchema,
});








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
