// src/routes/auth.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { authLimiter, otpLimiter } from "../middleware/rateLimiter.js";
import {
	registerSchema,
	loginSchema,
	refreshSchema,
	logoutCurrentSchema,
	listSessionsSchema,
	revokeSessionSchema,
	otpVerifySchema,
	googleCallbackSchema,
} from "../validators/auth.validators.js";
import * as authController from "../controllers/auth.controller.js";

export const authRouter = Router();

// Rate limiter runs first — before validation and before any DB work —
// so abusive traffic is dropped at the router edge with zero downstream cost.
authRouter.post("/register", authLimiter, validate(registerSchema), authController.register);
authRouter.post("/login", authLimiter, validate(loginSchema), authController.login);

// /logout does NOT require authenticate because a client may call it with an
// expired access token — the whole point of logout is to revoke the refresh
// token from the HttpOnly cookie even when the access token is already expired.
// The controller reads the refresh token from req.body or req.cookies and the
// auth service validates it directly. A 401 from the access token must not
// block the user from logging out.
authRouter.post("/logout", validate(logoutCurrentSchema), authController.logout);

// /logout/current DOES require authenticate: this variant is explicitly tied
// to the currently authenticated session (the sid in the access token) so a
// valid access token is required to identify which session to revoke.
authRouter.post("/logout/current", authenticate, validate(logoutCurrentSchema), authController.logout);

authRouter.post("/logout/all", authenticate, authController.logoutAll);
authRouter.get("/sessions", authenticate, validate(listSessionsSchema), authController.listSessions);
authRouter.delete("/sessions/:sid", authenticate, validate(revokeSessionSchema), authController.revokeSession);

// refreshSchema now accepts an optional body — browser clients send no body and
// carry the token in the HttpOnly cookie.
authRouter.post("/refresh", authLimiter, validate(refreshSchema), authController.refresh);

// OTP send: stricter limit — each request triggers an outbound email.
// OTP verify: authenticate ensures a valid token is present; no extra limiter
// needed here because the service-layer attempt counter is the throttle.
authRouter.post("/otp/send", otpLimiter, authenticate, authController.sendOtp);
authRouter.post("/otp/verify", authenticate, validate(otpVerifySchema), authController.verifyOtp);
authRouter.get("/me", authenticate, authController.me);

// ─── Google OAuth callback ────────────────────────────────────────────────────
authRouter.post("/google/callback", authLimiter, validate(googleCallbackSchema), authController.googleCallback);
