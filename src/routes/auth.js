// src/routes/auth.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { authLimiter, otpLimiter } from "../middleware/rateLimiter.js";
import { registerSchema, loginSchema, refreshSchema, otpVerifySchema } from "../validators/auth.validators.js";
import * as authController from "../controllers/auth.controller.js";

export const authRouter = Router();

// Rate limiter runs first — before validation and before any DB work —
// so abusive traffic is dropped at the router edge with zero downstream cost.
authRouter.post("/register", authLimiter, validate(registerSchema), authController.register);
authRouter.post("/login", authLimiter, validate(loginSchema), authController.login);
authRouter.post("/logout", authenticate, authController.logout);
authRouter.post("/refresh", authLimiter, validate(refreshSchema), authController.refresh);

// OTP send: stricter limit — each request triggers an outbound email.
// OTP verify: authenticate ensures a valid token is present; no extra limiter
// needed here because the service-layer attempt counter (5 wrong attempts → lock)
// already provides the necessary throttle at the OTP level.
authRouter.post("/otp/send", otpLimiter, authenticate, authController.sendOtp);
authRouter.post("/otp/verify", authenticate, validate(otpVerifySchema), authController.verifyOtp);
authRouter.get("/me", authenticate, authController.me);
