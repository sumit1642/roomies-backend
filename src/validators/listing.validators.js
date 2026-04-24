

import { z } from "zod";
import { buildKeysetPaginationQuerySchema, keysetPaginationQuerySchema } from "./pagination.validators.js";
import { preferencesSchema, requiredPreferencesSchema } from "./preferences.validators.js";



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



export const listingParamsSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
});



export const searchListingsSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		city: z.string().min(1).max(100).optional(),

		minRent: z.coerce.number().int().min(0).optional(),
		maxRent: z.coerce.number().int().min(0).optional(),

		roomType: z.enum(["single", "double", "triple", "entire_flat"]).optional(),
		bedType: z.enum(["single_bed", "double_bed", "bunk_bed"]).optional(),

		preferredGender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),

		listingType: z.enum(["student_room", "pg_room", "hostel_bed"]).optional(),

		availableFrom: z.string().date({ error: "availableFrom must be a valid date (YYYY-MM-DD)" }).optional(),

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
			{
				error: "lat and lng must be provided together for proximity search",
				path: ["lng"],
			},
		),
});



export const createListingSchema = z.object({
	body: withCoordinateRefinement(
		z
			.object({
				listingType: z.enum(["student_room", "pg_room", "hostel_bed"], {
					error: "listingType must be one of: student_room, pg_room, hostel_bed",
				}),

				propertyId: z.uuid({ error: "propertyId must be a valid UUID" }).optional(),

				title: z.string().min(5, { error: "Title must be at least 5 characters" }).max(255),
				description: z.string().max(2000).optional(),

				rentPerMonth: z.coerce
					.number()
					.int({ error: "Rent must be a whole number (rupees)" })
					.min(0, { error: "Rent cannot be negative" }),
				depositAmount: z.coerce
					.number()
					.int({ error: "Deposit must be a whole number (rupees)" })
					.min(0)
					.default(0),

				rentIncludesUtilities: z.boolean().default(false),
				isNegotiable: z.boolean().default(false),

				roomType: z.enum(["single", "double", "triple", "entire_flat"], {
					error: "roomType must be one of: single, double, triple, entire_flat",
				}),
				bedType: z.enum(["single_bed", "double_bed", "bunk_bed"]).optional(),

				totalCapacity: z.coerce.number().int().min(1).max(20).default(1),

				preferredGender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),

				availableFrom: z.string().date({ error: "availableFrom must be a valid date (YYYY-MM-DD)" }),
				availableUntil: z
					.string()
					.date({ error: "availableUntil must be a valid date (YYYY-MM-DD)" })
					.optional(),

				addressLine: z.string().min(5).max(500).optional(),
				city: z.string().min(2).max(100).optional(),
				locality: z.string().max(100).optional(),
				landmark: z.string().max(255).optional(),
				pincode: z
					.string()
					.regex(/^\d{6}$/, { error: "Pincode must be exactly 6 digits" })
					.optional(),

				latitude: z.coerce.number().min(-90).max(90).optional(),
				longitude: z.coerce.number().min(-180).max(180).optional(),

				amenityIds: amenityIdsSchema,
				preferences: preferencesSchema,
			})
			.refine((data) => data.listingType === "student_room" || data.propertyId !== undefined, {
				error: "propertyId is required for pg_room and hostel_bed listings",
				path: ["propertyId"],
			})
			.refine(
				(data) =>
					data.listingType !== "student_room" || (data.addressLine !== undefined && data.city !== undefined),
				{
					error: "addressLine and city are required for student_room listings",
					path: ["addressLine"],
				},
			)
			.refine(
				(data) =>
					data.listingType === "student_room" ||
					(data.latitude === undefined && data.longitude === undefined),
				{
					error: "Coordinates are not accepted for pg_room or hostel_bed listings — location is inherited from the property",
					path: ["latitude"],
				},
			),
	),
});



export const updateListingSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: withCoordinateRefinement(
		z.object({
			title: z.string().min(5).max(255).optional(),
			description: z.string().max(2000).optional(),

			rentPerMonth: z.coerce.number().int().min(0).optional(),
			depositAmount: z.coerce.number().int().min(0).optional(),
			rentIncludesUtilities: z.boolean().optional(),
			isNegotiable: z.boolean().optional(),

			roomType: z.enum(["single", "double", "triple", "entire_flat"]).optional(),
			bedType: z.enum(["single_bed", "double_bed", "bunk_bed"]).optional(),

			totalCapacity: z.coerce.number().int().min(1).max(20).optional(),
			preferredGender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),

			availableFrom: z.string().date({ error: "availableFrom must be a valid date (YYYY-MM-DD)" }).optional(),
			availableUntil: z.string().date({ error: "availableUntil must be a valid date (YYYY-MM-DD)" }).optional(),

			
			
			
			addressLine: z.string().min(5).max(500).optional(),
			city: z.string().min(2).max(100).optional(),
			locality: z.string().max(100).optional(),
			landmark: z.string().max(255).optional(),
			pincode: z
				.string()
				.regex(/^\d{6}$/, { error: "Pincode must be exactly 6 digits" })
				.optional(),

			latitude: z.coerce.number().min(-90).max(90).optional(),
			longitude: z.coerce.number().min(-180).max(180).optional(),

			amenityIds: amenityIdsSchema.optional(),
			preferences: preferencesSchema.optional(),
		}),
	),
});








export const updateListingStatusSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z.object({
		status: z.enum(["active", "filled", "deactivated"], {
			error: "status must be one of: active, filled, deactivated",
		}),
	}),
});



export const updatePreferencesSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z.object({
		preferences: requiredPreferencesSchema,
	}),
});



export const saveListingSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
});



export const savedListingsSchema = z.object({
	query: keysetPaginationQuerySchema,
});
