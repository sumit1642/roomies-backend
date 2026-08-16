const deepFreeze = (obj) => {
	if (obj === null || typeof obj !== "object") return obj;

	Object.keys(obj).forEach((key) => deepFreeze(obj[key]));
	Object.freeze(obj);
	return obj;
};

export const PREFERENCE_DEFINITIONS = deepFreeze([
	{
		preferenceKey: "smoking",
		label: "Smoking",
		values: [
			{ value: "non_smoker", label: "Non-smoker" },
			{ value: "smoker", label: "Smoker" },
		],
	},
	{
		preferenceKey: "food_habit",
		label: "Food Habit",
		values: [
			{ value: "vegetarian", label: "Vegetarian" },
			{ value: "non_vegetarian", label: "Non-vegetarian" },
			{ value: "vegan", label: "Vegan" },
		],
	},
	{
		preferenceKey: "sleep_schedule",
		label: "Sleep Schedule",
		values: [
			{ value: "early_bird", label: "Early bird" },
			{ value: "night_owl", label: "Night owl" },
		],
	},
	{
		preferenceKey: "alcohol",
		label: "Alcohol",
		values: [
			{ value: "okay", label: "Okay" },
			{ value: "not_okay", label: "Not okay" },
		],
	},
	{
		preferenceKey: "cleanliness_level",
		label: "Cleanliness Level",
		values: [
			{ value: "low", label: "Low" },
			{ value: "medium", label: "Medium" },
			{ value: "high", label: "High" },
		],
	},
	{
		preferenceKey: "noise_tolerance",
		label: "Noise Tolerance",
		values: [
			{ value: "low", label: "Low" },
			{ value: "medium", label: "Medium" },
			{ value: "high", label: "High" },
		],
	},
	{
		preferenceKey: "guest_policy",
		label: "Guest Policy",
		values: [
			{ value: "rarely", label: "Rarely" },
			{ value: "occasionally", label: "Occasionally" },
			{ value: "frequently", label: "Frequently" },
		],
	},
]);

const allowedValuesByKey = new Map(
	PREFERENCE_DEFINITIONS.map((definition) => [
		definition.preferenceKey,
		new Set(definition.values.map((v) => v.value)),
	]),
);

export const getAllowedPreferenceValues = (preferenceKey) => {
	const values = allowedValuesByKey.get(preferenceKey);

	return values ? new Set(values) : new Set();
};

export const dedupePreferencesByKey = (preferences) => {
	const byKey = new Map();
	for (const preference of preferences) {
		byKey.set(preference.preferenceKey, preference.preferenceValue);
	}

	return [...byKey.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([preferenceKey, preferenceValue]) => ({ preferenceKey, preferenceValue }));
};

export const preferenceMetadata = deepFreeze({
	preferences: PREFERENCE_DEFINITIONS,
});
