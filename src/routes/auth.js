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



authRouter.post("/register", authLimiter, validate(registerSchema), authController.register);
authRouter.post("/login", authLimiter, validate(loginSchema), authController.login);







authRouter.post("/logout", validate(logoutCurrentSchema), authController.logout);




authRouter.post("/logout/current", authenticate, validate(logoutCurrentSchema), authController.logout);

authRouter.post("/logout/all", authLimiter, authenticate, authController.logoutAll);
authRouter.get("/sessions", authLimiter, authenticate, validate(listSessionsSchema), authController.listSessions);
authRouter.delete(
	"/sessions/:sid",
	authLimiter,
	authenticate,
	validate(revokeSessionSchema),
	authController.revokeSession,
);



authRouter.post("/refresh", authLimiter, validate(refreshSchema), authController.refresh);




authRouter.post("/otp/send", otpLimiter, authenticate, authController.sendOtp);
authRouter.post("/otp/verify", authenticate, validate(otpVerifySchema), authController.verifyOtp);
authRouter.get("/me", authenticate, authController.me);

authRouter.post("/google/callback", authLimiter, validate(googleCallbackSchema), authController.googleCallback);
