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

app.use(
	helmet({
		crossOriginResourcePolicy: { policy: "cross-origin" },
	}),
);

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
			if (!origin) return callback(null, true);

			if (config.NODE_ENV === "development") {
				return callback(null, true);
			}

			if (config.ALLOWED_ORIGINS.includes(origin)) {
				return callback(null, true);
			}

			callback(new Error(`CORS: origin '${origin}' is not allowed`));
		},

		credentials: true,

		exposedHeaders: ["X-Request-Id"],
	}),
);

app.use(pinoHttp({ logger }));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (config.STORAGE_ADAPTER === "local") {
	app.use("/uploads", express.static("uploads"));
}

app.use("/api/v1", rootRouter);

app.use((req, res) => {
	res.status(404).json({
		status: "error",
		message: `Route ${req.method} ${req.url} not found`,
	});
});

app.use(errorHandler);
