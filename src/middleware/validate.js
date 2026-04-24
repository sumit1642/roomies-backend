













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
