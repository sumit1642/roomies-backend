
















import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";


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






export const closeRateLimitRedisClient = async () => {
	try {
		await rateLimitRedisClient.quit();
		logger.info("Rate limit Redis client closed");
	} catch (err) {
		logger.error({ err: err.message }, "Rate limit Redis: error during close — ignoring");
	}
};


const makeRedisStore = (prefix) =>
	new RedisStore({
		sendCommand: (...args) => rateLimitRedisClient.sendCommand(args),
		prefix,
	});


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
