











import { z } from "zod";








export const connectionParamsSchema = z.object({
	params: z.object({
		connectionId: z.uuid({ error: "Invalid connection ID" }),
	}),
});

























export const getMyConnectionsSchema = z.object({
	query: z
		.object({
			confirmationStatus: z
				.enum(["pending", "confirmed", "denied", "expired"], {
					error: "confirmationStatus must be one of: pending, confirmed, denied, expired",
				})
				.optional(),

			connectionType: z
				.enum(["student_roommate", "pg_stay", "hostel_stay", "visit_only"], {
					error: "connectionType must be one of: student_roommate, pg_stay, hostel_stay, visit_only",
				})
				.optional(),

			cursorTime: z.iso.datetime({ offset: true }).optional(),
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
