export const maskEmail = (email) => {
	const [local, domain] = email.split("@");
	if (!domain) return "****";
	const prefix = local?.length > 0 ? local[0] : "*";
	return `${prefix}****@${domain}`;
};

export const escapeHtml = (value) =>
	String(value).replace(
		/[&<>'"]/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				"'": "&#39;",
				'"': "&quot;",
			})[character],
	);
