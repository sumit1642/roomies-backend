



























const GUEST_MAX_LISTINGS_PER_REQUEST = 20;

export const guestListingGate = (req, res, next) => {
	if (req.user) {
		return next();
	}

	const requestedLimit =
		typeof req.query.limit === "number" ?
			req.query.limit
		:	parseInt(req.query.limit, 10) || GUEST_MAX_LISTINGS_PER_REQUEST;

	if (requestedLimit > GUEST_MAX_LISTINGS_PER_REQUEST) {
		req.query = { ...req.query, limit: GUEST_MAX_LISTINGS_PER_REQUEST };
	}

	next();
};
