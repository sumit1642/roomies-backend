import { Queue } from "bullmq";
import { logger } from "../logger/index.js";
import { bullConnection } from "./bullConnection.js";

const queues = new Map();

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
