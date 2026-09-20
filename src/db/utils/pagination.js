// src/db/utils/pagination.js

// SQL fragment: full-precision UTC ISO text for a timestamptz column.
// Usage: `${cursorText("ir.created_at")} AS cursor_time`
export const cursorText = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const clampLimit = (raw, { fallback = 20, max = 100 } = {}) => {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(Math.floor(n), max);
};

// Rows must have been fetched with LIMIT limit+1 and must expose the cursor
// text column and an id column. Returns { items, nextCursor } where items is
// the raw rows trimmed to `limit`, so callers still do their own row mapping.
export const buildPage = (rows, limit, { timeKey = "cursor_time", idKey }) => {
	if (!idKey) throw new Error("buildPage: idKey is required");
	const hasNextPage = rows.length > limit;
	const items = hasNextPage ? rows.slice(0, limit) : rows;
	const last = items[items.length - 1];
	const nextCursor = hasNextPage && last ? { cursorTime: last[timeKey], cursorId: last[idKey] } : null;
	return { items, nextCursor };
};
