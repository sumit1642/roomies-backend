

import * as verificationService from "../services/verification.service.js";

export const submitDocument = async (req, res, next) => {
	try {
		const result = await verificationService.submitDocument(req.user.userId, req.params.userId, req.body);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const getVerificationQueue = async (req, res, next) => {
	try {
		const { cursorTime, cursorId, limit } = req.query;
		const result = await verificationService.getVerificationQueue({
			cursorTime,
			cursorId,
			limit: limit ? Number(limit) : undefined,
		});
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const approveRequest = async (req, res, next) => {
	try {
		const result = await verificationService.approveRequest(req.user.userId, req.params.requestId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const rejectRequest = async (req, res, next) => {
	try {
		const result = await verificationService.rejectRequest(req.user.userId, req.params.requestId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
