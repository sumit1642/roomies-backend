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
// In development, allow any origin. Lock this down in production.
app.use(
	cors({
		origin: config.NODE_ENV === "development" ? "*" : process.env.ALLOWED_ORIGINS?.split(","),
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
// Only active when STORAGE_ADAPTER=local.
// In production, files are served directly from Azure Blob Storage URLs.
if (config.STORAGE_ADAPTER === "local") {
	app.use("/uploads", express.static("uploads"));
}

// ─── API routes ────────────────────────────────────────────────────────────
app.use("/api/v1", rootRouter);

// ─── 404 handler ───────────────────────────────────────────────────────────
// Catches any request that didn't match a route above.
app.use((req, res) => {
	res.status(404).json({
		status: "error",
		message: `Route ${req.method} ${req.url} not found`,
	});
});

// ─── Global error handler ──────────────────────────────────────────────────
// Must be last. Catches everything passed to next(err) from any route.
app.use(errorHandler);
