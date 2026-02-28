// src/routes/auth.js

import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { registerSchema, loginSchema, refreshSchema, otpVerifySchema } from "../validators/auth.validators.js";
import * as authController from "../controllers/auth.controller.js";

export const authRouter = Router();

authRouter.post("/register", validate(registerSchema), authController.register);
authRouter.post("/login", validate(loginSchema), authController.login);
authRouter.post("/logout", authenticate, authController.logout);
authRouter.post("/refresh", validate(refreshSchema), authController.refresh);
authRouter.post("/otp/send", authenticate, authController.sendOtp);
authRouter.post("/otp/verify", authenticate, validate(otpVerifySchema), authController.verifyOtp);
authRouter.get("/me", authenticate, authController.me);
