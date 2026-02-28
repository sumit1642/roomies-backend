// src/controllers/student.controller.js

import * as studentService from "../services/student.service.js";

export const getProfile = async (req, res, next) => {
	try {
		const profile = await studentService.getStudentProfile(req.params.userId);
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
