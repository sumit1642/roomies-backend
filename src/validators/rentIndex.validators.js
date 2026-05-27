// src/validators/rentIndex.validators.js

import { z } from "zod";

export const getRentIndexSchema = z.object({
	query: z.object({
		city: z.string({ error: "city is required" }).trim().min(1, { error: "city is required" }).max(100),
		locality: z.string().trim().min(1, { error: "locality cannot be empty if provided" }).max(100).optional(),
		roomType: z.enum(["single", "double", "triple", "entire_flat"], {
			error: "roomType must be one of: single, double, triple, entire_flat",
		}),
	}),
});
