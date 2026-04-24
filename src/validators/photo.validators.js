








import { z } from "zod";







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





export const deletePhotoSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
		photoId: z.uuid({ error: "Invalid photo ID" }),
	}),
});







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




export const setCoverSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
		photoId: z.uuid({ error: "Invalid photo ID" }),
	}),
});
