// src/validators/rankedSearch.validators.js

import { z } from "zod";

// Preference override shape — mirrors the listing preferences contract.
// preferenceKey and preferenceValue are both constrained to 1–100 chars
// to match the DB column sizes and the listing_preferences schema.
const preferenceOverrideSchema = z.object({
	preferenceKey: z.string().min(1, { error: "preferenceKey cannot be empty" }).max(100),
	preferenceValue: z.string().min(1, { error: "preferenceValue cannot be empty" }).max(100),
});

// ─── GET /listings/search/ranked ─────────────────────────────────────────────
//
// All standard filter params are optional and identical to GET /listings
// (city, rent range, room type, etc.).
//
// Ranked-specific params:
//   preferenceOverrides — JSON array of { preferenceKey, preferenceValue }.
//     Sent as a query param so the endpoint stays GET-able. The array is
//     JSON-encoded by the client: ?preferenceOverrides=[{"preferenceKey":"smoking",...}]
//
//   persistPreferences — if "true", the overrides are written to user_preferences
//     after the search. Defaults to false (search-only, no side effects).
//
// Cursor: { cursorRankScore, cursorId } (both required together or both absent).
//   cursorRankScore is a float, coerced from the string query param.

export const rankedSearchSchema = z.object({
	query: z
		.object({
			// Standard filters
			city: z.string().min(1).max(100).optional(),
			minRent: z.coerce.number().int().min(0).optional(),
			maxRent: z.coerce.number().int().min(0).optional(),
			roomType: z.enum(["single", "double", "triple", "entire_flat"]).optional(),
			bedType: z.enum(["single_bed", "double_bed", "bunk_bed"]).optional(),
			preferredGender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),
			listingType: z.enum(["student_room", "pg_room", "hostel_bed"]).optional(),
			availableFrom: z.string().date({ error: "availableFrom must be YYYY-MM-DD" }).optional(),
			lat: z.coerce.number().min(-90).max(90).optional(),
			lng: z.coerce.number().min(-180).max(180).optional(),
			radius: z.coerce.number().int().min(100).max(50_000).default(5_000),

			amenityIds: z.preprocess(
				(val) => {
					if (typeof val !== "string") return val;
					return val
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
				},
				z.array(z.uuid({ error: "Each amenity ID must be a valid UUID" })).default([]),
			),

			// Ranked-specific: preference overrides as JSON string
			preferenceOverrides: z.preprocess(
				(val) => {
					if (val === undefined || val === null || val === "") return [];
					if (typeof val === "string") {
						try {
							const parsed = JSON.parse(val);
							return Array.isArray(parsed) ? parsed : [];
						} catch {
							return [];
						}
					}
					return Array.isArray(val) ? val : [];
				},
				z
					.array(preferenceOverrideSchema)
					.max(20, { error: "At most 20 preference overrides allowed" })
					.default([]),
			),

			// Whether to persist overrides into user_preferences
			persistPreferences: z.preprocess((val) => {
				if (val === "true" || val === true) return true;
				return false;
			}, z.boolean().default(false)),

			// Cursor fields (float rank score + UUID id)
			cursorRankScore: z.coerce.number().min(0).max(1).optional(),
			cursorId: z.uuid({ error: "cursorId must be a valid UUID" }).optional(),

			limit: z.coerce.number().int().min(1).max(100).default(20),
		})
		.refine(
			(data) => {
				if (data.minRent !== undefined && data.maxRent !== undefined) {
					return data.minRent <= data.maxRent;
				}
				return true;
			},
			{ error: "minRent cannot be greater than maxRent", path: ["minRent"] },
		)
		.refine(
			(data) => {
				const hasLat = data.lat !== undefined;
				const hasLng = data.lng !== undefined;
				return hasLat === hasLng;
			},
			{ error: "lat and lng must be provided together", path: ["lng"] },
		)
		.refine(
			(data) => {
				const hasScore = data.cursorRankScore !== undefined;
				const hasId = data.cursorId !== undefined;
				return hasScore === hasId;
			},
			{ error: "cursorRankScore and cursorId must be provided together", path: ["cursorRankScore"] },
		),
});
