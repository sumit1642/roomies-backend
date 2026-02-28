// src/validators/pgOwner.validators.js

import { z } from "zod";

// Params-only schema for the GET route — mirrors getStudentParamsSchema.
export const getPgOwnerParamsSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
});

export const updatePgOwnerSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		businessName: z.string().min(2).max(255).optional(),
		ownerFullName: z.string().min(2).max(255).optional(),
		businessDescription: z.string().max(1000).optional(),
		businessPhone: z
			.string()
			.max(20)
			// Accepts Indian mobile numbers (+91XXXXXXXXXX or 10-digit), with optional
			// country code and leading +. Rejects free-text like "call me!" while
			// staying permissive enough for real-world number formats seen in India.
			.regex(/^\+?[0-9]{7,15}$/, {
				error: "Must be a valid phone number (digits only, 7–15 characters, optional leading +)",
			})
			.optional(),
		// Year computed at validation time — never stale across year boundaries.
		operatingSince: z.coerce
			.number()
			.int()
			.min(1900)
			.refine((val) => val <= new Date().getFullYear(), {
				message: "Operating since cannot be in the future",
			})
			.optional(),
	}),
});
