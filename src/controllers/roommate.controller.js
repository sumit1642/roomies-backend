// src/controllers/roommate.controller.js

import * as roommateService from "../services/roommate.service.js";

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const getFeed = asyncHandler(async (req, res) => {
	const result = await roommateService.getRoommateFeed(req.user.userId, req.query);
	res.json({ status: "success", data: result });
});

export const updateRoommateProfile = asyncHandler(async (req, res) => {
	const result = await roommateService.updateRoommateProfile(req.user.userId, req.params.userId, req.body);
	res.json({ status: "success", data: result });
});

export const blockUser = asyncHandler(async (req, res) => {
	const result = await roommateService.blockUser(req.user.userId, req.params.targetUserId);
	res.json({ status: "success", data: result });
});

export const unblockUser = asyncHandler(async (req, res) => {
	const result = await roommateService.unblockUser(req.user.userId, req.params.targetUserId);
	res.json({ status: "success", data: result });
});
