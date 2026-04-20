# Preferences API

Shared conventions: [conventions.md](./conventions.md)

`user_preferences` is optional. Empty preference state is represented by `[]` (never `null`).

## `GET /preferences/meta`

Returns the current preference catalog (`preferenceMetadata`).

### Request Contract

- Auth required: Yes

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"preferences": [
			{
				"preferenceKey": "smoking",
				"label": "Smoking",
				"values": [
					{ "value": "non_smoker", "label": "Non-smoker" },
					{ "value": "smoker", "label": "Smoker" }
				]
			},
			{
				"preferenceKey": "food_habit",
				"label": "Food Habit",
				"values": [
					{ "value": "vegetarian", "label": "Vegetarian" },
					{ "value": "non_vegetarian", "label": "Non-vegetarian" },
					{ "value": "vegan", "label": "Vegan" }
				]
			},
			{
				"preferenceKey": "sleep_schedule",
				"label": "Sleep Schedule",
				"values": [
					{ "value": "early_bird", "label": "Early bird" },
					{ "value": "night_owl", "label": "Night owl" }
				]
			},
			{
				"preferenceKey": "alcohol",
				"label": "Alcohol",
				"values": [
					{ "value": "okay", "label": "Okay" },
					{ "value": "not_okay", "label": "Not okay" }
				]
			},
			{
				"preferenceKey": "cleanliness_level",
				"label": "Cleanliness Level",
				"values": [
					{ "value": "low", "label": "Low" },
					{ "value": "medium", "label": "Medium" },
					{ "value": "high", "label": "High" }
				]
			},
			{
				"preferenceKey": "noise_tolerance",
				"label": "Noise Tolerance",
				"values": [
					{ "value": "low", "label": "Low" },
					{ "value": "medium", "label": "Medium" },
					{ "value": "high", "label": "High" }
				]
			},
			{
				"preferenceKey": "guest_policy",
				"label": "Guest Policy",
				"values": [
					{ "value": "rarely", "label": "Rarely" },
					{ "value": "occasionally", "label": "Occasionally" },
					{ "value": "frequently", "label": "Frequently" }
				]
			}
		]
	}
}
```

## `GET /students/:userId/preferences`

Owner-only read of the student's current profile preferences.

### Request Contract

- Auth required: Yes
- Owner-only: `req.user.userId` must match `:userId`

### Scenario: no preferences configured

Status: `200`

```json
{
	"status": "success",
	"data": []
}
```

### Scenario: preferences exist

Status: `200`

```json
{
	"status": "success",
	"data": [
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" },
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" }
	]
}
```

### Scenario: caller reads another user's preferences

Status: `403`

```json
{
	"status": "error",
	"message": "Forbidden"
}
```

## `PUT /students/:userId/preferences`

Full replace semantics.

- Empty `preferences` clears all rows.
- Duplicate keys are deduped by `dedupePreferencesByKey` with **last-write-wins**.

### Scenario: update with unique keys

Status: `200`

```json
{
	"status": "success",
	"data": [
		{ "preferenceKey": "sleep_schedule", "preferenceValue": "early_bird" },
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" }
	]
}
```

### Scenario: duplicate preference key submitted — last value wins, no error

Request:

```json
{
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "smoking", "preferenceValue": "smoker" }
	]
}
```

Status: `200`

```json
{
	"status": "success",
	"data": [{ "preferenceKey": "smoking", "preferenceValue": "smoker" }]
}
```

### Scenario: clear all

Status: `200`

```json
{
	"status": "success",
	"data": []
}
```

### Scenario: invalid key/value pair

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.preferences.0.preferenceValue",
			"message": "Invalid preferenceValue for 'smoking'"
		}
	]
}
```
