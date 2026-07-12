// src/controllers/pincode.controller.js

import * as pincodeService from "../services/pincode.service.js";

export const getPincode = async (req, res, next) => {
	try {
		const result = await pincodeService.getPincode(req.params.pincode);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};
