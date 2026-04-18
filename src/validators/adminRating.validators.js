// src/validators/adminRating.validators.js

import { z } from "zod";
import { buildKeysetPaginationQuerySchema } from "./pagination.validators.js";

// ─── GET /admin/ratings ───────────────────────────────────────────────────────
// Paginated rating list. The isVisible filter follows the same boolean-coercion
// pattern used by isRead in notification validators and isEmailVerified in
// adminUser validators — query params arrive as strings, so we preprocess.
export const listRatingsSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		isVisible: z
			.preprocess((val) => {
				if (typeof val === "string") {
					if (val.toLowerCase() === "true") return true;
					if (val.toLowerCase() === "false") return false;
					return val;
				}
				return val;
			}, z.boolean())
			.optional(),

		revieweeType: z
			.enum(["user", "property"], {
				error: "revieweeType must be either 'user' or 'property'",
			})
			.optional(),

		// revieweeId is only meaningful alongside revieweeType, but we validate
		// it as a standalone UUID here — the service handles the cross-field
		// semantics (e.g. querying by revieweeId without revieweeType works fine
		// because the DB query already filters on both).
		revieweeId: z.uuid({ error: "revieweeId must be a valid UUID" }).optional(),
	}),
});

// ─── PATCH /admin/ratings/:ratingId/visibility ────────────────────────────────
// adminNotes is conditionally required by the service (mandatory when hiding).
// Zod validates the shape; the service validates the conditional requirement,
// matching the same split used by resolveReportSchema and updateUserStatusSchema.
export const updateRatingVisibilitySchema = z.object({
	params: z.object({
		ratingId: z.uuid({ error: "Invalid rating ID" }),
	}),
	body: z.object({
		isVisible: z.boolean({
			error: "isVisible must be a boolean",
		}),
		adminNotes: z.string().trim().min(1).max(1000).optional(),
	}),
});
