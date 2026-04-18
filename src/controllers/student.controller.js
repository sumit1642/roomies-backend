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

export const getPreferences = async (req, res, next) => {
	try {
		const preferences = await studentService.getStudentPreferences(req.user.userId, req.params.userId);
		res.json({ status: "success", data: preferences });
	} catch (err) {
		next(err);
	}
};

export const updatePreferences = async (req, res, next) => {
	try {
		const preferences = await studentService.updateStudentPreferences(
			req.user.userId,
			req.params.userId,
			req.body.preferences,
		);
		res.json({ status: "success", data: preferences });
	} catch (err) {
		next(err);
	}
};

export const revealContact = async (req, res, next) => {
	try {
		// contactRevealGate MUST run before this controller. If it is absent
		// (a programming error — gate removed from the route definition), fail
		// closed with a 500 rather than accidentally disclosing the full contact
		// bundle. Defaulting to emailOnly=true here would silently broaden access
		// for guests on a misconfigured route; a loud 500 forces the developer to
		// notice and fix the route configuration.
		if (!req.contactReveal) {
			return next(new AppError("Contact reveal gate context is missing — internal configuration error", 500));
		}

		// The gate's emailOnly decision is the single source of truth. The service
		// no longer re-derives tier eligibility — it trusts this value entirely.
		// This is the correct architecture: middleware decides WHO can see WHAT,
		// and the service only fetches and shapes the data accordingly.
		const contact = await studentService.getStudentContactReveal(req.params.userId, req.contactReveal.emailOnly);

		res.json({ status: "success", data: contact });
	} catch (err) {
		next(err);
	}
};
