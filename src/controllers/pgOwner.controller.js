

import * as pgOwnerService from "../services/pgOwner.service.js";
import { AppError } from "../middleware/errorHandler.js";

export const getProfile = async (req, res, next) => {
	try {
		const profile = await pgOwnerService.getPgOwnerProfile(req.user.userId, req.params.userId);
		res.json({ status: "success", data: profile });
	} catch (err) {
		next(err);
	}
};

export const updateProfile = async (req, res, next) => {
	try {
		const updated = await pgOwnerService.updatePgOwnerProfile(req.user.userId, req.params.userId, req.body);
		res.json({ status: "success", data: updated });
	} catch (err) {
		next(err);
	}
};

export const revealContact = async (req, res, next) => {
	try {
		
		
		
		
		
		if (!req.contactReveal) {
			return next(new AppError("Contact reveal gate context is missing — internal configuration error", 500));
		}
		const emailOnly = req.contactReveal.emailOnly ?? true;
		const contact = await pgOwnerService.getPgOwnerContactReveal(req.params.userId, emailOnly);
		res.json({ status: "success", data: contact });
	} catch (err) {
		next(err);
	}
};
