// src/validators/savedSearch.validators.js

import { z } from "zod";

const filtersSchema = z
	.object({
		city: z.string().min(1).max(100).optional(),
		minRent: z.coerce.number().int().min(0).optional(),
		maxRent: z.coerce.number().int().min(0).optional(),
		roomType: z.enum(["single", "double", "triple", "entire_flat"]).optional(),
		bedType: z.enum(["single_bed", "double_bed", "bunk_bed"]).optional(),
		preferredGender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),
		listingType: z.enum(["student_room", "pg_room", "hostel_bed"]).optional(),
		availableFrom: z.string().date().optional(),
		amenityIds: z.array(z.uuid()).default([]),
	})
	.refine(
		(data) => {
			if (data.minRent !== undefined && data.maxRent !== undefined) {
				return data.minRent <= data.maxRent;
			}
			return true;
		},
		{ error: "minRent cannot be greater than maxRent", path: ["minRent"] },
	);

export const createSavedSearchSchema = z.object({
	body: z.object({
		name: z.string().min(1).max(100),
		filters: filtersSchema,
	}),
});

export const savedSearchParamsSchema = z.object({
	params: z.object({
		searchId: z.uuid({ error: "Invalid search ID" }),
	}),
});

export const updateSavedSearchSchema = z.object({
	params: z.object({
		searchId: z.uuid({ error: "Invalid search ID" }),
	}),
	body: z.object({
		name: z.string().min(1).max(100).optional(),
		filters: filtersSchema.optional(),
	}),
});
