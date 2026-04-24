

import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { findUserById } from "../db/utils/auth.js";

const INACTIVE_STATUSES = new Set(["suspended", "banned", "deactivated"]);

const extractToken = (req) => {
	const cookieToken = req.cookies?.accessToken;
	if (cookieToken) return cookieToken;

	const authHeader = req.headers.authorization;
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice(7);
	}

	return null;
};

export const optionalAuthenticate = async (req, res, next) => {
	try {
		const token = extractToken(req);
		if (!token) return next();

		let payload;
		try {
			payload = jwt.verify(token, config.JWT_SECRET);
		} catch {
			return next();
		}

		if (!payload?.userId) {
			return next();
		}

		const user = await findUserById(payload.userId);
		if (!user || INACTIVE_STATUSES.has(user.account_status)) {
			return next();
		}

		req.user = {
			userId: user.user_id,
			email: user.email,
			roles: user.roles ?? [],
			isEmailVerified: user.is_email_verified,
			accountStatus: user.account_status,
		};

		next();
	} catch (err) {
		next(err);
	}
};
