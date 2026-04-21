// src/app.js

import express from "express";
import helmet from "helmet";
import cors from "cors";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import { logger } from "./logger/index.js";
import { rootRouter } from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { config } from "./config/env.js";

export const app = express();

app.set("trust proxy", config.TRUST_PROXY);

// ─── Security headers ──────────────────────────────────────────────────────
// Relax helmet's default restrictions for cross-origin API access.
// The frontend needs to read response bodies from a different origin.
app.use(
	helmet({
		crossOriginResourcePolicy: { policy: "cross-origin" },
	}),
);

// ─── CORS ──────────────────────────────────────────────────────────────────
//
// Cross-origin cookie rules (for reference):
//   sameSite: "none" + secure: true  → browser sends cookies cross-site
//   sameSite: "strict"               → browser NEVER sends cookies cross-site
//   sameSite: "lax"                  → only sent on top-level GET navigations
//
// Since our frontend is on a different domain from the backend, we need:
//   1. credentials: true             → sends Access-Control-Allow-Credentials
//   2. An explicit origin (not "*")  → required when credentials: true
//   3. Cookies set with sameSite: "none" + secure (handled in authenticate.js)
//
// In development: origin: true reflects the incoming Origin header — works for
//   any localhost port.
// In production: explicit allowlist from ALLOWED_ORIGINS.

if (config.NODE_ENV !== "development" && config.ALLOWED_ORIGINS.length === 0) {
	logger.fatal(
		"ALLOWED_ORIGINS is empty in a non-development environment. " +
			"Set ALLOWED_ORIGINS to a comma-separated list of allowed origins " +
			"(e.g. https://roomies-lilac.vercel.app) in your env file.",
	);
	process.exit(1);
}

app.use(
	cors({
		origin: (origin, callback) => {
			// Allow requests with no origin (Postman, curl, server-to-server)
			if (!origin) return callback(null, true);

			if (config.NODE_ENV === "development") {
				// In development, allow any origin (localhost on any port)
				return callback(null, true);
			}

			// In production, check against the explicit allowlist
			if (config.ALLOWED_ORIGINS.includes(origin)) {
				return callback(null, true);
			}

			callback(new Error(`CORS: origin '${origin}' is not allowed`));
		},
		// credentials: true is REQUIRED for cross-origin cookies AND for the
		// browser to expose response headers/body on credentialed requests.
		credentials: true,
		// Expose headers the frontend may need to read
		exposedHeaders: ["X-Request-Id"],
	}),
);

// ─── Request logging ───────────────────────────────────────────────────────
app.use(pinoHttp({ logger }));

// ─── Body parsing ──────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Static files (local uploads in dev) ───────────────────────────────────
if (config.STORAGE_ADAPTER === "local") {
	app.use("/uploads", express.static("uploads"));
}

// ─── API routes ────────────────────────────────────────────────────────────
app.use("/api/v1", rootRouter);

// ─── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
	res.status(404).json({
		status: "error",
		message: `Route ${req.method} ${req.url} not found`,
	});
});

// ─── Global error handler ──────────────────────────────────────────────────
app.use(errorHandler);
