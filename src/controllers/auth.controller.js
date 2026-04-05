// src/controllers/auth.controller.js

import * as authService from "../services/auth.service.js";
import { parseTtlSeconds } from "../services/auth.service.js";
import { AppError } from "../middleware/errorHandler.js";
import { config } from "../config/env.js";

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

// Determines whether the caller is a non-browser client that manages its own
// token lifecycle (e.g. the Android app). When true, tokens are included in the
// JSON response body. When false, tokens are delivered only via HttpOnly cookies
// and the body contains only safe session metadata.
//
// Browser clients using cookies gain no benefit from receiving raw tokens in the
// body — they cannot read HttpOnly cookies from JavaScript anyway, and including
// the tokens in JSON directly undermines the XSS protection that HttpOnly provides
// by giving any script on the page an additional exfiltration surface.
//
// Android clients set X-Client-Transport: bearer to signal that they are managing
// tokens explicitly and expect them in the response body.
const isBearerTransport = (req) => req.headers["x-client-transport"] === "bearer";

// Builds the safe body payload for cookie-mode responses. Contains everything
// the browser UI needs (user identity, roles, verification state) without
// exposing the raw token strings that only the HttpOnly cookie transport should
// carry. The sid is included so the client can reference the current session
// (e.g. for the session management UI) without needing the token itself.
const buildSafeBody = (tokens) => ({
	user: tokens.user,
	sid: tokens.sid,
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export const register = async (req, res, next) => {
	try {
		const tokens = await authService.register(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

		const data = isBearerTransport(req) ? tokens : buildSafeBody(tokens);
		res.status(201).json({ status: "success", data });
	} catch (err) {
		next(err);
	}
};

export const login = async (req, res, next) => {
	try {
		const tokens = await authService.login(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

		const data = isBearerTransport(req) ? tokens : buildSafeBody(tokens);
		res.json({ status: "success", data });
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
		if (!req.user?.sid) {
			return next(new AppError("Authenticated session is missing", 401));
		}
		await authService.logoutCurrent(req.user.userId, incomingRefreshToken, req.user.sid);
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

		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

		const data = isBearerTransport(req) ? tokens : buildSafeBody(tokens);
		res.json({ status: "success", data });
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

		const data = isBearerTransport(req) ? tokens : buildSafeBody(tokens);
		res.json({ status: "success", data });
	} catch (err) {
		next(err);
	}
};
