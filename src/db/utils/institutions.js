// src/db/utils/institutions.js

import { pool } from "../client.js";

// Looks up an institution by its email domain — e.g. 'iitb.ac.in'.
// Called during student registration to determine whether the email address
// qualifies for automatic verification without going through the OTP flow.
//
// The WHERE clause includes deleted_at IS NULL for two reasons:
//   1. It matches the predicate of the partial unique index on (email_domain),
//      so the query planner uses an index scan rather than a seq scan.
//   2. A soft-deleted institution should not trigger auto-verification for new
//      registrations, even though old student records retain their institution_id.
//
// Accepts an optional client so it can participate in a transaction transparently.
// When called inside the registration transaction, the same client is passed in —
// no separate connection, no risk of reading uncommitted state from another session.
// Defaults to the shared pool for standalone calls (tests, one-offs).
//
// Returns { institution_id, name } or null. Never undefined, never an empty array.
export const findInstitutionByDomain = async (domain, client = pool) => {
	const { rows } = await client.query(
		`
		SELECT institution_id, name
		FROM institutions
		WHERE email_domain = $1
			AND deleted_at IS NULL`,
		[domain],
	);
	return rows[0] ?? null;
};
