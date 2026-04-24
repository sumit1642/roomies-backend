// After successful parse, result.data is written back to req so that Zod
// coercions, defaults, and transformations are visible to downstream handlers.
//
// ─── EXPRESS 5 COMPATIBILITY ──────────────────────────────────────────────────
//
// In Express 5, req.query is defined as a non-writable getter on the prototype,
// which means a direct assignment (`req.query = ...`) throws a TypeError in
// strict mode. We use Object.defineProperty to replace the getter with an
// own data property, which is legal and works in both Express 4 and Express 5.
//
// We only redefine when result.data.query is actually present (not undefined)
// to avoid clobbering Express's lazy query-string parser for routes whose
// schemas don't include a `query` field.

export const validate = (schema) => (req, res, next) => {
	const result = schema.safeParse({
		body: req.body,
		query: req.query,
		params: req.params,
	});

	if (!result.success) {
		return next(result.error);
	}

	req.body = result.data.body ?? req.body;
	req.params = result.data.params ?? req.params;

	if (result.data.query != null) {
		Object.defineProperty(req, "query", {
			value: result.data.query,
			configurable: true,
			enumerable: true,
			writable: true,
		});
	}

	next();
};
