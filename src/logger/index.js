
import pino from "pino";
import { config } from "../config/env.js";

export const logger = pino({
	level: config.NODE_ENV === "production" ? "info" : "debug",

	
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
