// src/controllers/student.controller.js

import * as studentService from "../services/student.service.js";
import { AppError } from "../middleware/errorHandler.js";

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
		// contactRevealGate must always run before this controller. If it is absent
		// (programming error — gate removed from the route definition), fail closed
		// with a 500 rather than accidentally disclosing the full contact bundle.
		// The previous default of false would silently broaden access for guests;
		// a loud 500 forces the developer to notice and fix the route configuration.
		if (!req.contactReveal) {
			return next(new AppError("Contact reveal gate context is missing — internal configuration error", 500));
		}
		const emailOnly = req.contactReveal.emailOnly;
		const contact = await studentService.getStudentContactReveal(
			req.params.userId,
			emailOnly,
			req.user?.userId ?? null,
		);
		res.json({ status: "success", data: contact });
	} catch (err) {
		next(err);
	}
};
