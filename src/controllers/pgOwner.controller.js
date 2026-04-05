// src/controllers/pgOwner.controller.js

import * as pgOwnerService from "../services/pgOwner.service.js";

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
		// req.contactReveal is stamped onto the request object by contactRevealGate,
		// which always runs before this controller in the middleware chain. The gate
		// has already made the allow/deny decision and set the tier. We just read
		// emailOnly from it and pass it down to the service for response shaping.
		const emailOnly = req.contactReveal?.emailOnly ?? false;
		const contact = await pgOwnerService.getPgOwnerContactReveal(req.params.userId, emailOnly);
		res.json({ status: "success", data: contact });
	} catch (err) {
		next(err);
	}
};
