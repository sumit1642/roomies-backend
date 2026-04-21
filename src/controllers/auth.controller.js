// src/controllers/auth.controller.js

import * as authService from "../services/auth.service.js";
import { parseTtlSeconds } from "../services/auth.service.js";
import { AppError } from "../middleware/errorHandler.js";
import { config } from "../config/env.js";
import { ACCESS_COOKIE_OPTIONS, REFRESH_COOKIE_OPTIONS } from "../middleware/authenticate.js";

// Determines whether the caller is a non-browser client (e.g. Android) or a
// cross-origin SPA that uses the bearer transport instead of cookies.
// The frontend sends X-Client-Transport: bearer in production.
const isBearerTransport = (req) => req.headers["x-client-transport"] === "bearer";

// Builds the safe body payload for cookie-mode responses.
const buildSafeBody = (tokens) => ({
	user: tokens.user,
	sid: tokens.sid,
});

const setAuthCookies = (res, accessToken, refreshToken) => {
	res.cookie("accessToken", accessToken, ACCESS_COOKIE_OPTIONS);
	res.cookie("refreshToken", refreshToken, REFRESH_COOKIE_OPTIONS);
};

const clearAuthCookies = (res) => {
	// Must use the same sameSite/secure settings to clear correctly
	res.clearCookie("accessToken", {
		httpOnly: true,
		secure: ACCESS_COOKIE_OPTIONS.secure,
		sameSite: ACCESS_COOKIE_OPTIONS.sameSite,
	});
	res.clearCookie("refreshToken", {
		httpOnly: true,
		secure: REFRESH_COOKIE_OPTIONS.secure,
		sameSite: REFRESH_COOKIE_OPTIONS.sameSite,
	});
};

// ─── Controllers ──────────────────────────────────────────────────────────────

export const register = async (req, res, next) => {
	try {
		const tokens = await authService.register(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

		// Always return full token data — the frontend needs it in production
		// where cookies can't cross domains. In cookie-mode the frontend ignores
		// the tokens in the body and relies on cookies.
		res.status(201).json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};

export const login = async (req, res, next) => {
	try {
		const tokens = await authService.login(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

		// Return full tokens unconditionally. Same reasoning as register above.
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

		if (req.user?.sid && req.user?.userId) {
			await authService.logoutCurrent(req.user.userId, incomingRefreshToken, req.user.sid);
		} else {
			await authService.logoutByRefreshToken(incomingRefreshToken);
		}
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
		const incomingRefreshToken = req.body?.refreshToken ?? req.cookies?.refreshToken;
		if (!incomingRefreshToken) {
			return next(new AppError("Refresh token is required", 401));
		}

		const tokens = await authService.refresh(incomingRefreshToken);

		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

		// Always return full tokens (bearer transport + cookie both work)
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
		const sessions = await authService.listSessions(req.user.userId, req.user.sid);
		res.json({ status: "success", data: sessions });
	} catch (err) {
		next(err);
	}
};

export const revokeSession = async (req, res, next) => {
	try {
		const { sid } = req.params;

		const isValidSid =
			typeof sid === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sid);

		if (!isValidSid) {
			return next(new AppError("Invalid session id", 400));
		}

		await authService.revokeSession(req.user.userId, sid);

		if (req.user.sid === sid) {
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
