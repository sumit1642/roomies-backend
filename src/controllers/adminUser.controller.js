// src/controllers/adminUser.controller.js

import * as adminUserService from "../services/adminUser.service.js";

// GET /api/v1/admin/users
// Paginated user list. All query params have been validated and coerced by
// the validate() middleware before this runs, so req.query is clean.
export const listUsers = async (req, res, next) => {
	try {
		const result = await adminUserService.listUsers(req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/admin/users/:userId
// Full user detail. The userId param is validated as a UUID by the validator.
export const getUserDetail = async (req, res, next) => {
	try {
		const result = await adminUserService.getUserDetail(req.params.userId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// PATCH /api/v1/admin/users/:userId/status
// Status transition. adminId comes from req.user.userId (set by authenticate
// middleware via the JWT payload — the admin's own identity).
export const updateUserStatus = async (req, res, next) => {
	try {
		const result = await adminUserService.updateUserStatus(req.user.userId, req.params.userId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
