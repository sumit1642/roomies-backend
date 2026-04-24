





import * as reportService from "../services/report.service.js";

const UUID_V1_TO_V5_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;




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

		const parsedCursorTime =
			typeof cursorTime === "string" ?
				(() => {
					const dt = new Date(cursorTime);
					return Number.isNaN(dt.getTime()) ? undefined : dt;
				})()
			:	undefined;

		const parsedCursorId =
			typeof cursorId === "string" && UUID_V1_TO_V5_REGEX.test(cursorId) ? cursorId : undefined;

		
		
		
		
		
		
		
		
		
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



export const resolveReport = async (req, res, next) => {
	try {
		const result = await reportService.resolveReport(req.user.userId, req.params.reportId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
