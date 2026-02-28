// src/middleware/rateLimiter.js
//
// All rate limiters live here — one import location for every route file.
// Configured with standardHeaders:true so clients receive RateLimit-* headers
// (RFC 6585) and legacyHeaders:false so the old X-RateLimit-* headers are not
// sent (they are non-standard and just add noise).
//
// These limiters are IP-based by default (keyGenerator uses req.ip).
// In production behind Azure Front Door, ensure trust proxy is set in app.js
// so req.ip reflects the real client IP, not the load balancer.
//
// Limiter hierarchy (strictest to most permissive):
//   otpLimiter      — 5 requests / 15 min  (OTP send — most abusable endpoint)
//   authLimiter     — 10 requests / 15 min (register, login, refresh)

import rateLimit from "express-rate-limit";

// ─── OTP send — strictest ────────────────────────────────────────────────────
// Sending an OTP triggers an outbound email. 5 per 15-minute window per IP is
// generous enough for legitimate use (a user hitting "resend" a few times)
// and tight enough to make automated abuse expensive.
export const otpLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 5,
	standardHeaders: true,
	legacyHeaders: false,
	message: {
		status: "error",
		message: "Too many OTP requests — please wait 15 minutes before trying again",
	},
});

// ─── Auth endpoints — register / login / refresh ─────────────────────────────
// 10 per 15 minutes is tight enough to slow credential stuffing but does not
// frustrate a real user who fat-fingers their password a few times.
export const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 10,
	standardHeaders: true,
	legacyHeaders: false,
	message: {
		status: "error",
		message: "Too many requests — please wait 15 minutes before trying again",
	},
});
