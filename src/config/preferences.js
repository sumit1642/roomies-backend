// src/config/preferences.js
//
// ─── IMMUTABILITY GUARANTEE ───────────────────────────────────────────────────
//
// PREFERENCE_DEFINITIONS and preferenceMetadata are module-level catalogs that
// are also exported for use by validators and controllers. If an importer were
// to mutate either (e.g. push a new entry into PREFERENCE_DEFINITIONS.values or
// reassign a preferenceKey), allowedValuesByKey — which is built once at module
// load — would silently become stale, causing validation to accept or reject
// values based on the old snapshot while the exported array reflects the new one.
//
// The fix is to deep-freeze everything before building allowedValuesByKey.
// Object.freeze is shallow, so we apply it recursively via deepFreeze. The Map
// itself is then built from the frozen objects, after which no caller can alter
// the underlying source material. The Map is an internal object and never
// exported directly, so it does not need freezing, but the defensive-copy
// contract in getAllowedPreferenceValues still protects against external mutation
// of any returned Set.

/**
 * Recursively freezes an object and all its enumerable property values that are
 * themselves objects or arrays. Primitive values pass through unchanged.
 *
 * @template T
 * @param {T} obj
 * @returns {T} - the same reference, now deeply frozen
 */
const deepFreeze = (obj) => {
	if (obj === null || typeof obj !== "object") return obj;
	// Freeze nested values first (post-order traversal) before freezing the
	// container, so the freeze of the container does not block property access.
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

// Internal map — never exported directly. Built after deepFreeze so the source
// material is immutable by the time the Map is constructed. All external access
// goes through getAllowedPreferenceValues which returns a defensive copy.
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

// preferenceMetadata is also deep-frozen so that the exported catalog object
// and the nested PREFERENCE_DEFINITIONS reference it holds are both immutable.
// This keeps the metadata and the allowedValuesByKey map permanently in sync.
export const preferenceMetadata = deepFreeze({
	preferences: PREFERENCE_DEFINITIONS,
});
