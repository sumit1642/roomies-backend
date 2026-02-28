// src/middleware/validate.js

// validate() wraps a Zod schema and returns an Express middleware.
// Usage: router.post('/register', validate(registerSchema), authController.register)
//
// After successful parse, result.data is written back to req so that Zod
// coercions, defaults, and transformations are visible to downstream handlers.

export const validate = (schema) => (req, res, next) => {
	const result = schema.safeParse({
		body: req.body,
		query: req.query,
		params: req.params,
	});

	if (!result.success) {
		return next(result.error);
	}

	// Write validated/transformed data back — downstream sees coerced types and defaults
	req.body = result.data.body ?? req.body;
	req.query = result.data.query ?? req.query;
	req.params = result.data.params ?? req.params;

	next();
};
