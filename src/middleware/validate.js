// validate() wraps a Zod schema and returns an Express middleware.
// Usage on a route: router.post('/register', validate(registerSchema), authController.register)
//
// It validates req.body, req.query, and req.params in one pass.
// On failure it calls next(err) with the ZodError — the global errorHandler converts it to a 400.

export const validate = (schema) => (req, res, next) => {
	try {
		schema.parse({
			body: req.body,
			query: req.query,
			params: req.params,
		});
		next();
	} catch (err) {
		next(err);
	}
};
