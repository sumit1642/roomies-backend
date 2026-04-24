

import * as connectionService from "../services/connection.service.js";








export const confirmConnection = async (req, res, next) => {
	try {
		const result = await connectionService.confirmConnection(req.user.userId, req.params.connectionId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};






export const getConnection = async (req, res, next) => {
	try {
		const result = await connectionService.getConnection(req.user.userId, req.params.connectionId);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};





export const getMyConnections = async (req, res, next) => {
	try {
		const result = await connectionService.getMyConnections(req.user.userId, req.query);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
