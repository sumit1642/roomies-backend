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

// Internal map — never exported directly. All external access goes through
// getAllowedPreferenceValues which returns a defensive copy.
const allowedValuesByKey = new Map(
	PREFERENCE_DEFINITIONS.map((definition) => [
		definition.preferenceKey,
		new Set(definition.values.map((v) => v.value)),
	]),
);

// Returns the set of allowed values for a given preference key.
//
// IMPORTANT: returns a DEFENSIVE COPY of the internal Set, not the Set itself.
// Returning the internal Set directly would allow callers to mutate the shared
// catalog via set.add() or set.clear(), silently corrupting every subsequent
// lookup for the life of the process. A defensive copy means callers can freely
// iterate, spread, or pass the result without risk of shared-state corruption.
//
// The allocation cost (one new Set per call) is negligible — this is called
// only during request validation, not in hot inner loops.
export const getAllowedPreferenceValues = (preferenceKey) => {
	const values = allowedValuesByKey.get(preferenceKey);
	// Return a copy so callers cannot mutate the shared internal catalog.
	return values ? new Set(values) : new Set();
};

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
