// src/validators/property.validators.js

import { z } from "zod";

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

// Used in both create and update to validate the amenity ID list.
// z.uuid() on each element catches non-UUID strings before they reach the
// service and produce a cryptic FK violation from PostgreSQL.
// .default([]) means omitting amenityIds from the request body is treated as
// "no amenities" — not an error. The service handles [] correctly for both
// create (no junction rows inserted) and update (all existing rows deleted).
const amenityIdsSchema = z.array(z.uuid({ error: "Each amenity ID must be a valid UUID" })).default([]);

// Shared coordinate pair — extracted so the cross-field refinement logic is
// written once and applied consistently to both the create and update schemas.
//
// The refinement enforces that latitude and longitude are always provided
// together or not at all. A property with only one coordinate is meaningless
// for PostGIS — the sync_location_geometry trigger sets location = NULL when
// either column is null, so a partial coordinate silently produces a property
// with no spatial index entry and no proximity search capability.
//
// We return a different error path for each missing field so the client gets
// a field-specific message rather than a generic schema error.
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

// ─── Property params ─────────────────────────────────────────────────────────

// Used by GET /:propertyId and DELETE /:propertyId — validates the route param
// is a well-formed UUID before any DB query runs. Without this, a request like
// GET /properties/not-a-uuid would hit PostgreSQL with an invalid UUID and
// return a confusing 500 instead of a clean 400.
export const propertyParamsSchema = z.object({
	params: z.object({
		propertyId: z.uuid({ error: "Invalid property ID" }),
	}),
});

// ─── List properties ──────────────────────────────────────────────────────────

// GET /api/v1/properties — returns the authenticated PG owner's own properties.
// Keyset pagination with compound cursor (created_at + property_id) consistent
// with the verification queue pattern established in Phase 1.
export const listPropertiesSchema = z.object({
	query: z
		.object({
			cursorTime: z.string().optional(),
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

// ─── Create property ──────────────────────────────────────────────────────────

// POST /api/v1/properties
// Required fields: property_name, property_type, address_line, city.
// Everything else is optional at creation — a PG owner can fill in full details
// later via PUT. This matches real-world onboarding: operators often add a
// property before they have every detail ready.
//
// pincode is a string, not a number — Indian postal codes can have leading zeros
// (e.g. 011001 for parts of Delhi). Coercing to number would silently destroy
// that leading zero.
//
// The coordinate cross-field refinement is applied via withCoordinateRefinement
// so the error surfaces with a proper field path rather than at the schema root.
export const createPropertySchema = z.object({
	body: withCoordinateRefinement(
		z.object({
			propertyName: z.string().min(2, { error: "Property name must be at least 2 characters" }).max(255),
			description: z.string().max(2000).optional(),

			propertyType: z.enum(["pg", "hostel", "shared_apartment"], {
				error: "Property type must be one of: pg, hostel, shared_apartment",
			}),

			// Address
			addressLine: z.string().min(5, { error: "Address line must be at least 5 characters" }).max(500),
			city: z.string().min(2, { error: "City is required" }).max(100),
			locality: z.string().max(100).optional(),
			landmark: z.string().max(255).optional(),
			pincode: z
				.string()
				.regex(/^\d{6}$/, { error: "Pincode must be exactly 6 digits" })
				.optional(),

			// Coordinates — must both be present or both absent (refinement above)
			latitude: z.coerce
				.number()
				.min(-90, { error: "Latitude must be between -90 and 90" })
				.max(90, { error: "Latitude must be between -90 and 90" })
				.optional(),
			longitude: z.coerce
				.number()
				.min(-180, { error: "Longitude must be between -180 and 180" })
				.max(180, { error: "Longitude must be between -180 and 180" })
				.optional(),

			houseRules: z.string().max(2000).optional(),
			totalRooms: z.coerce.number().int().min(1).max(1000).optional(),

			// Full-replace semantics: the amenityIds array defines the complete
			// set of amenities this property should have after the operation.
			amenityIds: amenityIdsSchema,
		}),
	),
});

// ─── Update property ──────────────────────────────────────────────────────────

// PUT /api/v1/properties/:propertyId
// All fields are optional — only provided fields are updated (dynamic SET clause
// in the service). amenityIds, if present, replaces the entire amenity set.
//
// status is intentionally excluded from the update schema. The only valid
// transition is active → inactive and vice versa — this is a separate
// PATCH /status endpoint concern (Phase 5). Allowing arbitrary status writes
// here would let a PG owner set their own property to 'under_review', which
// only admins should be able to do.
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

			latitude: z.coerce.number().min(-90).max(90).optional(),
			longitude: z.coerce.number().min(-180).max(180).optional(),

			houseRules: z.string().max(2000).optional(),
			totalRooms: z.coerce.number().int().min(1).max(1000).optional(),

			// Optional on update — omitting amenityIds leaves the existing amenity
			// set untouched. Providing an empty array [] clears all amenities.
			// This distinction matters: undefined = "don't touch", [] = "remove all".
			amenityIds: amenityIdsSchema.optional(),
		}),
	),
});
