# Notifications API

Notifications are created asynchronously by the worker. The HTTP API only reads them and marks them as read.

Shared conventions: [conventions.md](./conventions.md)

## Notification types (worker source of truth)

The `NOTIFICATION_MESSAGES` map in `src/workers/notificationWorker.js` is authoritative.

| Type                         | Message                                            | Status          |
| ---------------------------- | -------------------------------------------------- | --------------- |
| `interest_request_received`  | Someone expressed interest in your listing         | ACTIVE          |
| `interest_request_accepted`  | Your interest request was accepted                 | ACTIVE          |
| `interest_request_declined`  | Your interest request was declined                 | ACTIVE          |
| `interest_request_withdrawn` | An interest request was withdrawn                  | ACTIVE          |
| `connection_confirmed`       | Your connection has been confirmed by both parties | ACTIVE          |
| `rating_received`            | You received a new rating                          | ACTIVE          |
| `listing_expiring`           | One of your listings is expiring soon              | ACTIVE          |
| `listing_expired`            | One of your listings has expired                   | ACTIVE          |
| `listing_filled`             | A listing has been marked as filled                | ACTIVE          |
| `verification_approved`      | Your verification request was approved             | PLANNED emitter |
| `verification_rejected`      | Your verification request was rejected             | PLANNED emitter |
| `new_message`                | You have a new message                             | PLANNED emitter |
| `connection_requested`       | You have a new connection request                  | PLANNED emitter |

## `GET /notifications`

Returns the authenticated user's notification feed.

### Request Contract

- Auth required: Yes
- Query params:
    - `isRead`
    - `limit`
    - `cursorTime`
    - `cursorId`

### Scenario: fetch feed with pagination

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"notificationId": "31f907ca-df84-4f9d-9c4a-fd67eb1dfe7d",
				"actorId": "22222222-2222-4222-8222-222222222222",
				"type": "interest_request_accepted",
				"entityType": "interest_request",
				"entityId": "66666666-6666-4666-8666-666666666666",
				"message": "Your interest request was accepted.",
				"isRead": false,
				"createdAt": "2026-04-11T12:10:00.000Z"
			}
		],
		"nextCursor": null
	}
}
```

### Scenario: fetch only read notifications

Request:

```http
GET /api/v1/notifications?isRead=true
```

Status: `200`

Response shape is the same as above, filtered to read rows only.

### Scenario: fetch only unread notifications

Request:

```http
GET /api/v1/notifications?isRead=false
```

Status: `200`

Response shape is the same as above, filtered to unread rows only.

## `GET /notifications/unread-count`

Returns the bell badge count.

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"count": 3
	}
}
```

## `POST /notifications/mark-read`

Marks notifications as read in one of two modes.

### Mode 1: mark all

Request:

```json
{
	"all": true
}
```

Success:

```json
{
	"status": "success",
	"data": {
		"updated": 3
	}
}
```

### Mode 2: mark selected IDs

Request:

```json
{
	"notificationIds": ["31f907ca-df84-4f9d-9c4a-fd67eb1dfe7d", "efb6d828-3725-4caf-aa15-5a8ec749f590"]
}
```

Success:

```json
{
	"status": "success",
	"data": {
		"updated": 2
	}
}
```

### Scenario: both modes supplied

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body",
			"message": "Provide exactly one mode: either { all: true } to mark all notifications as read, or { notificationIds: [...] } to mark specific ones — not both simultaneously"
		}
	]
}
```

### Scenario: client sends `{ "all": false }`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.all",
			"message": "Invalid input: expected true"
		}
	]
}
```

### Scenario: neither mode supplied

Status: `400`

```json
{
	"status": "error",
	"message": "notificationIds must be a non-empty array when all is not true"
}
```

### Scenario: malformed IDs

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.notificationIds.0",
			"message": "Each notification ID must be a valid UUID"
		}
	]
}
```

### Scenario: authentication missing

Status: `401`

```json
{
	"status": "error",
	"message": "No token provided"
}
```

## Integrator Notes

- Mark-read operations are idempotent.
- Supplying another user's notification IDs does not update those rows because the update is scoped to the authenticated
  recipient.
