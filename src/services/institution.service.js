// src/services/institution.service.js
//
// Admin-only CRUD for institutions. Institutions drive auto-verification of
// student accounts by email domain — see db/utils/institutions.js's
// findInstitutionByDomain(), called from auth.service.js's register() and
// googleOAuth(). "Deactivate" is modeled as the existing soft-delete
// (deleted_at), consistent with every other entity in this codebase and
// with findInstitutionByDomain()'s own `AND deleted_at IS NULL` filter —
// no new is_active column needed, deactivation already takes effect
// immediately for future registrations.

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";
import { cursorText, clampLimit, buildPage } from "../db/utils/pagination.js";

const toCamelCase = (row) => ({
	institutionId: row.institution_id,
	name: row.name,
	city: row.city,
	state: row.state,
	emailDomain: row.email_domain,
	type: row.type,
	isActive: row.deleted_at === null,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	deactivatedAt: row.deleted_at,
});

export const createInstitution = async (adminUserId, { name, city, state, emailDomain, type }) => {
	let rows;
	try {
		({ rows } = await pool.query(
			`INSERT INTO institutions (name, city, state, email_domain, type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING institution_id, name, city, state, email_domain, type, created_at, updated_at, deleted_at`,
			[name, city, state, emailDomain, type ?? null],
		));
	} catch (err) {
		if (err.code === "23505") {
			// idx_institutions_email_domain is a partial unique index (deleted_at IS NULL) —
			// this fires either for a genuinely active duplicate, or a re-add of a
			// domain that still has an active row. A deactivated institution with
			// the same domain does NOT block this (partial index excludes it).
			throw new AppError(`An active institution with email domain '${emailDomain}' already exists`, 409);
		}
		throw err;
	}

	const institution = rows[0];

	logger.info(
		{ adminUserId, institutionId: institution.institution_id, emailDomain, action: "institution.create" },
		"Admin created institution",
	);

	return toCamelCase(institution);
};

export const getInstitution = async (institutionId) => {
	const { rows } = await pool.query(
		`SELECT institution_id, name, city, state, email_domain, type, created_at, updated_at, deleted_at
     FROM institutions
     WHERE institution_id = $1`,
		[institutionId],
	);

	if (!rows.length) {
		throw new AppError("Institution not found", 404);
	}

	return toCamelCase(rows[0]);
};

export const listInstitutions = async (filters) => {
	const {
		city,
		state,
		emailDomain,
		includeDeactivated = false,
		cursorTime,
		cursorId,
		limit: rawLimit = 20,
	} = filters;
	const limit = clampLimit(rawLimit);

	const clauses = [];
	const params = [];
	let p = 1;

	if (!includeDeactivated) {
		clauses.push(`deleted_at IS NULL`);
	}

	if (city !== undefined) {
		clauses.push(`LOWER(city) = LOWER($${p})`);
		params.push(city);
		p++;
	}

	if (state !== undefined) {
		clauses.push(`LOWER(state) = LOWER($${p})`);
		params.push(state);
		p++;
	}

	if (emailDomain !== undefined) {
		clauses.push(`LOWER(email_domain) LIKE LOWER($${p}) ESCAPE '\\'`);
		params.push(`${emailDomain.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
		p++;
	}

	const hasCursor = cursorTime !== undefined && cursorId !== undefined;
	if (hasCursor) {
		clauses.push(
			`(created_at < $${p}::timestamptz OR (created_at = $${p}::timestamptz AND institution_id > $${p + 1}::uuid))`,
		);
		params.push(cursorTime, cursorId);
		p += 2;
	}

	params.push(limit + 1);
	const limitParam = p;

	const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

	const { rows } = await pool.query(
		`SELECT institution_id, name, city, state, email_domain, type, created_at, updated_at, deleted_at,
       ${cursorText("created_at")} AS cursor_created_at
     FROM institutions
     ${whereClause}
     ORDER BY created_at DESC, institution_id ASC
     LIMIT $${limitParam}`,
		params,
	);

	const { items, nextCursor } = buildPage(rows, limit, {
		timeKey: "cursor_created_at",
		idKey: "institution_id",
	});

	return { items: items.map(toCamelCase), nextCursor };
};

export const updateInstitution = async (adminUserId, institutionId, updates) => {
	const columnMap = {
		name: "name",
		city: "city",
		state: "state",
		emailDomain: "email_domain",
		type: "type",
	};

	const setClauses = [];
	const values = [];
	let p = 1;

	for (const [key, column] of Object.entries(columnMap)) {
		if (updates[key] !== undefined) {
			setClauses.push(`${column} = $${p}`);
			values.push(updates[key]);
			p++;
		}
	}

	if (!setClauses.length) {
		throw new AppError("No valid fields provided for update", 400);
	}

	values.push(institutionId);

	let rows;
	try {
		({ rows } = await pool.query(
			`UPDATE institutions
       SET ${setClauses.join(", ")}, updated_at = NOW()
       WHERE institution_id = $${p}
         AND deleted_at IS NULL
       RETURNING institution_id, name, city, state, email_domain, type, created_at, updated_at, deleted_at`,
			values,
		));
	} catch (err) {
		if (err.code === "23505") {
			throw new AppError(`An active institution with email domain '${updates.emailDomain}' already exists`, 409);
		}
		throw err;
	}

	if (!rows.length) {
		const { rows: existRows } = await pool.query(`SELECT deleted_at FROM institutions WHERE institution_id = $1`, [
			institutionId,
		]);
		if (!existRows.length) {
			throw new AppError("Institution not found", 404);
		}
		throw new AppError("Cannot update a deactivated institution — reactivate it first", 409);
	}

	logger.info({ adminUserId, institutionId, action: "institution.update" }, "Admin updated institution");

	return toCamelCase(rows[0]);
};

export const deactivateInstitution = async (adminUserId, institutionId) => {
	const { rows } = await pool.query(
		`UPDATE institutions
     SET deleted_at = NOW()
     WHERE institution_id = $1
       AND deleted_at IS NULL
     RETURNING institution_id, name, city, state, email_domain, type, created_at, updated_at, deleted_at`,
		[institutionId],
	);

	if (!rows.length) {
		const { rows: existRows } = await pool.query(`SELECT deleted_at FROM institutions WHERE institution_id = $1`, [
			institutionId,
		]);
		if (!existRows.length) {
			throw new AppError("Institution not found", 404);
		}
		throw new AppError("Institution is already deactivated", 422);
	}

	logger.info({ adminUserId, institutionId, action: "institution.deactivate" }, "Admin deactivated institution");

	return toCamelCase(rows[0]);
};

export const reactivateInstitution = async (adminUserId, institutionId) => {
	let rows;
	try {
		({ rows } = await pool.query(
			`UPDATE institutions
       SET deleted_at = NULL
       WHERE institution_id = $1
         AND deleted_at IS NOT NULL
       RETURNING institution_id, name, city, state, email_domain, type, created_at, updated_at, deleted_at`,
			[institutionId],
		));
	} catch (err) {
		if (err.code === "23505") {
			// Reactivating would collide with another active row sharing the same
			// email_domain (the partial unique index only excludes deleted rows).
			throw new AppError("Cannot reactivate — another active institution already uses this email domain", 409);
		}
		throw err;
	}

	if (!rows.length) {
		const { rows: existRows } = await pool.query(`SELECT deleted_at FROM institutions WHERE institution_id = $1`, [
			institutionId,
		]);
		if (!existRows.length) {
			throw new AppError("Institution not found", 404);
		}
		throw new AppError("Institution is already active", 422);
	}

	logger.info({ adminUserId, institutionId, action: "institution.reactivate" }, "Admin reactivated institution");

	return toCamelCase(rows[0]);
};
