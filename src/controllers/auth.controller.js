// src/controllers/auth.controller.js

import * as authService from "../services/auth.service.js";
import { parseTtlSeconds } from "../services/auth.service.js";
import { AppError } from "../middleware/errorHandler.js";
import { config } from "../config/env.js";

// ─── Cookie configuration ─────────────────────────────────────────────────────
//
// Both login and register use the same cookie options. Defined once here so a
// future change (e.g. adding a domain attribute) happens in one place only.
//
// httpOnly: true  — the cookie is invisible to JavaScript. document.cookie cannot
//                   read it. This is the primary XSS defence for token storage.
//
// secure: true in production — the browser will only send the cookie over HTTPS.
//         Disabled in development so plain HTTP (localhost) still works.
//
// sameSite: 'strict' — the browser only attaches the cookie when the request
//           originates from the same site. This blocks CSRF: a request triggered
//           from an attacker's page will not carry the cookie, so even if the
//           attacker knows the endpoint URL, they cannot forge authenticated
//           requests on behalf of a logged-in user.
//
// maxAge is set to match the JWT's own TTL (in milliseconds). This keeps the
// cookie and the token it carries in sync — when the JWT expires, the cookie
// expires too. Without maxAge, the cookie would be a session cookie and vanish
// when the browser tab closes, which would force re-login on every new tab.
//
// parseTtlSeconds returns seconds; cookie maxAge expects milliseconds.

const ACCESS_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: parseTtlSeconds(config.JWT_EXPIRES_IN) * 1000,
};

const REFRESH_COOKIE_OPTIONS = {
	httpOnly: true,
	secure: config.NODE_ENV === "production",
	sameSite: "strict",
	maxAge: parseTtlSeconds(config.JWT_REFRESH_EXPIRES_IN) * 1000,
};

// ─── Cookie helpers ───────────────────────────────────────────────────────────

// Sets both token cookies on the response. Called after register and login.
// Does NOT affect the JSON body — dual delivery is intentional: browser clients
// use the cookies (and ignore the body tokens), Android clients use the body
// tokens (and ignore the cookies). Same response, two different consumers.
const setAuthCookies = (res, accessToken, refreshToken) => {
	res.cookie("accessToken", accessToken, ACCESS_COOKIE_OPTIONS);
	res.cookie("refreshToken", refreshToken, REFRESH_COOKIE_OPTIONS);
};

// Clears both token cookies. maxAge:0 and expires in the past together ensure
// broad browser compatibility for cookie deletion — some clients respect one
// mechanism over the other.
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
		// Dual delivery: cookies for browsers, body for Android.
		// Neither client is broken by the other client's delivery mechanism being present.
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
		res.status(201).json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};

export const login = async (req, res, next) => {
	try {
		const tokens = await authService.login(req.body);
		// Same dual-delivery pattern as register.
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
		res.json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};

export const logout = async (req, res, next) => {
	try {
		await authService.logout(req.user.userId);
		// Clear cookies for browser clients. Android clients simply discard their
		// stored tokens — they do not rely on cookie clearing for logout.
		clearAuthCookies(res);
		res.json({ status: "success", message: "Logged out" });
	} catch (err) {
		next(err);
	}
};

export const refresh = async (req, res, next) => {
	try {
		// Resolve the refresh token from one of two sources:
		//   1. req.body.refreshToken  — Android sends it explicitly in the body
		//   2. req.cookies.refreshToken — browsers carry it in the HttpOnly cookie
		//
		// Body takes precedence: an Android client sending a body token should not
		// have a different cookie token substituted silently. In practice these two
		// client types never overlap, but making the priority explicit prevents
		// subtle bugs if they ever do.
		//
		// The "at least one source" check cannot live in Zod because Zod only sees
		// the body, not req.cookies. So it lives here, just before the service call.
		const incomingRefreshToken = req.body.refreshToken ?? req.cookies?.refreshToken;
		if (!incomingRefreshToken) {
			return next(new AppError("Refresh token is required", 401));
		}

		const result = await authService.refresh(incomingRefreshToken);
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

// ─── Google OAuth callback ────────────────────────────────────────────────────
//
// Receives a Google ID token from the client, verifies it, and returns auth
// tokens. All branching logic (returning user / new user / account linking)
// lives in authService.googleOAuth. The controller's only job is to call the
// service and apply the dual-delivery pattern consistently with all other auth
// endpoints: cookies for browsers, body for Android.
//
// No authenticate middleware on this route — it IS the authentication entry
// point. Placing authenticate here would create a circular dependency: the
// user needs a token to get a token.
export const googleCallback = async (req, res, next) => {
	try {
		const tokens = await authService.googleOAuth(req.body);
		setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
		res.json({ status: "success", data: tokens });
	} catch (err) {
		next(err);
	}
};
