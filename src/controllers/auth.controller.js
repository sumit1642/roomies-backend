// src/controllers/auth.controller.js

import * as authService from "../services/auth.service.js";
import { parseTtlSeconds } from "../services/auth.service.js";
import { AppError } from "../middleware/errorHandler.js";
import { config } from "../config/env.js";
import jwt from "jsonwebtoken";

const ACCESS_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: parseTtlSeconds(config.JWT_EXPIRES_IN, 15 * 60) * 1000,
};

const REFRESH_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN, 7 * 24 * 60 * 60) * 1000,
};

const setAuthCookies = (res, accessToken, refreshToken) => {
	res.cookie("accessToken", accessToken, ACCESS_COOKIE_OPTIONS);
	res.cookie("refreshToken", refreshToken, REFRESH_COOKIE_OPTIONS);
};

const clearAuthCookies = (res) => {
	res.clearCookie("accessToken", {
		httpOnly: true,
		secure: config.NODE_ENV === "production",
		sameSite: "strict",
	});
	res.clearCookie("refreshToken", {
		httpOnly: true,
		secure: config.NODE_ENV === "production",
		sameSite: "strict",
	});
};

// ─── Controllers ──────────────────────────────────────────────────────────────

export const register = async (req, res, next) => {
	try {
		const tokens = await authService.register(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
		res.status(201).json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};

export const login = async (req, res, next) => {
	try {
		const tokens = await authService.login(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
		res.json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};

export const logout = async (req, res, next) => {
	try {
		const incomingRefreshToken = req.body?.refreshToken ?? req.cookies?.refreshToken;
		if (!incomingRefreshToken) {
			return next(new AppError("Refresh token is required", 401));
		}
		await authService.logoutCurrent(req.user.userId, incomingRefreshToken);
		clearAuthCookies(res);
		res.json({ status: "success", message: "Logged out" });
	} catch (err) {
		next(err);
	}
};

export const logoutAll = async (req, res, next) => {
	try {
		await authService.logoutAll(req.user.userId);
		clearAuthCookies(res);
		res.json({ status: "success", message: "Logged out from all sessions" });
	} catch (err) {
		next(err);
	}
};

export const refresh = async (req, res, next) => {
	try {
		const incomingRefreshToken = req.body.refreshToken ?? req.cookies?.refreshToken;
		if (!incomingRefreshToken) {
			return next(new AppError("Refresh token is required", 401));
		}

		const tokens = await authService.refresh(incomingRefreshToken);

		// Set fresh cookies for browser clients. Previously this was missing,
		// which meant the expired accessToken cookie was never replaced on an
		// explicit refresh call — the browser had to rely on silent-refresh
		// middleware to eventually patch things up. Now refresh behaves like
		// login: both tokens are delivered via cookie AND JSON body so that
		// browser and Android clients are handled identically.
		//
		// The refreshToken cookie is also rotated here. Since authService.refresh()
		// now calls storeRefreshToken(), the old refresh token is atomically
		// revoked in Redis the moment the new one is stored. A compromised old
		// refresh token presented after this point will fail the Redis comparison
		// in the service and return 401.
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

		res.json({ status: "success", data: tokens });
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
		await authService.verifyOtp(req.user.userId, req.body.otp, req.ip);
		res.json({ status: "success", message: "Email verified successfully" });
	} catch (err) {
		next(err);
	}
};

export const me = (req, res) => {
	res.json({ status: "success", data: req.user });
};

export const listSessions = async (req, res, next) => {
	try {
		const refreshToken = req.cookies?.refreshToken ?? req.body?.refreshToken;
		const decoded = refreshToken ? jwt.decode(refreshToken) : null;
		const currentSid = decoded?.sid;
		const sessions = await authService.listSessions(req.user.userId, currentSid);
		res.json({ status: "success", data: sessions });
	} catch (err) {
		next(err);
	}
};

export const revokeSession = async (req, res, next) => {
	try {
		await authService.revokeSession(req.user.userId, req.params.sid);

		const refreshToken = req.cookies?.refreshToken;
		const decoded = refreshToken ? jwt.decode(refreshToken) : null;
		if (decoded?.sid === req.params.sid) {
			clearAuthCookies(res);
		}

		res.json({ status: "success", message: "Session revoked" });
	} catch (err) {
		next(err);
	}
};

export const googleCallback = async (req, res, next) => {
	try {
		const tokens = await authService.googleOAuth(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
		res.json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};
