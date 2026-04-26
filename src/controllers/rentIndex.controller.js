// src/controllers/rentIndex.controller.js

import * as rentIndexService from "../services/rentIndex.service.js";

export const getRentIndex = async (req, res, next) => {
	try {
		const { city, locality, roomType } = req.query;

		if (!city || !locality || !roomType) {
			return res.status(400).json({
				status: "error",
				message: "Missing required query parameters: city, locality, roomType",
			});
		}

		const result = await rentIndexService.getRentIndex({ city, locality, roomType });
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
