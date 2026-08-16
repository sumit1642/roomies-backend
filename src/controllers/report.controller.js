// src/controllers/report.controller.js

import * as reportService from "../services/report.service.js";

// ─── submitReport ─────────────────────────────────────────────────────────────

export const submitReport = async (req, res, next) => {
	try {
		const result = await reportService.submitReport(req.user.userId, req.params.ratingId, req.body);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const getReportQueue = async (req, res, next) => {
	try {
		const { cursorTime, cursorId, limit } = req.query;
		const result = await reportService.getReportQueue({ cursorTime, cursorId, limit });
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// ─── resolveReport ────────────────────────────────────────────────────────────

export const resolveReport = async (req, res, next) => {
	try {
		const result = await reportService.resolveReport(req.user.userId, req.params.reportId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
