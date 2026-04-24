

import { z } from "zod";
import { requiredPreferencesSchema } from "./preferences.validators.js";




export const getStudentParamsSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
});

export const updateStudentSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		fullName: z.string().min(2).max(255).optional(),
		bio: z.string().max(500).optional(),
		course: z.string().max(255).optional(),
		yearOfStudy: z.coerce.number().int().min(1).max(7).optional(),
		gender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),

		
		dateOfBirth: z.string().date({ error: "Must be a valid date (YYYY-MM-DD)" }).optional(),
	}),
});

export const getStudentPreferencesSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
});

export const updateStudentPreferencesSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		preferences: requiredPreferencesSchema,
	}),
});
