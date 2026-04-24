// Guest browsing policy:
// Real SaaS housing platforms (NoBroker, Housing.com, Zillow) allow unauthenticated
// users to browse listings freely. The gate is placed on VALUE EXTRACTION:
//   - Contact reveal     → contactRevealGate enforces quota
//   - Saving a listing   → requires authentication (student role)
//   - Expressing interest → requires authentication (student role)
//   - Compatibility score → omitted for guests (no user preferences available)
//
// Blocking browsing itself creates friction at the top of the funnel and hurts
// conversion — users who cannot see listings will not sign up to see them.
//
// For guest requests (req.user absent after optionalAuthenticate):
//   1. Silently caps `limit` in req.query to GUEST_MAX_LISTINGS_PER_REQUEST (20).
//      The guest sees at most 20 items per page, regardless of what they sent.
//      This is the same as the default limit for authenticated users, so in
//      practice it only matters if a guest tries to request more.
//
// For authenticated requests: passes through untouched.
//
// - No Redis counters per fingerprint
// - No filter-action quota (guests can filter freely — that's the product)
// - No hard blocking of browsing
//
// These omissions are intentional. Filter quotas are friction. Real platforms
// use soft login prompts (triggered client-side after N views) rather than
// server-side hard blocks on browsing. The contact reveal gate already handles
// the one piece of PII that actually needs protection.

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
