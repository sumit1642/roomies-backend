// src/controllers/auth.controller.js

import * as authService from "../services/auth.service.js";

export const register = async (req, res, next) => {
	try {
		const tokens = await authService.register(req.body);
		res.status(201).json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};

export const login = async (req, res, next) => {
	try {
		const tokens = await authService.login(req.body);
		res.json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};

export const logout = async (req, res, next) => {
	try {
		await authService.logout(req.user.userId);
		res.json({ status: "success", message: "Logged out" });
	} catch (err) {
		next(err);
	}
};

export const refresh = async (req, res, next) => {
	try {
		const result = await authService.refresh(req.body.refreshToken);
		res.json({ status: "success", data: result });
	} catch (err) {
		next(err);
	}
};

export const sendOtp = async (req, res, next) => {
	try {
		await authService.sendOtp(req.user.userId, req.user.email);
		res.json({ status: "success", message: "OTP sent to your email" });
	} catch (err) {
		next(err);
	}
};

export const verifyOtp = async (req, res, next) => {
	try {
		await authService.verifyOtp(req.user.userId, req.body.otp);
		res.json({ status: "success", message: "Email verified successfully" });
	} catch (err) {
		next(err);
	}
};

export const me = (req, res) => {
	res.json({ status: "success", data: req.user });
};
