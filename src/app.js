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

// ─── Security headers ──────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ──────────────────────────────────────────────────────────────────
// origin: '*' with credentials: true is a browser spec violation — browsers
// block credentialed requests to wildcard origins.
// Development: origin: true reflects the incoming Origin header back, which
// works with credentials and allows any local origin.
// Production: explicit whitelist from config, parsed at startup by Zod.
//
// Guard: if we are running in production and ALLOWED_ORIGINS is empty, every
// credentialed cross-origin request will be silently rejected by the browser.
// This is almost certainly a misconfiguration, not intentional — so we crash
// loudly at boot rather than serving a broken API for hours before anyone
// notices. It is far better to fail a deployment than to silently open a
// security gap or leave the frontend unable to authenticate.
if (config.NODE_ENV !== "development" && config.ALLOWED_ORIGINS.length === 0) {
	logger.fatal(
		"ALLOWED_ORIGINS is empty in a non-development environment. " +
			"Set ALLOWED_ORIGINS to a comma-separated list of allowed origins " +
			"(e.g. https://roomies.in,https://www.roomies.in) in your env file.",
	);
	process.exit(1);
}

app.use(
	cors({
		origin: config.NODE_ENV === "development" ? true : config.ALLOWED_ORIGINS,
		credentials: true,
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
