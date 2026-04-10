// src/validators/photo.validators.js
//
// Validation schemas for listing photo endpoints.
//
// Photo uploads are unusual compared to the rest of the API in that the primary
// payload — the image file — is NOT validated by Zod. It is validated by Multer's
// fileFilter and the Sharp decoder in the worker. Zod only needs to validate the
// route parameters and the optional display_order field from the request body.

import { z } from "zod";

// Used by POST /listings/:listingId/photos
// The file itself is validated by Multer (mimetype + size). display_order is an
// optional integer hint the client can send so that multiple uploads end up in
// the right visual order without requiring a subsequent reorder request.
// If absent, the service assigns display_order = (current max + 1) so the new
// photo always appears at the end of the gallery.
export const uploadPhotoSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z
		.object({
			displayOrder: z.coerce.number().int().min(0).optional(),
		})
		.optional()
		.default({}),
});

// Used by DELETE /listings/:listingId/photos/:photoId
// Both IDs are UUIDs — catching a non-UUID path param here prevents it from
// reaching the service as a malformed string that PostgreSQL would reject with
// a cryptic invalid-uuid error.
export const deletePhotoSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
		photoId: z.uuid({ error: "Invalid photo ID" }),
	}),
});

// Used by PUT /listings/:listingId/photos/reorder
// The client sends an array of { photoId, displayOrder } objects representing
// the desired display sequence for all photos in this listing.
// The constraint is that every photoId in the array must belong to this listing,
// and both photoId and displayOrder values must be unique within the payload.
// The service also performs server-side defensive checks before writing.
export const reorderPhotosSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z.object({
		photos: z
			.array(
				z.object({
					photoId: z.uuid({ error: "Each photoId must be a valid UUID" }),
					displayOrder: z.coerce.number().int().min(0),
				}),
			)
			.min(1, { message: "photos array must contain at least one entry" })
			.superRefine((photos, ctx) => {
				const seenPhotoIds = new Map();
				const seenDisplayOrders = new Map();

				photos.forEach((photo, index) => {
					const { photoId, displayOrder } = photo;

					if (seenPhotoIds.has(photoId)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: "Duplicate photoId values are not allowed in reorder payload",
							path: [index, "photoId"],
						});
					} else {
						seenPhotoIds.set(photoId, index);
					}

					if (seenDisplayOrders.has(displayOrder)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: "Duplicate displayOrder values are not allowed in reorder payload",
							path: [index, "displayOrder"],
						});
					} else {
						seenDisplayOrders.set(displayOrder, index);
					}
				});
			}),
	}),
});

// Used by PATCH /listings/:listingId/photos/:photoId/cover
// Sets this photo as the listing's cover image. No body required — the intent
// is fully expressed by the route verb and path.
export const setCoverSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
		photoId: z.uuid({ error: "Invalid photo ID" }),
	}),
});
