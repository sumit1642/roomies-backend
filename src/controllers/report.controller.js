// src/controllers/report.controller.js
//
// Thin controller wrappers for the rating report pipeline. No business logic
// here — validation has already run through the validate() middleware and all
// service functions throw AppError on known failures.

import * as reportService from "../services/report.service.js";

const UUID_V1_TO_V5_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// POST /api/v1/ratings/:ratingId/report
// Any authenticated user who is a party to the underlying connection can report
// a rating. The service enforces the party-membership check.
export const submitReport = async (req, res, next) => {
	try {
		const result = await reportService.submitReport(req.user.userId, req.params.ratingId, req.body);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/admin/report-queue
// Admin-only. Returns open reports oldest-first with full context.
export const getReportQueue = async (req, res, next) => {
	try {
		const { cursorTime, cursorId, limit } = req.query;

		const parsedCursorTime =
			typeof cursorTime === "string" ?
				(() => {
					const dt = new Date(cursorTime);
					return Number.isNaN(dt.getTime()) ? undefined : dt;
				})()
			:	undefined;

		const parsedCursorId =
			typeof cursorId === "string" && UUID_V1_TO_V5_REGEX.test(cursorId) ? cursorId : undefined;

		// Fix: Number("") === 0, which would cause the service to return no rows.
		// Treat empty strings, whitespace-only strings, and any value that doesn't
		// produce a finite positive integer as "not provided" (undefined), which
		// causes the service to use its own default limit instead.
		//
		// Guard order:
		//   1. Is limit even provided as a non-empty string?
		//   2. Is the result a finite number? (rejects NaN from non-numeric strings)
		//   3. Is it a positive integer? (rejects 0 and negative values)
		const parsedLimit = typeof limit === "string" && limit.trim() !== "" ? Number(limit) : undefined;

		const safeParsedLimit =
			Number.isFinite(parsedLimit) && Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

		const result = await reportService.getReportQueue({
			cursorTime: parsedCursorTime,
			cursorId: parsedCursorId,
			limit: safeParsedLimit,
		});
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// PATCH /api/v1/admin/reports/:reportId/resolve
// Admin-only. Closes the report with either resolved_removed or resolved_kept.
export const resolveReport = async (req, res, next) => {
	try {
		const result = await reportService.resolveReport(req.user.userId, req.params.reportId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
