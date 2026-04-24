

import { z } from "zod";
import { keysetPaginationQuerySchema } from "./pagination.validators.js";







export const submitDocumentSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		documentType: z.enum(["property_document", "rental_agreement", "owner_id", "trade_license"], {
			error: "Must be one of: property_document, rental_agreement, owner_id, trade_license",
		}),
		documentUrl: z.string({ error: "Document URL is required" }).min(1, { error: "Document URL cannot be empty" }),
	}),
});







export const getQueueSchema = z.object({
	query: keysetPaginationQuerySchema,
});




export const approveRequestSchema = z.object({
	params: z.object({
		requestId: z.uuid({ error: "Invalid request ID" }),
	}),
	body: z.object({
		adminNotes: z.string().max(1000).optional(),
	}),
});




export const rejectRequestSchema = z.object({
	params: z.object({
		requestId: z.uuid({ error: "Invalid request ID" }),
	}),
	body: z.object({
		rejectionReason: z
			.string({ error: "Rejection reason is required" })
			.min(1, { error: "Rejection reason cannot be empty" })
			.max(1000),
		adminNotes: z.string().max(1000).optional(),
	}),
});
