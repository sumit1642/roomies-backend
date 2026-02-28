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
