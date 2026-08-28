// ─── NEW FILE: src/validators/amenities.validators.js ──────────────────────
//
// amenity_category_enum is declared in migration 001 as
// ('utility', 'safety', 'comfort') — mirrored here as a literal enum rather
// than imported from anywhere, since there is no existing JS-side constant
// for it (config/preferences.js's pattern doesn't apply — amenities aren't
// user preferences).

import { z } from "zod";

const AMENITY_CATEGORIES = ["utility", "safety", "comfort"];

export const amenityParamsSchema = z.object({
	params: z.object({
		amenityId: z.uuid({ error: "Invalid amenity ID" }),
	}),
});

export const createAmenitySchema = z.object({
	body: z.object({
		name: z
			.string({ error: "name is required" })
			.trim()
			.min(2, { error: "name must be at least 2 characters" })
			.max(100),
		category: z.enum(AMENITY_CATEGORIES, {
			error: `category must be one of: ${AMENITY_CATEGORIES.join(", ")}`,
		}),
		iconName: z.string().trim().max(100).optional(),
	}),
});

export const updateAmenitySchema = z.object({
	params: z.object({
		amenityId: z.uuid({ error: "Invalid amenity ID" }),
	}),
	body: z
		.object({
			name: z.string().trim().min(2).max(100).optional(),
			category: z.enum(AMENITY_CATEGORIES).optional(),
			iconName: z.string().trim().max(100).optional(),
		})
		.refine((data) => Object.keys(data).length > 0, {
			error: "At least one field must be provided for update",
		}),
});
