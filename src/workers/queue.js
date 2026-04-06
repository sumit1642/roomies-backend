// src/workers/queue.js
// Named singleton registry for BullMQ Queue instances — prevents opening a new
// Redis connection on every enqueue call by reusing one Queue per queue name.

import { Queue } from "bullmq";
import { logger } from "../logger/index.js";
import { bullConnection } from "./bullConnection.js";

const queues = new Map();

// Returns the existing Queue instance for `name`, or creates and caches one on first call.
// All queues share the same Redis connection config sourced from bullConnection.js,
// which correctly handles ACL usernames, non-zero DB indices, and TLS.
export const getQueue = (name) => {
	if (queues.has(name)) return queues.get(name);

	const queue = new Queue(name, {
		connection: bullConnection,
		defaultJobOptions: {
			// Keep failed jobs in the failed set indefinitely so they can be inspected
			// and replayed manually — never silently discard unprocessed work.
			removeOnFail: false,
		},
	});

	queues.set(name, queue);
	return queue;
};

// Attempts to close every registered Queue, logging individual failures without
// aborting the others — then clears the registry and rethrows an aggregated error
// if any close failed, so the caller knows shutdown was not fully clean.
export const closeAllQueues = async () => {
	const entries = [...queues.values()];
	const results = await Promise.allSettled(entries.map((q) => q.close()));

	const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);

	// Clear the registry regardless of failures — the process is shutting down
	// and there's nothing useful to do with stale Queue references.
	queues.clear();

	if (errors.length > 0) {
		// Log each failure but don't prevent shutdown — a queue that failed to
		// close cleanly will have its Redis connection reaped when the process exits.
		errors.forEach((err) => {
			logger.error({ err }, "closeAllQueues: failed to close a queue");
		});
		// Re-throw an aggregated error so the caller (server.js shutdown hook)
		// can log that shutdown was not fully clean, without crashing.
		throw new Error(`${errors.length} queue(s) failed to close during shutdown`);
	}
};
