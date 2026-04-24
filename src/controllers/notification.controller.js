

import * as notificationService from "../services/notification.service.js";


export const getFeed = async (req, res, next) => {
	try {
		const result = await notificationService.getFeed(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};


export const getUnreadCount = async (req, res, next) => {
	try {
		const result = await notificationService.getUnreadCount(req.user.userId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};


export const markRead = async (req, res, next) => {
	try {
		const result = await notificationService.markRead(req.user.userId, req.body);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
