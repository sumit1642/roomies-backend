// src/middleware/contactRevealGate.js

import crypto from "crypto";
import { redis } from "../cache/client.js";

const COOKIE_NAME = "contactRevealAnonCount";
const MAX_FREE_REVEALS = 10;
const TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_REDIRECT_PATH = "/login/signup";

const anonFingerprint = (req) => {
	const ip = req.ip ?? "unknown-ip";
	const ua = req.get("user-agent") ?? "unknown-ua";

	return crypto.createHash("sha256").update(`${ip}|${ua}`).digest("hex");
};

const limitResponse = (res) =>
	res.status(401).json({
		status: "error",
		message: "Free contact reveal limit reached. Please log in or sign up to continue.",
		code: "CONTACT_REVEAL_LIMIT_REACHED",
		loginRedirect: LOGIN_REDIRECT_PATH,
	});

export const contactRevealGate = async (req, res, next) => {
	if (req.user?.isEmailVerified) {
		return next();
	}

	const cookieCount = Number.parseInt(req.cookies?.[COOKIE_NAME] ?? "0", 10);
	if (Number.isFinite(cookieCount) && cookieCount >= MAX_FREE_REVEALS) {
		return limitResponse(res);
	}

	const fingerprint = anonFingerprint(req);
	if (redis?.isOpen) {
		try {
			const redisKey = `contactRevealAnon:${fingerprint}`;
			const reveals = await redis.incr(redisKey);

			if (reveals === 1) {
				await redis.expire(redisKey, TTL_SECONDS);
			}

			if (reveals > MAX_FREE_REVEALS) {
				return limitResponse(res);
			}
		} catch {
			// Graceful fallback to cookie-only limiting if Redis is unavailable.
		}
	}

	const nextCount = Number.isFinite(cookieCount) ? cookieCount + 1 : 1;
	res.cookie(COOKIE_NAME, String(nextCount), {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		maxAge: TTL_SECONDS * 1000,
	});

	return next();
};
