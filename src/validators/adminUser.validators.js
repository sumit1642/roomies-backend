// src/validators/adminUser.validators.js

import { z } from "zod";
import { buildKeysetPaginationQuerySchema } from "./pagination.validators.js";

// ─── GET /admin/users ─────────────────────────────────────────────────────────
// Paginated user list with optional filters.
//
// isEmailVerified uses the same preprocess pattern as the notification feed's
// isRead field — coercing the string "true"/"false" that comes in as a query
// parameter to a real boolean before Zod validates it.
export const listUsersSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		role: z
			.enum(["student", "pg_owner", "admin"], {
				error: "role must be one of: student, pg_owner, admin",
			})
			.optional(),

		accountStatus: z
			.enum(["active", "suspended", "banned", "deactivated"], {
				error: "accountStatus must be one of: active, suspended, banned, deactivated",
			})
			.optional(),

		isEmailVerified: z
			.preprocess((val) => {
				if (typeof val === "string") {
					if (val.toLowerCase() === "true") return true;
					if (val.toLowerCase() === "false") return false;
					return val;
				}
				return val;
			}, z.boolean())
			.optional(),
	}),
});

// ─── GET /admin/users/:userId ─────────────────────────────────────────────────
export const getUserDetailSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
});

// ─── PATCH /admin/users/:userId/status ───────────────────────────────────────
// 'deactivated' is intentionally excluded from the allowed values — admins
// cannot initiate a soft-delete (that's the user's own action via account
// deletion). Admins can only set active, suspended, or banned.
// The service layer enforces the full transition table; the validator only
// ensures the value is one of the three valid admin-settable states.
export const updateUserStatusSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		status: z.enum(["active", "suspended", "banned"], {
			error: "status must be one of: active, suspended, banned",
		}),
		// adminNotes is conditionally required by the service (mandatory for banning).
		// Zod validates its shape here; the service validates its presence based on
		// the chosen status — matching the pattern in resolveReportSchema.
		adminNotes: z.string().trim().min(1).max(1000).optional(),
	}),
});
