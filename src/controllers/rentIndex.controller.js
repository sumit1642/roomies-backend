// src/controllers/rentIndex.controller.js

import * as rentIndexService from "../services/rentIndex.service.js";

export const getRentIndex = async (req, res, next) => {
	try {
		const { city, locality, roomType } = req.query;
		const result = await rentIndexService.getRentIndex({ city, locality, roomType });
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
