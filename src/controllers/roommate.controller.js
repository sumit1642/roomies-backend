// src/controllers/roommate.controller.js

import * as roommateService from "../services/roommate.service.js";

export const getFeed = async (req, res, next) => {
	try {
		const result = await roommateService.getRoommateFeed(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const updateRoommateProfile = async (req, res, next) => {
	try {
		const result = await roommateService.updateRoommateProfile(req.user.userId, req.params.userId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const blockUser = async (req, res, next) => {
	try {
		const result = await roommateService.blockUser(req.user.userId, req.params.targetUserId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const unblockUser = async (req, res, next) => {
	try {
		const result = await roommateService.unblockUser(req.user.userId, req.params.targetUserId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
