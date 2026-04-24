import { pool } from "../client.js";
















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
