// src/validators/pgOwner.validators.js

import { z } from "zod";

const currentYear = new Date().getFullYear();

export const updatePgOwnerSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		businessName: z.string().min(2).max(255).optional(),
		ownerFullName: z.string().min(2).max(255).optional(),
		businessDescription: z.string().max(1000).optional(),
		businessPhone: z.string().max(20).optional(),
		operatingSince: z.coerce
			.number()
			.int()
			.min(1900)
			.max(currentYear, { error: `Operating since cannot be in the future` })
			.optional(),
	}),
});
