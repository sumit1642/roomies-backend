// src/config/preferences.js

export const PREFERENCE_DEFINITIONS = [
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
];

const allowedValuesByKey = new Map(
	PREFERENCE_DEFINITIONS.map((definition) => [
		definition.preferenceKey,
		new Set(definition.values.map((v) => v.value)),
	]),
);

export const getAllowedPreferenceValues = (preferenceKey) => allowedValuesByKey.get(preferenceKey) ?? new Set();

// Database uniqueness is on (user_id/listing_id, preference_key), so
// duplicate keys are collapsed with last-write-wins semantics before inserts.
export const dedupePreferencesByKey = (preferences) => {
	const byKey = new Map();
	for (const preference of preferences) {
		byKey.set(preference.preferenceKey, preference.preferenceValue);
	}

	return [...byKey.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([preferenceKey, preferenceValue]) => ({ preferenceKey, preferenceValue }));
};

export const preferenceMetadata = {
	preferences: PREFERENCE_DEFINITIONS,
};
