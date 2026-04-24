

import * as preferencesService from "../services/preferences.service.js";

export const getMetadata = async (req, res, next) => {
	try {
		const metadata = await preferencesService.getPreferencesMetadata();
		res.json({ status: "success", data: metadata });
	} catch (err) {
		next(err);
	}
};
