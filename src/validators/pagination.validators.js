import { z } from "zod";

export const strictCursorTimeSchema = z.iso.datetime({ offset: true }).optional();

const buildKeysetPaginationFields = (allowCursorScore) => ({
	cursorTime: strictCursorTimeSchema,
	...(allowCursorScore ? { cursorScore: z.coerce.number().int().min(0).optional() } : {}),
	cursorId: z.uuid({ error: "cursorId must be a valid UUID" }).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const buildKeysetPaginationQuerySchema = (extraFields = {}, { allowCursorScore = false } = {}) =>
	z
		.object({
			...extraFields,
			...buildKeysetPaginationFields(allowCursorScore),
		})
		.refine(
			(data) => {
				const hasTime = data.cursorTime !== undefined;
				const hasScore = allowCursorScore && data.cursorScore !== undefined;
				const hasId = data.cursorId !== undefined;
				return hasId === (hasTime || hasScore) && !(hasTime && hasScore);
			},
			{
				error: "cursorId must be provided with exactly one cursor value",
				path: ["cursorTime"],
			},
		);

export const keysetPaginationQuerySchema = buildKeysetPaginationQuerySchema();
