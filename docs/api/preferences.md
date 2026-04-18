# Preferences API

This document covers preference metadata and student self-preference management.

`user_preferences` is optional. A user can have zero preferences and still search listings normally.

## `GET /preferences/meta`

Returns the authenticated metadata catalog of supported preference keys and values.

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
			}
		]
	}
}
```

## `GET /students/:userId/preferences`

Returns the current self preferences for the authenticated student.

### Request Contract

- Auth required: Yes
- Owner-only: `req.user.userId` must match `:userId`

### Scenario: no preferences configured yet

Status: `200`

```json
{
	"status": "success",
	"data": []
}
```

### Scenario: has preferences

Status: `200`

```json
{
	"status": "success",
	"data": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" }
	]
}
```

## `PUT /students/:userId/preferences`

Replaces the full preference set for the authenticated student.

- Empty `preferences` array is valid and clears all preferences.
- Duplicate keys are silently de-duplicated using last-write-wins semantics.

### Request body

```json
{
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "sleep_schedule", "preferenceValue": "early_bird" }
	]
}
```

### Scenario: clear all

Request body:

```json
{
	"preferences": []
}
```

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

### Scenario: caller updates another user

Status: `403`

```json
{
	"status": "error",
	"message": "Forbidden"
}
```
