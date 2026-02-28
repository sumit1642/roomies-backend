// validate() wraps a Zod schema and returns an Express middleware.
// Usage: router.post('/register', validate(registerSchema), authController.register)
//
// Validates req.body, req.query, and req.params in one pass.
// On failure, calls next(err) with the ZodError — errorHandler converts it to a 400.
//
// Zod v4 note: error.errors is now error.issues — updated throughout.

export const validate = (schema) => (req, res, next) => {
	const result = schema.safeParse({
		body: req.body,
		query: req.query,
		params: req.params,
	});

	if (!result.success) {
		// Pass the ZodError to the global error handler
		return next(result.error);
	}

	next();
};
