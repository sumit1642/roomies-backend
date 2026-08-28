// src/validators/institution.validators.js
//
// Admin-only institution management. Institutions drive auto-verification
// of student accounts by email domain (see auth.service.js's register() and
// googleOAuth() — both call findInstitutionByDomain() and flip
// is_email_verified straight to TRUE on a match). There is currently no
// public or student-facing institution endpoint; every route here is gated
// by requireAdmin in institution.js.

import { z } from "zod";
import { buildKeysetPaginationQuerySchema } from "./pagination.validators.js";

const emailDomainSchema = z
	.string({ error: "emailDomain is required" })
	.trim()
	.toLowerCase()
	.min(3, { error: "emailDomain must be at least 3 characters" })
	.max(100)
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
		error: "emailDomain must be a valid domain (e.g. college.edu), without '@' or a leading protocol",
	});

export const institutionParamsSchema = z.object({
	params: z.object({
		institutionId: z.uuid({ error: "Invalid institution ID" }),
	}),
});

export const listInstitutionsSchema = z.object({
	query: buildKeysetPaginationQuerySchema({
		city: z.string().trim().min(1).max(100).optional(),
		state: z.string().trim().min(1).max(100).optional(),
		emailDomain: z.string().trim().min(1).max(100).optional(),
		includeDeactivated: z.coerce.boolean().default(false),
	}),
});

export const createInstitutionSchema = z.object({
	body: z.object({
		name: z
			.string({ error: "name is required" })
			.trim()
			.min(2, { error: "name must be at least 2 characters" })
			.max(255),
		city: z.string({ error: "city is required" }).trim().min(2, { error: "city is required" }).max(100),
		state: z.string({ error: "state is required" }).trim().min(2, { error: "state is required" }).max(100),
		emailDomain: emailDomainSchema,
		type: z.string().trim().max(50).optional(),
	}),
});

export const updateInstitutionSchema = z.object({
	params: z.object({
		institutionId: z.uuid({ error: "Invalid institution ID" }),
	}),
	body: z
		.object({
			name: z.string().trim().min(2).max(255).optional(),
			city: z.string().trim().min(2).max(100).optional(),
			state: z.string().trim().min(2).max(100).optional(),
			emailDomain: emailDomainSchema.optional(),
			type: z.string().trim().max(50).optional(),
		})
		.refine((data) => Object.keys(data).length > 0, {
			error: "At least one field must be provided for update",
		}),
});
