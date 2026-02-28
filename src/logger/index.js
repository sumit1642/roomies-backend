// src/logger/index.js
import pino from "pino";
import { config } from "../config/env.js";

export const logger = pino({
	level: config.NODE_ENV === "production" ? "info" : "debug",

	// pino-pretty only in development — production needs raw JSON for log aggregators
	transport:
		config.NODE_ENV !== "production" ?
			{
				target: "pino-pretty",
				options: {
					colorize: true,
					translateTime: "SYS:HH:MM:ss",
					ignore: "pid,hostname",
				},
			}
		:	undefined,
});
