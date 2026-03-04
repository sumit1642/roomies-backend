// src/validators/listing.validators.js

import { z } from "zod";

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

// Amenity IDs for room-level amenities (listing_amenities).
// Distinct from property_amenities — these are room-specific (e.g. attached
// bathroom only in this room even though the building has shared bathrooms).
const amenityIdsSchema = z.array(z.uuid({ error: "Each amenity ID must be a valid UUID" })).default([]);

// Listing preferences — what kind of roommate the poster wants.
// These are the EAV rows written to listing_preferences. The schema enforces
// non-empty keys and values; the UNIQUE (listing_id, preference_key) DB
// constraint enforces no duplicate keys per listing.
const preferencesSchema = z
	.array(
		z.object({
			preferenceKey: z.string().min(1, { error: "Preference key cannot be empty" }).max(100),
			preferenceValue: z.string().min(1, { error: "Preference value cannot be empty" }).max(100),
		}),
	)
	.default([]);

// Coordinate pair cross-field refinement — applied to both create and update.
// PostGIS sync_location_geometry trigger requires both lat and lng together or
// neither. A partial pair silently produces a NULL geometry in the DB, which
// removes the listing from all proximity search results without any error.
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

// ─── Listing params ───────────────────────────────────────────────────────────

// Used by GET /:listingId, PUT /:listingId, DELETE /:listingId.
// Catches non-UUID path params at the validator edge so they never reach the
// service or generate a cryptic PostgreSQL invalid-UUID error.
export const listingParamsSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
});

// ─── Search listings ──────────────────────────────────────────────────────────

// GET /api/v1/listings
// All filters are optional. city is the most common filter — nearly every
// real search includes it. Coordinates + radius activate the PostGIS proximity
// path. amenityIds activates the EXISTS subquery filter.
//
// Rent values are accepted from the client in RUPEES and converted to PAISE
// in the service. Do not coerce to paise here — the validator's job is shape,
// the service's job is the business rule.
//
// radius defaults to 5000m (5km). Max 50km — beyond that, proximity search
// loses meaning for PG discovery and risks returning most of the table.
export const searchListingsSchema = z.object({
	query: z
		.object({
			city: z.string().min(1).max(100).optional(),

			minRent: z.coerce.number().int().min(0).optional(),
			maxRent: z.coerce.number().int().min(0).optional(),

			roomType: z.enum(["single", "double", "triple", "entire_flat"]).optional(),
			bedType: z.enum(["single_bed", "double_bed", "bunk_bed"]).optional(),

			preferredGender: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),

			listingType: z.enum(["student_room", "pg_room", "hostel_bed"]).optional(),

			availableFrom: z.string().date({ error: "availableFrom must be a valid date (YYYY-MM-DD)" }).optional(),

			// Proximity — requires all three to activate the spatial path
			lat: z.coerce.number().min(-90).max(90).optional(),
			lng: z.coerce.number().min(-180).max(180).optional(),
			radius: z.coerce.number().int().min(100).max(50_000).default(5_000),

			// Comma-separated amenity UUID list from query string —
			// e.g. ?amenityIds=uuid1,uuid2
			// Transformed into an array for the service.
			amenityIds: z
				.string()
				.optional()
				.transform((val) =>
					val ?
						val
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					:	[],
				),

			// Keyset pagination cursor
			cursorTime: z.string().optional(),
			cursorId: z.uuid({ error: "cursorId must be a valid UUID" }).optional(),
			limit: z.coerce.number().int().min(1).max(100).default(20),
		})
		.refine(
			(data) => {
				// Rent range: if both provided, min must not exceed max
				if (data.minRent !== undefined && data.maxRent !== undefined) {
					return data.minRent <= data.maxRent;
				}
				return true;
			},
			{ error: "minRent cannot be greater than maxRent", path: ["minRent"] },
		)
		.refine(
			(data) => {
				// Cursor: both fields must come together or not at all
				const hasTime = data.cursorTime !== undefined;
				const hasId = data.cursorId !== undefined;
				return hasTime === hasId;
			},
			{ error: "cursorTime and cursorId must be provided together" },
		)
		.refine(
			(data) => {
				// Proximity: lat and lng must both be present if either is given
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

// ─── Create listing ───────────────────────────────────────────────────────────

// POST /api/v1/listings
//
// The single most important cross-field rule in this schema:
//   - listing_type 'pg_room' or 'hostel_bed' → property_id REQUIRED,
//     address/coordinate fields are FORBIDDEN (inherited from property)
//   - listing_type 'student_room'             → property_id FORBIDDEN,
//     addressLine and city are REQUIRED (student listing owns its own location)
//
// This branching is enforced by two .refine() calls on the body object.
//
// expires_at is intentionally absent from this schema. It is never accepted
// from the client — the service always sets it to NOW() + INTERVAL '60 days'.
// If it appeared here, a client could POST a listing that never expires.
//
// rent_per_month and deposit_amount are in RUPEES here. The service converts
// them to PAISE (× 100) before writing. See the paise comment in the service.
export const createListingSchema = z.object({
	body: withCoordinateRefinement(
		z
			.object({
				listingType: z.enum(["student_room", "pg_room", "hostel_bed"], {
					error: "listingType must be one of: student_room, pg_room, hostel_bed",
				}),

				// Required for PG/hostel listings; forbidden for student listings.
				// The refine() below enforces the conditional requirement.
				propertyId: z.uuid({ error: "propertyId must be a valid UUID" }).optional(),

				title: z.string().min(5, { error: "Title must be at least 5 characters" }).max(255),
				description: z.string().max(2000).optional(),

				// Rupees — service multiplies by 100 before writing to DB
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

				// Address fields — required for student listings, ignored for PG listings
				// (PG listings inherit location from their parent property).
				addressLine: z.string().min(5).max(500).optional(),
				city: z.string().min(2).max(100).optional(),
				locality: z.string().max(100).optional(),
				landmark: z.string().max(255).optional(),
				pincode: z
					.string()
					.regex(/^\d{6}$/, { error: "Pincode must be exactly 6 digits" })
					.optional(),

				// Coordinates — valid for student listings only (cross-field refinement above)
				latitude: z.coerce.number().min(-90).max(90).optional(),
				longitude: z.coerce.number().min(-180).max(180).optional(),

				// Room-level amenities and roommate preferences
				amenityIds: amenityIdsSchema,
				preferences: preferencesSchema,
			})
			// Cross-field rule 1: PG/hostel listings require a property_id
			.refine((data) => data.listingType === "student_room" || data.propertyId !== undefined, {
				error: "propertyId is required for pg_room and hostel_bed listings",
				path: ["propertyId"],
			})
			// Cross-field rule 2: Student listings require addressLine and city
			.refine(
				(data) =>
					data.listingType !== "student_room" || (data.addressLine !== undefined && data.city !== undefined),
				{
					error: "addressLine and city are required for student_room listings",
					path: ["addressLine"],
				},
			)
			// Cross-field rule 3: PG listings must NOT include coordinates
			// (the location is inherited from the parent property)
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

// ─── Update listing ───────────────────────────────────────────────────────────

// PUT /api/v1/listings/:listingId
// All fields optional — dynamic SET clause in service updates only what's provided.
//
// listing_type is intentionally excluded — you cannot change a student listing
// into a PG listing after creation. The property_id nullable distinction is
// baked into the DB row and would require cascading changes to related data.
//
// expires_at is excluded — only renewable via a dedicated endpoint (Phase 5).
//
// property_id is excluded — changing which property a listing belongs to is
// not a supported operation. It would require re-validating ownership of the
// new property, re-inheriting location, and potentially invalidating interest
// requests. Safer to delete + recreate.
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

			// Address fields — only meaningful for student listings.
			// The service ignores them for PG listings (no-op).
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

			// Full-replace semantics: if present, replaces all room amenities.
			// If absent, existing amenities are untouched.
			amenityIds: amenityIdsSchema.optional(),

			// Full-replace semantics: if present, replaces all listing preferences.
			preferences: preferencesSchema.optional(),
		}),
	),
});

// ─── Listing preferences (standalone) ────────────────────────────────────────

// PUT /api/v1/listings/:listingId/preferences
// Full-replace of the entire preference set for this listing.
export const updatePreferencesSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z.object({
		preferences: preferencesSchema,
	}),
});

// ─── Save / unsave ────────────────────────────────────────────────────────────

// POST and DELETE /api/v1/listings/:listingId/save
// Only the listingId param needs validation — no body.
export const saveListingSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
});

// ─── Saved listings feed ──────────────────────────────────────────────────────

// GET /api/v1/listings/me/saved
// Keyset pagination on saved_at (when the user bookmarked the listing).
export const savedListingsSchema = z.object({
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
