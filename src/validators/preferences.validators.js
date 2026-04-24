

import { z } from "zod";
import { PREFERENCE_DEFINITIONS, getAllowedPreferenceValues } from "../config/preferences.js";

const preferenceKeys = PREFERENCE_DEFINITIONS.map((definition) => definition.preferenceKey);

const preferenceKeySchema = z.enum(preferenceKeys, {
	error: `preferenceKey must be one of: ${preferenceKeys.join(", ")}`,
});

export const preferencePairSchema = z
	.object({
		preferenceKey: preferenceKeySchema,
		preferenceValue: z.string().min(1, { error: "Preference value cannot be empty" }).max(100),
	})
	.superRefine((value, ctx) => {
		const allowedValues = getAllowedPreferenceValues(value.preferenceKey);
		if (!allowedValues.has(value.preferenceValue)) {
			ctx.addIssue({
				code: "custom",
				path: ["preferenceValue"],
				message: `Invalid preferenceValue for '${value.preferenceKey}'`,
			});
		}
	});

export const preferencesSchema = z.array(preferencePairSchema).default([]);



export const requiredPreferencesSchema = z.array(preferencePairSchema);
