// src/workers/queue.js
//
// BullMQ Queue singleton registry.
//
// WHY THIS FILE EXISTS:
// BullMQ's Queue class represents a connection to a Redis-backed queue. Creating
// a new Queue instance is cheap in terms of CPU but each instance opens its own
// Redis connection (or borrows one from a connection pool depending on the ioredis
// config). Creating a new Queue('media-processing') on every call to
// enqueuePhotoUpload() would open a new Redis connection on every HTTP request —
// under load this rapidly exhausts the Redis connection limit.
//
// This module maintains a Map of queue name → Queue instance. The first call to
// getQueue('media-processing') creates the Queue and stores it. Every subsequent
// call returns the same instance. Effectively a named singleton registry.
//
// The Queue constructor receives a connection config object rather than a shared
// ioredis instance because BullMQ manages its own subscriber connections
// internally and recommends this pattern in its documentation. The Redis
// connection details come from environment variables through the same config
// system used by the rest of the project.

import { Queue } from "bullmq";

const queues = new Map();

// Returns the Queue instance for the given name, creating it on first call.
// All queues in this project share the same Redis connection config.
export const getQueue = (name) => {
	if (queues.has(name)) return queues.get(name);

	const queue = new Queue(name, {
		connection: {
			host: process.env.REDIS_HOST ?? "localhost",
			port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
			password: process.env.REDIS_PASSWORD ?? undefined,
		},
		defaultJobOptions: {
			// Jobs that fail all retry attempts are moved to the failed set.
			// They remain there until manually replayed or deleted. This is
			// the correct behaviour for photo processing failures — an admin
			// can inspect the failed job's data to understand what went wrong.
			removeOnFail: false,
		},
	});

	queues.set(name, queue);
	return queue;
};

// Graceful shutdown: close all open Queue connections.
// Called by server.js during SIGTERM handling, before Redis disconnects.
export const closeAllQueues = async () => {
	const closePromises = [...queues.values()].map((q) => q.close());
	await Promise.all(closePromises);
	queues.clear();
};
