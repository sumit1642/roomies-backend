// src/validators/adminUser.validators.js

import { z } from "zod";
import { buildKeysetPaginationQuerySchema } from "./pagination.validators.js";

export const getUserDetailSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
});

// Mirrors account_status_enum from migrations/001 exactly — 'active' is
// included (not just the punitive statuses) so this same endpoint also
// covers reactivating a previously suspended/banned/deactivated user.
const ACCOUNT_STATUS_VALUES = ["active", "suspended", "banned", "deactivated"];

export const listUsersSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		role: z.enum(["student", "pg_owner", "admin"]).optional(),
		accountStatus: z.enum(ACCOUNT_STATUS_VALUES).optional(),
		email: z.string().trim().min(1).max(255).optional(),
	}),
});

export const setUserAccountStatusSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		accountStatus: z.enum(ACCOUNT_STATUS_VALUES, {
			error: `accountStatus must be one of: ${ACCOUNT_STATUS_VALUES.join(", ")}`,
		}),
		reason: z
			.string({ error: "reason is required" })
			.trim()
			.min(1, { error: "reason cannot be empty" })
			.max(1000, { error: "reason must not exceed 1000 characters" }),
	}),
});
