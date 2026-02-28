// src/validators/student.validators.js

import { z } from "zod";

// Params-only schema for the GET route — validates the userId param is a UUID
// before the controller runs, so invalid IDs are rejected at the edge with a
// clean 400 rather than causing a PostgreSQL error or returning a misleading 404.
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

		// ISO date string — e.g. "2000-08-15"
		dateOfBirth: z.string().date({ error: "Must be a valid date (YYYY-MM-DD)" }).optional(),
	}),
});
