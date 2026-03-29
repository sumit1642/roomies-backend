// src/validators/pagination.validators.js
import { z } from "zod";

export const strictCursorTimeSchema = z.iso.datetime({ offset: true }).optional();

const keysetPaginationFields = {
	cursorTime: strictCursorTimeSchema,
	cursorId: z.uuid({ error: "cursorId must be a valid UUID" }).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const buildKeysetPaginationQuerySchema = (extraFields = {}) =>
	z
		.object({
			...extraFields,
			...keysetPaginationFields,
		})
		.refine(
			(data) => {
				const hasTime = data.cursorTime !== undefined;
				const hasId = data.cursorId !== undefined;
				return hasTime === hasId;
			},
			{
				error: "cursorTime and cursorId must be provided together",
				path: ["cursorTime"],
			},
		);

export const keysetPaginationQuerySchema = buildKeysetPaginationQuerySchema();
