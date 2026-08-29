// src/validators/adminDashboard.validators.js

import { z } from "zod";

export const getDashboardStatsSchema = z.object({
	query: z.object({
		// Caps at 90 in the service layer regardless of what's requested here;
		// the upper bound is enforced twice deliberately — once at the edge
		// (fast 400 instead of silently clamping) and once defensively in the
		// service (in case this validator is ever bypassed by a future caller).
		recentDays: z.coerce.number().int().min(1).max(90).default(7),
	}),
});
