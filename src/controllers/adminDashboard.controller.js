// src/controllers/adminDashboard.controller.js

import * as adminDashboardService from "../services/adminDashboard.service.js";

export const getDashboardStats = async (req, res, next) => {
	try {
		const result = await adminDashboardService.getDashboardStats({ recentDays: req.query.recentDays });
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
