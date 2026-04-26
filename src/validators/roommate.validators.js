// src/validators/roommate.validators.js

import { z } from "zod";
import { buildKeysetPaginationQuerySchema } from "./pagination.validators.js";

export const getRoommateFeedSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		city: z.string().min(1).max(100).optional(),
	}).transform((data) => ({
		...data,
		// Clamp limit to 50 for the roommate feed (tighter than listing search)
		limit: Math.min(data.limit, 50),
	})),
});

export const updateRoommateProfileSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
	}),
	body: z.object({
		lookingForRoommate: z.boolean({
			error: "lookingForRoommate must be a boolean",
		}),
		roommateBio: z.string().max(500).optional(),
	}),
});

export const blockTargetParamsSchema = z.object({
	params: z.object({
		userId: z.uuid({ error: "Invalid user ID" }),
		targetUserId: z.uuid({ error: "Invalid target user ID" }),
	}),
});
