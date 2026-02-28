// src/validators/student.validators.js

import { z } from "zod";

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

		// ISO date string — e.g. "2000-08-15"
		dateOfBirth: z.string().date({ error: "Must be a valid date (YYYY-MM-DD)" }).optional(),
	}),
});
