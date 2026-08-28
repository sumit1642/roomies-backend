// src/controllers/adminUser.controller.js

import * as adminUserService from "../services/adminUser.service.js";
import { adminMutationEnvelope, adminListEnvelope } from "../utils/adminResponse.js";

export const getUserDetail = async (req, res, next) => {
	try {
		const result = await adminUserService.getUserDetail(req.params.userId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const listUsers = async (req, res, next) => {
	try {
		const result = await adminUserService.listUsers(req.query);
		res.json(adminListEnvelope(result.items, result.nextCursor));
	} catch (err) {
		next(err);
	}
};

export const setUserAccountStatus = async (req, res, next) => {
	try {
		const result = await adminUserService.setUserAccountStatus(req.user.userId, req.params.userId, req.body);
		res.json(
			adminMutationEnvelope(result, {
				actorId: req.user.userId,
				action: "user.setAccountStatus",
			}),
		);
	} catch (err) {
		next(err);
	}
};
