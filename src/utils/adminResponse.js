// src/utils/adminResponse.js
//
// Shared response-envelope builders for every admin endpoint, per the
// "Response Envelope Convention" section of ADR-016 (confirmed 2026-08-28).
//
// Extends — never replaces — the existing { status, data } shape used
// everywhere else in the codebase. `meta` is purely additive: any consumer
// reading only `data` (e.g. an older client) is unaffected.
//
// `action` is a dot-namespaced string (e.g. "user.suspend", "institution.create")
// so the admin UI can render a consistent activity/toast log without
// per-endpoint special-casing. The same `action` string should also be
// passed to logger.info in the calling service function — this is the audit
// trail (no new DB table per the ADR), so the two must stay in sync by
// convention: whichever string you log is the string you return here.

export const adminMutationEnvelope = (data, { actorId, action }) => ({
	status: "success",
	data,
	meta: {
		actorId,
		action,
		timestamp: new Date().toISOString(),
	},
});

// totalMatching is optional and should only ever be passed when it was
// already cheap to compute as part of the main query (e.g. via a window
// function) — never as a separate COUNT(*) that blocks the response. Omit
// entirely rather than adding a blocking count query just to populate it.
export const adminListEnvelope = (items, nextCursor, { totalMatching } = {}) => ({
	status: "success",
	data: { items, nextCursor },
	...(totalMatching !== undefined && { meta: { totalMatching } }),
});
