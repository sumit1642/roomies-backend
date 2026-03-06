// src/controllers/interest.controller.js
//

import * as interestService from "../services/interest.service.js";

export const createInterestRequest = async (req, res, next) => {
	try {
		const result = await interestService.createInterestRequest(
			req.user.userId,
			req.params.listingId,
			req.body?.message, // Optional message — may be absent from body
		);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const updateInterestStatus = async (req, res, next) => {
	try {
		const result = await interestService.updateInterestStatus(
			req.user.userId,
			req.params.interestId,
			req.body.status,
		);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const getListingInterests = async (req, res, next) => {
	try {
		const result = await interestService.getListingInterests(req.user.userId, req.params.listingId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const getMyInterestRequests = async (req, res, next) => {
	try {
		const result = await interestService.getMyInterestRequests(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
