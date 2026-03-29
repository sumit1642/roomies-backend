// src/controllers/report.controller.js
//
// Thin controller wrappers for the rating report pipeline. No business logic
// here — validation has already run through the validate() middleware and all
// service functions throw AppError on known failures.

import * as reportService from "../services/report.service.js";

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
		const parsedLimit = limit ? Number(limit) : undefined;
		const result = await reportService.getReportQueue({
			cursorTime,
			cursorId,
			limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
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
