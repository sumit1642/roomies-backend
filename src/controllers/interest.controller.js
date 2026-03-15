// src/controllers/interest.controller.js

import * as interestService from "../services/interest.service.js";

export const createInterestRequest = async (req, res, next) => {
	try {
		// Pass the full body object (or a safe default) so the service can
		// destructure { message } from it. Passing req.body?.message directly
		// would give the service a string instead of an object, causing a
		// TypeError when it tries to destructure { message } from a primitive.
		const result = await interestService.createInterestRequest(
			req.user.userId,
			req.params.listingId,
			req.body ?? {}, // always an object; message is optional inside
		);
		res.status(201).json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/interests/:interestId
// Returns full detail for one interest request. The service enforces that the
// caller is one of the two parties — no role restriction at the route level
// because both students (sender) and posters (receiver) need this endpoint.
export const getInterestRequest = async (req, res, next) => {
	try {
		const result = await interestService.getInterestRequest(req.user.userId, req.params.interestId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const updateInterestStatus = async (req, res, next) => {
	try {
		const result = await interestService.transitionInterestRequest(
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
		const result = await interestService.getInterestRequestsForListing(
			req.user.userId,
			req.params.listingId,
			req.query,
		);
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
