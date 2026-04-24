

import { z } from "zod";



const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;




const isValidISO8601 = (s) => {
	if (!ISO_8601_RE.test(s)) return false;
	const ms = Date.parse(s);
	return !Number.isNaN(ms);
};



const toOptionalNumber = (val) => {
	if (val === null) return undefined;
	if (typeof val === "string" && val.trim() === "") return undefined;
	return val;
};



const coordinateSchema = (min, max, label) =>
	z.preprocess(
		toOptionalNumber,
		z.coerce
			.number()
			.min(min, { error: `${label} must be between ${min} and ${max}` })
			.max(max, { error: `${label} must be between ${min} and ${max}` })
			.optional(),
	);

const latitudeSchema = coordinateSchema(-90, 90, "Latitude");
const longitudeSchema = coordinateSchema(-180, 180, "Longitude");

const amenityIdsSchema = z.array(z.uuid({ error: "Each amenity ID must be a valid UUID" })).default([]);

const withCoordinateRefinement = (schema) =>
	schema
		.refine((data) => !(data.latitude !== undefined && data.longitude === undefined), {
			error: "longitude is required when latitude is provided",
			path: ["longitude"],
		})
		.refine((data) => !(data.longitude !== undefined && data.latitude === undefined), {
			error: "latitude is required when longitude is provided",
			path: ["latitude"],
		});

export const propertyParamsSchema = z.object({
	params: z.object({
		propertyId: z.uuid({ error: "Invalid property ID" }),
	}),
});

export const listPropertiesSchema = z.object({
	query: z
		.object({
			cursorTime: z
				.string()
				.optional()
				.refine((s) => s === undefined || isValidISO8601(s), {
					error: "cursorTime must be a valid ISO 8601 datetime",
				}),
			cursorId: z.uuid({ error: "cursorId must be a valid UUID" }).optional(),
			limit: z.coerce.number().int().min(1).max(100).default(20),
		})
		.refine(
			(data) => {
				const hasTime = data.cursorTime !== undefined;
				const hasId = data.cursorId !== undefined;
				return hasTime === hasId;
			},
			{ error: "cursorTime and cursorId must be provided together" },
		),
});

export const createPropertySchema = z.object({
	body: withCoordinateRefinement(
		z.object({
			propertyName: z.string().min(2, { error: "Property name must be at least 2 characters" }).max(255),
			description: z.string().max(2000).optional(),

			propertyType: z.enum(["pg", "hostel", "shared_apartment"], {
				error: "Property type must be one of: pg, hostel, shared_apartment",
			}),

			addressLine: z.string().min(5, { error: "Address line must be at least 5 characters" }).max(500),
			city: z.string().min(2, { error: "City is required" }).max(100),
			locality: z.string().max(100).optional(),
			landmark: z.string().max(255).optional(),
			pincode: z
				.string()
				.regex(/^\d{6}$/, { error: "Pincode must be exactly 6 digits" })
				.optional(),

			latitude: latitudeSchema,
			longitude: longitudeSchema,

			houseRules: z.string().max(2000).optional(),
			totalRooms: z.coerce.number().int().min(1).max(1000).optional(),

			amenityIds: amenityIdsSchema,
		}),
	),
});

export const updatePropertySchema = z.object({
	params: z.object({
		propertyId: z.uuid({ error: "Invalid property ID" }),
	}),
	body: withCoordinateRefinement(
		z.object({
			propertyName: z.string().min(2).max(255).optional(),
			description: z.string().max(2000).optional(),
			propertyType: z.enum(["pg", "hostel", "shared_apartment"]).optional(),

			addressLine: z.string().min(5).max(500).optional(),
			city: z.string().min(2).max(100).optional(),
			locality: z.string().max(100).optional(),
			landmark: z.string().max(255).optional(),
			pincode: z
				.string()
				.regex(/^\d{6}$/, { error: "Pincode must be exactly 6 digits" })
				.optional(),

			latitude: latitudeSchema,
			longitude: longitudeSchema,

			houseRules: z.string().max(2000).optional(),
			totalRooms: z.coerce.number().int().min(1).max(1000).optional(),

			amenityIds: amenityIdsSchema.optional(),
		}),
	),
});
