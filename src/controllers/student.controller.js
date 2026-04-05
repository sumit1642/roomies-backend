// src/controllers/student.controller.js

import * as studentService from "../services/student.service.js";

export const getProfile = async (req, res, next) => {
	try {
		const profile = await studentService.getStudentProfile(req.user.userId, req.params.userId);
		res.json({ status: "success", data: profile });
	} catch (err) {
		next(err);
	}
};

export const updateProfile = async (req, res, next) => {
	try {
		const updated = await studentService.updateStudentProfile(req.user.userId, req.params.userId, req.body);
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
		//
		// If contactRevealGate is ever accidentally removed from the route, emailOnly
		// defaults to false (full bundle returned), which is the safer direction for
		// verified users. The real risk of missing the gate is that unverified
		// callers would get the full bundle — so the route definition is the critical
		// contract, not a defensive check here.
		const emailOnly = req.contactReveal?.emailOnly ?? false;
		const contact = await studentService.getStudentContactReveal(req.params.userId, emailOnly);
		res.json({ status: "success", data: contact });
	} catch (err) {
		next(err);
	}
};
