

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
		
		
		
		
		
		
		if (!req.contactReveal) {
			return next(new AppError("Contact reveal gate context is missing — internal configuration error", 500));
		}

		
		
		
		
		const contact = await studentService.getStudentContactReveal(req.params.userId, req.contactReveal.emailOnly);

		res.json({ status: "success", data: contact });
	} catch (err) {
		next(err);
	}
};
