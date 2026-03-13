// src/controllers/notification.controller.js

import * as notificationService from "../services/notification.service.js";

// GET /api/v1/notifications
export const getFeed = async (req, res, next) => {
	try {
		const result = await notificationService.getFeed(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// GET /api/v1/notifications/unread-count
export const getUnreadCount = async (req, res, next) => {
	try {
		const result = await notificationService.getUnreadCount(req.user.userId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

// POST /api/v1/notifications/mark-read
export const markRead = async (req, res, next) => {
	try {
		const result = await notificationService.markRead(req.user.userId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
