// src/validators/pincode.validators.js

import { z } from "zod";

export const getPincodeSchema = z.object({
	params: z.object({
		pincode: z
			.string({ error: "pincode is required" })
			.regex(/^\d{6}$/, { error: "pincode must be exactly 6 digits" }),
	}),
});
