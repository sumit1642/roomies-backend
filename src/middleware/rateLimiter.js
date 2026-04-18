// src/middleware/rateLimiter.js
//
// All rate limiters live here — one import location for every route file.
//
// ─── DISTRIBUTED STORE ───────────────────────────────────────────────────────
//
// Uses rate-limit-redis so counters are shared across all Node instances.
// passOnStoreError: true on all limiters — Redis unavailability degrades to no
// rate limiting rather than blocking all requests.
//
// ─── SHUTDOWN ────────────────────────────────────────────────────────────────
//
// The dedicated Redis client opened here is never used elsewhere, so it must
// be explicitly closed during graceful shutdown. Export closeRateLimitRedisClient
// and call it in server.js before process.exit(0). Without this the socket stays
// open and Node will not exit cleanly.

import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

// ─── Dedicated Redis client for rate limiting ─────────────────────────────────
const rateLimitRedisClient = createClient({
	url: config.REDIS_URL,
	socket: {
		connectTimeout: 5_000,
		keepAlive: 5_000,
		reconnectStrategy: (retries) => {
			if (retries >= 5) {
				logger.warn(
					"Rate limit Redis: max reconnect attempts reached — rate limiting is disabled, requests will be allowed through",
				);
				return new Error("Rate limit Redis reconnect failed");
			}
			return Math.min(100 * Math.pow(2, retries), 3_000);
		},
	},
});

rateLimitRedisClient.on("error", (err) => {
	logger.warn(
		{ err: err.message },
		"Rate limit Redis client error — rate limiting is disabled, requests will be allowed through",
	);
});

rateLimitRedisClient.connect().catch((err) => {
	logger.error(
		{ err: err.message },
		"Rate limit Redis: failed to connect on startup — rate limiting is disabled, requests will be allowed through. " +
			"Ensure REDIS_URL is correct and Redis is reachable.",
	);
});

// ─── Close helper for graceful shutdown ───────────────────────────────────────
//
// Call this from server.js during shutdown (before process.exit) so the socket
// is released and Node exits cleanly. Errors are caught and logged; this function
// never throws so it cannot interrupt the shutdown sequence.
export const closeRateLimitRedisClient = async () => {
	try {
		if (rateLimitRedisClient.isOpen) {
			await rateLimitRedisClient.quit();
			logger.info("Rate limit Redis client closed");
		}
	} catch (err) {
		logger.error({ err: err.message }, "Rate limit Redis: error during close — ignoring");
	}
};

// ─── Shared Redis store factory ───────────────────────────────────────────────
const makeRedisStore = (prefix) =>
	new RedisStore({
		sendCommand: (...args) => rateLimitRedisClient.sendCommand(args),
		prefix,
	});

// ─── OTP send — strictest ────────────────────────────────────────────────────
export const otpLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 5,
	standardHeaders: true,
	legacyHeaders: false,
	store: makeRedisStore("rl:otp:"),
	passOnStoreError: true,
	message: {
		status: "error",
		message: "Too many OTP requests — please wait 15 minutes before trying again",
	},
});

// ─── Auth endpoints — register / login / refresh ─────────────────────────────
export const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 10,
	standardHeaders: true,
	legacyHeaders: false,
	store: makeRedisStore("rl:auth:"),
	passOnStoreError: true,
	message: {
		status: "error",
		message: "Too many requests — please wait 15 minutes before trying again",
	},
});

// ─── Public rating reads — anti-enumeration / anti-scraping ────────────────
// Applied on unauthenticated public endpoints under /ratings/user/:userId and
// /ratings/property/:propertyId to reduce aggressive scraping while keeping
// normal browsing traffic unaffected.
export const publicRatingsLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 120,
	standardHeaders: true,
	legacyHeaders: false,
	store: makeRedisStore("rl:ratings:public:"),
	passOnStoreError: true,
	message: {
		status: "error",
		message: "Too many rating lookup requests — please wait a few minutes before trying again",
	},
});
