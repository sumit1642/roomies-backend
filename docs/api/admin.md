# Admin API

Shared conventions: [conventions.md](./conventions.md)

## Current implementation status

`/admin` routes are **not mounted** in `src/routes/index.js` in this workspace, so live calls to `/api/v1/admin/*`
currently return `404`.

This file documents the intended scenario contracts already backed by:

- `src/services/verification.service.js`
- `src/services/report.service.js`
- `src/validators/verification.validators.js`
- `src/validators/report.validators.js`
- `src/controllers/verification.controller.js`
- `src/controllers/report.controller.js`

When the admin router is mounted with `authenticate + authorize("admin")`, the scenarios below apply.

## Router-level admin gate

### Scenario: caller is not an admin

Status: `403`

```json
{
	"status": "error",
	"message": "Forbidden"
}
```

---

## `GET /admin/verification-queue`

Oldest-first paginated queue of pending PG owner verification requests.

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"request_id": "99999999-9999-4999-8999-999999999999",
				"user_id": "22222222-2222-4222-8222-222222222222",
				"document_type": "owner_id",
				"document_url": "https://roomiesblob.blob.core.windows.net/roomies-uploads/verifications/owner-id.webp",
				"submitted_at": "2026-04-11T10:00:00.000Z",
				"business_name": "Sunrise PG",
				"owner_full_name": "Rohan Mehta",
				"verification_status": "pending",
				"email": "owner@sunrisepg.in"
			}
		],
		"nextCursor": null
	}
}
```

### Scenario: partial cursor supplied

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.cursorTime",
			"message": "cursorTime and cursorId must be provided together"
		}
	]
}
```

---

## `POST /admin/verification-queue/:requestId/approve`

### Scenario: request approved

Status: `200`

```json
{
	"status": "success",
	"data": {
		"requestId": "99999999-9999-4999-8999-999999999999",
		"status": "verified"
	}
}
```

### Scenario: request already resolved concurrently

Status: `409`

```json
{
	"status": "error",
	"message": "Verification request not found or already resolved"
}
```

---

## `POST /admin/verification-queue/:requestId/reject`

### Scenario: request rejected

Status: `200`

```json
{
	"status": "success",
	"data": {
		"requestId": "99999999-9999-4999-8999-999999999999",
		"status": "rejected"
	}
}
```

### Scenario: rejection reason missing

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.rejectionReason",
			"message": "Rejection reason is required"
		}
	]
}
```

### Scenario: request already resolved concurrently

Status: `409`

```json
{
	"status": "error",
	"message": "Verification request not found or already resolved"
}
```

---

## `GET /admin/report-queue`

Oldest-first paginated queue of open rating reports.

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"reportId": "99999999-9999-4999-8999-999999999999",
				"reporterId": "11111111-1111-4111-8111-111111111111",
				"ratingId": "88888888-8888-4888-8888-888888888888",
				"reason": "fake",
				"explanation": "The review does not match the actual stay.",
				"status": "open",
				"submittedAt": "2026-04-11T10:00:00.000Z",
				"rating": {
					"overallScore": 1,
					"cleanlinessScore": 1,
					"communicationScore": 1,
					"reliabilityScore": 1,
					"valueScore": 1,
					"comment": "Fake review",
					"revieweeType": "user",
					"revieweeId": "22222222-2222-4222-8222-222222222222",
					"isVisible": true,
					"createdAt": "2026-04-10T10:00:00.000Z",
					"reviewer": {
						"fullName": "Priya Sharma",
						"profilePhotoUrl": null
					},
					"reviewee": {
						"fullName": "Rohan Mehta",
						"profilePhotoUrl": null
					}
				},
				"reporter": {
					"fullName": "Priya Sharma",
					"profilePhotoUrl": null
				}
			}
		],
		"nextCursor": null
	}
}
```

---

## `PATCH /admin/reports/:reportId/resolve`

### Scenario: resolve and remove rating

Request:

```json
{
	"resolution": "resolved_removed",
	"adminNotes": "Evidence confirmed. Rating removed."
}
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"reportId": "99999999-9999-4999-8999-999999999999",
		"resolution": "resolved_removed",
		"ratingId": "88888888-8888-4888-8888-888888888888"
	}
}
```

### Scenario: `resolved_removed` without `adminNotes`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.adminNotes",
			"message": "adminNotes is required when resolution is resolved_removed"
		}
	]
}
```

### Scenario: report already resolved

Status: `409`

```json
{
	"status": "error",
	"message": "Report not found or already resolved"
}
```

## CDC side-effects note

When verification status changes to `verified`, `rejected`, or `pending`, trigger `trg_verification_status_changed`
writes to `verification_event_outbox`. `verificationEventWorker` polls this table (5-second interval) and enqueues:

- in-app notification (`notification-delivery`)
- email (`email-delivery`)
