// src/services/savedSearch.service.js

import { pool } from "../db/client.js";
import { logger } from "../logger/index.js";
import { AppError } from "../middleware/errorHandler.js";

const MAX_SAVED_SEARCHES_PER_USER = 10;

export const createSavedSearch = async (userId, { name, filters }) => {
	const { rows: countRows } = await pool.query(
		`SELECT COUNT(*)::int AS count FROM saved_searches WHERE user_id = $1 AND deleted_at IS NULL`,
		[userId],
	);

	if (countRows[0].count >= MAX_SAVED_SEARCHES_PER_USER) {
		throw new AppError(`You can save at most ${MAX_SAVED_SEARCHES_PER_USER} searches`, 422);
	}

	const { rows } = await pool.query(
		`INSERT INTO saved_searches (user_id, name, filters)
     VALUES ($1, $2, $3)
     RETURNING search_id, name, filters, last_alerted_at, created_at`,
		[userId, name, JSON.stringify(filters)],
	);

	logger.info({ userId, searchId: rows[0].search_id }, "Saved search created");
	return rows[0];
};

export const listSavedSearches = async (userId) => {
	const { rows } = await pool.query(
		`SELECT search_id, name, filters, last_alerted_at, created_at, updated_at
     FROM saved_searches
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
		[userId],
	);
	return rows;
};

export const deleteSavedSearch = async (userId, searchId) => {
	const { rowCount } = await pool.query(
		`UPDATE saved_searches SET deleted_at = NOW()
     WHERE search_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		[searchId, userId],
	);

	if (rowCount === 0) throw new AppError("Saved search not found", 404);

	logger.info({ userId, searchId }, "Saved search deleted");
	return { searchId, deleted: true };
};

export const updateSavedSearch = async (userId, searchId, updates) => {
	const setClauses = [];
	const values = [];
	let p = 1;

	if (updates.name !== undefined) {
		setClauses.push(`name = $${p}`);
		values.push(updates.name);
		p++;
	}
	if (updates.filters !== undefined) {
		setClauses.push(`filters = $${p}`);
		values.push(JSON.stringify(updates.filters));
		p++;
	}

	if (!setClauses.length) throw new AppError("No valid fields provided for update", 400);

	values.push(searchId, userId);

	const { rows } = await pool.query(
		`UPDATE saved_searches
     SET ${setClauses.join(", ")}
     WHERE search_id = $${p} AND user_id = $${p + 1} AND deleted_at IS NULL
     RETURNING search_id, name, filters, last_alerted_at, created_at, updated_at`,
		values,
	);

	if (!rows.length) throw new AppError("Saved search not found", 404);

	logger.info({ userId, searchId }, "Saved search updated");
	return rows[0];
};
