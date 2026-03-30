// src/middleware/rateLimiter.js
//
// All rate limiters live here — one import location for every route file.
// Configured with standardHeaders:true so clients receive RateLimit-* headers
// (RFC 6585) and legacyHeaders:false so the old X-RateLimit-* headers are not
// sent (they are non-standard and just add noise).
//
// ─── DISTRIBUTED STORE ───────────────────────────────────────────────────────
//
// The default express-rate-limit store is in-memory and process-local. In a
// horizontally scaled deployment (multiple Node instances on Azure App Service,
// or multiple pods in Kubernetes), each instance would keep its own counter,
// meaning the effective rate limit is multiplied by the instance count and
// becomes completely unpredictable. An attacker on a 4-instance deployment
// could send 4× the intended requests before hitting any limit.
//
// We fix this by using rate-limit-redis, which persists counters in the same
// Redis instance already used for session tokens and BullMQ. All instances
// share one set of counters, so the configured limits are exact regardless of
// horizontal scale.
//
// The Redis connection options are parsed from the validated config REDIS_URL
// rather than from process.env directly, consistent with the project convention.
// We intentionally do NOT import the already-connected `redis` singleton from
// src/cache/client.js — RedisStore from rate-limit-redis creates its own
// connection from the URL. This keeps rate limiting decoupled from the main
// client lifecycle and prevents a limiter-side error from affecting session
// management.
//
// Limiter hierarchy (strictest to most permissive):
//   otpLimiter      — 5 requests / 15 min  (OTP send — most abusable endpoint)
//   authLimiter     — 10 requests / 15 min (register, login, refresh)

import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { config } from "../config/env.js";
import { logger } from "../logger/index.js";

// ─── Dedicated Redis client for rate limiting ─────────────────────────────────
//
// We create a fresh client here rather than importing the shared singleton.
// The shared client in src/cache/client.js has a reconnect strategy designed
// for long-lived session/queue operations. If the rate-limit store's client
// ever errors, we want to fail open (let the request through with a warning)
// rather than fail closed, since a Redis blip during high traffic shouldn't
// lock all users out of authentication. The failure handling below achieves
// this by catching the store error event and logging rather than crashing.
const rateLimitRedisClient = createClient({
	url: config.REDIS_URL,
	socket: {
		connectTimeout: 5_000,
		keepAlive: 5_000,
		// Modest reconnect strategy — rate limiters can tolerate brief outages.
		reconnectStrategy: (retries) => {
			if (retries >= 5) {
				logger.warn(
					"Rate limit Redis: max reconnect attempts reached — rate limiting will degrade to in-memory",
				);
				return new Error("Rate limit Redis reconnect failed");
			}
			return Math.min(100 * Math.pow(2, retries), 3_000);
		},
	},
});

rateLimitRedisClient.on("error", (err) => {
	// Log the error but do not crash. express-rate-limit's RedisStore has a
	// `sendCommand` interface that will throw when Redis is down, which causes
	// the limiter to fall back to allowing requests rather than blocking them.
	// This is the correct degradation mode: availability over strict enforcement.
	logger.warn({ err: err.message }, "Rate limit Redis client error — rate limiting may be degraded");
});

// Connect the dedicated client. Failures here are non-fatal; if connect() fails,
// the RedisStore will fail on every sendCommand call and express-rate-limit will
// log/skip the store operation, letting requests through (fail-open behaviour).
rateLimitRedisClient.connect().catch((err) => {
	logger.error(
		{ err: err.message },
		"Rate limit Redis: failed to connect on startup — rate limiting will fall back to in-memory store. " +
			"Ensure REDIS_URL is correct and Redis is reachable.",
	);
});

// ─── Shared Redis store factory ───────────────────────────────────────────────
//
// Each limiter gets its own store instance so their counters are namespaced
// separately in Redis. The `prefix` option ensures OTP keys and auth keys
// never collide, which would cause one limiter's counter to affect the other.
//
// Rate limiting keys are stored as Redis strings with TTL managed by Redis
// itself, so they expire automatically without any cleanup cron.
const makeRedisStore = (prefix) =>
	new RedisStore({
		// sendCommand is the interface RedisStore uses to issue raw Redis commands.
		// We route through our dedicated client. If the client is disconnected,
		// sendCommand will throw and express-rate-limit will skip the store check
		// (fail-open), allowing the request through.
		sendCommand: (...args) => rateLimitRedisClient.sendCommand(args),
		prefix,
	});

// ─── OTP send — strictest ────────────────────────────────────────────────────
// Sending an OTP triggers an outbound email. 5 per 15-minute window per IP is
// generous enough for legitimate use (a user hitting "resend" a few times)
// and tight enough to make automated abuse expensive.
export const otpLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 5,
	standardHeaders: true,
	legacyHeaders: false,
	// Each IP gets its own key in Redis under the "rl:otp:" namespace.
	store: makeRedisStore("rl:otp:"),
	// Intentional fail-open for auth availability; abuse protection degrades
	// temporarily if Redis is unavailable.
	passOnStoreError: true,
	// keyGenerator defaults to req.ip, which is correct since app.js sets
	// trust proxy to 1 in production so req.ip reflects the real client IP.
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
	store: makeRedisStore("rl:auth:"),
	// Intentional fail-open for auth availability; abuse protection degrades
	// temporarily if Redis is unavailable.
	passOnStoreError: true,
	message: {
		status: "error",
		message: "Too many requests — please wait 15 minutes before trying again",
	},
});
