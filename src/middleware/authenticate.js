// src/middleware/authenticate.js

import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { AppError } from "./errorHandler.js";
import { findUserById } from "../db/utils/auth.js";

// Verifies the Bearer token, loads the user from DB, and attaches req.user.
// Any failure — missing header, bad token, expired, user not found, bad status —
// is a 401. The global error handler covers JsonWebTokenError and TokenExpiredError
// automatically; we only handle application-level checks here.

export const authenticate = async (req, res, next) => {
	try {
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith("Bearer ")) {
			return next(new AppError("No token provided", 401));
		}

		const token = authHeader.slice(7);

		let payload;
		try {
			payload = jwt.verify(token, config.JWT_SECRET);
		} catch (error) {
			// JsonWebTokenError and TokenExpiredError are re-thrown so the global
			// error handler can format them consistently (401 with standard messages).
			return next(error);
		}

		const user = await findUserById(payload.userId);
		if (!user) {
			return next(new AppError("User not found", 401));
		}

		const inactiveStatuses = new Set(["suspended", "banned", "deactivated"]);
		if (inactiveStatuses.has(user.account_status)) {
			return next(new AppError(`Account is ${user.account_status}`, 401));
		}

		req.user = {
			userId: user.user_id,
			email: user.email,
			roles: user.roles,
			isEmailVerified: user.is_email_verified,
			accountStatus: user.account_status,
		};
		next();
	} catch (error) {
		next(error);
	}
};
