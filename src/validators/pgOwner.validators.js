

import { z } from "zod";


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
			
			
			
			.regex(/^\+?[0-9]{7,15}$/, {
				error: "Must be a valid phone number (digits only, 7–15 characters, optional leading +)",
			})
			.optional(),
		
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
