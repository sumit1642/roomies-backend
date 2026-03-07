// src/workers/queue.js
// Fixed: BullMQ Queue connection now derives host/port/tls from config.REDIS_URL instead of manual env vars.

import { Queue } from "bullmq";
import { logger } from "../logger/index.js";
import { config } from "../config/env.js";

const queues = new Map();

const redisConnection = new URL(config.REDIS_URL);
const bullConnection = {
	host: redisConnection.hostname,
	port: parseInt(redisConnection.port || "6379", 10),
	password: redisConnection.password || undefined,
	tls: redisConnection.protocol === "rediss:" ? {} : undefined,
};

export const getQueue = (name) => {
	if (queues.has(name)) return queues.get(name);

	const queue = new Queue(name, {
		connection: bullConnection,
		defaultJobOptions: {
			removeOnFail: false,
		},
	});

	queues.set(name, queue);
	return queue;
};

export const closeAllQueues = async () => {
	const entries = [...queues.values()];
	const results = await Promise.allSettled(entries.map((q) => q.close()));

	const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);

	queues.clear();

	if (errors.length > 0) {
		errors.forEach((err) => {
			logger.error({ err }, "closeAllQueues: failed to close a queue");
		});
		throw new Error(`${errors.length} queue(s) failed to close during shutdown`);
	}
};
