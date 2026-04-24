










import { z } from "zod";
import { buildKeysetPaginationQuerySchema } from "./pagination.validators.js";







export const createInterestSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	body: z
		.object({
			message: z.string().min(1).max(1000).optional(),
		})
		.optional()
		.default({}),
});







export const interestParamsSchema = z.object({
	params: z.object({
		interestId: z.uuid({ error: "Invalid interest request ID" }),
	}),
});













export const updateInterestStatusSchema = z.object({
	params: z.object({
		interestId: z.uuid({ error: "Invalid interest request ID" }),
	}),
	body: z.object({
		status: z.enum(["accepted", "declined", "withdrawn"], {
			error: "status must be one of: accepted, declined, withdrawn",
		}),
	}),
});








export const getListingInterestsSchema = z.object({
	params: z.object({
		listingId: z.uuid({ error: "Invalid listing ID" }),
	}),
	query: buildKeysetPaginationQuerySchema({
		status: z.enum(["pending", "accepted", "declined", "withdrawn", "expired"]).optional(),
	}),
});







export const getMyInterestsSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		status: z.enum(["pending", "accepted", "declined", "withdrawn", "expired"]).optional(),
	}),
});
