# Admin API

Admin routes are protected by authentication and the `admin` role gate at router level.

Unauthenticated callers receive:

```json
{
	"status": "error",
	"message": "No token provided"
}
```

Authenticated non-admin callers receive:

```json
{
	"status": "error",
	"message": "Forbidden"
}
```

Other authentication failures that can occur before admin logic runs:

Invalid token:

```json
{
	"status": "error",
	"message": "Invalid token"
}
```

Expired bearer token:

```json
{
	"status": "error",
	"message": "Token has expired"
}
```

Expired browser session (silent refresh failed):

```json
{
	"status": "error",
	"message": "Session expired"
}
```

JWT user no longer exists:

```json
{
	"status": "error",
	"message": "User not found"
}
```

Inactive admin account (possible values shown):

```json
{
	"status": "error",
	"message": "Account is suspended"
}
```

```json
{
	"status": "error",
	"message": "Account is banned"
}
```

```json
{
	"status": "error",
	"message": "Account is deactivated"
}
```

---

## Verification Queue

### `GET /admin/verification-queue`

Returns pending PG owner verification requests oldest-first.

### Request Contract

- Auth required: Yes
- Role required: `admin`
- Query params:
    - `limit`
    - `cursorTime`
    - `cursorId`

### Scenario: admin fetches queue

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"request_id": "abf62d6a-2783-4dd1-a808-72d758fb18da",
				"user_id": "22222222-2222-4222-8222-222222222222",
				"document_type": "property_document",
				"document_url": "https://storage.example.com/verification/owner-property-proof.pdf",
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

### Scenario: invalid `limit`

Examples:

- `GET /api/v1/admin/verification-queue?limit=0`
- `GET /api/v1/admin/verification-queue?limit=101`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.limit",
			"message": "Too small: expected number to be >=1"
		}
	]
}
```

### `POST /admin/verification-queue/:requestId/approve`

Approves a pending verification request.

Request:

```json
{
	"adminNotes": "Document verified against submitted ownership proof."
}
```

#### Scenario: approval succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"requestId": "abf62d6a-2783-4dd1-a808-72d758fb18da",
		"status": "verified"
	}
}
```

#### Scenario: invalid request ID format

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "params.requestId",
			"message": "Invalid request ID"
		}
	]
}
```

#### Scenario: `adminNotes` too long

If `adminNotes` exceeds 1000 characters:

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.adminNotes",
			"message": "Too big: expected string to have <=1000 characters"
		}
	]
}
```

#### Scenario: request already resolved or missing

Status: `409`

```json
{
	"status": "error",
	"message": "Verification request not found or already resolved"
}
```

### `POST /admin/verification-queue/:requestId/reject`

Rejects a pending verification request.

Request:

```json
{
	"rejectionReason": "Uploaded document is unreadable.",
	"adminNotes": "Please re-upload a clearer copy."
}
```

#### Scenario: rejection succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"requestId": "abf62d6a-2783-4dd1-a808-72d758fb18da",
		"status": "rejected"
	}
}
```

#### Scenario: missing rejection reason

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

#### Scenario: invalid request ID format

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "params.requestId",
			"message": "Invalid request ID"
		}
	]
}
```

#### Scenario: `adminNotes` or `rejectionReason` too long

If either string exceeds 1000 characters:

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.rejectionReason",
			"message": "Too big: expected string to have <=1000 characters"
		}
	]
}
```

#### Scenario: request already resolved or missing

Status: `409`

```json
{
	"status": "error",
	"message": "Verification request not found or already resolved"
}
```

---

## Report Moderation

### `GET /admin/report-queue`

Returns open rating reports oldest-first with rating and reporter context.

### Request Contract

- Auth required: Yes
- Role required: `admin`
- Query params:
    - `limit`
    - `cursorTime`
    - `cursorId`

### Scenario: admin fetches report queue

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
				"explanation": "The stay never happened and this review is fabricated.",
				"status": "open",
				"submittedAt": "2026-04-12T11:00:00.000Z",
				"rating": {
					"overallScore": 5,
					"cleanlinessScore": 5,
					"communicationScore": 5,
					"reliabilityScore": 5,
					"valueScore": 4,
					"comment": "Very responsive and transparent.",
					"revieweeType": "user",
					"revieweeId": "22222222-2222-4222-8222-222222222222",
					"isVisible": true,
					"createdAt": "2026-04-12T10:00:00.000Z",
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

### Scenario: queue item remains visible after related profile soft-delete

Status: `200`

Behavior: the queue still returns report rows. Name/photo fields may fall back or become null, but moderation metadata
remains available.

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

### Scenario: invalid `limit`

Examples:

- `GET /api/v1/admin/report-queue?limit=0`
- `GET /api/v1/admin/report-queue?limit=101`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.limit",
			"message": "Too small: expected number to be >=1"
		}
	]
}
```

### `PATCH /admin/reports/:reportId/resolve`

Closes a report with either `resolved_kept` or `resolved_removed`.

#### Scenario: keep rating visible

Request:

```json
{
	"resolution": "resolved_kept",
	"adminNotes": "Insufficient evidence to remove the rating."
}
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"reportId": "99999999-9999-4999-8999-999999999999",
		"resolution": "resolved_kept",
		"ratingId": "88888888-8888-4888-8888-888888888888"
	}
}
```

#### Scenario: remove rating

Request:

```json
{
	"resolution": "resolved_removed",
	"adminNotes": "Evidence confirms the review is fabricated."
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

#### Scenario: missing `adminNotes` for removal

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

#### Scenario: invalid report ID format

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "params.reportId",
			"message": "Invalid report ID"
		}
	]
}
```

#### Scenario: invalid `resolution` value

Request:

```json
{
	"resolution": "dismissed"
}
```

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.resolution",
			"message": "resolution must be one of: resolved_removed, resolved_kept"
		}
	]
}
```

#### Scenario: report already resolved or missing

Status: `409`

```json
{
	"status": "error",
	"message": "Report not found or already resolved"
}
```

---

## User Management

### `GET /admin/users`

Paginated user list for moderation and support workflows.

### Request Contract

- Auth required: Yes
- Role required: `admin`
- Optional query filters:
    - `role` (`student | pg_owner | admin`)
    - `accountStatus` (`active | suspended | banned | deactivated`)
    - `isEmailVerified` (`true | false`)
    - `limit`
    - `cursorTime`
    - `cursorId`

### Scenario: list users with filters

Request:

```http
GET /api/v1/admin/users?role=pg_owner&accountStatus=active&isEmailVerified=true&limit=2
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"userId": "22222222-2222-4222-8222-222222222222",
				"email": "owner@sunrisepg.in",
				"displayName": "Rohan Mehta",
				"roles": ["pg_owner"],
				"accountStatus": "active",
				"isEmailVerified": true,
				"averageRating": 4.5,
				"ratingCount": 12,
				"createdAt": "2026-03-01T09:00:00.000Z"
			}
		],
		"nextCursor": {
			"cursorTime": "2026-03-01T09:00:00.000Z",
			"cursorId": "22222222-2222-4222-8222-222222222222"
		}
	}
}
```

### Scenario: invalid role filter

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.role",
			"message": "role must be one of: student, pg_owner, admin"
		}
	]
}
```

### Scenario: invalid `accountStatus` filter

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.accountStatus",
			"message": "accountStatus must be one of: active, suspended, banned, deactivated"
		}
	]
}
```

### Scenario: invalid `isEmailVerified` value

Example request:

```http
GET /api/v1/admin/users?isEmailVerified=maybe
```

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.isEmailVerified",
			"message": "Invalid input: expected boolean, received string"
		}
	]
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

### Scenario: invalid `limit`

Examples:

- `GET /api/v1/admin/users?limit=0`
- `GET /api/v1/admin/users?limit=101`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.limit",
			"message": "Too small: expected number to be >=1"
		}
	]
}
```

### `GET /admin/users/:userId`

Returns full identity, profile, verification, and activity context for one user.

### Scenario: full user detail

Status: `200`

```json
{
	"status": "success",
	"data": {
		"userId": "22222222-2222-4222-8222-222222222222",
		"email": "owner@sunrisepg.in",
		"hasGoogleAuth": false,
		"roles": ["pg_owner"],
		"accountStatus": "active",
		"isEmailVerified": true,
		"isPhoneVerified": false,
		"averageRating": 4.5,
		"ratingCount": 12,
		"createdAt": "2026-03-01T09:00:00.000Z",
		"updatedAt": "2026-04-10T09:00:00.000Z",
		"studentProfile": null,
		"pgOwnerProfile": {
			"profileId": "d1789e5a-b6a0-4747-b80b-18ce4f0cb3e7",
			"businessName": "Sunrise PG",
			"ownerFullName": "Rohan Mehta",
			"businessPhone": "+919876543210",
			"operatingSince": 2017,
			"verificationStatus": "verified",
			"verifiedAt": "2026-03-03T09:00:00.000Z",
			"rejectionReason": null
		},
		"activity": {
			"listingCount": 14,
			"connectionCount": 22,
			"ratingsGivenCount": 3,
			"ratingsReceivedCount": 12,
			"openReportsFiledCount": 0
		}
	}
}
```

### Scenario: user not found

Status: `404`

```json
{
	"status": "error",
	"message": "User not found"
}
```

### Scenario: invalid user ID format

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "params.userId",
			"message": "Invalid user ID"
		}
	]
}
```

### `PATCH /admin/users/:userId/status`

Updates account status using admin transition rules.

Allowed request status values:

```json
{
	"status": "suspended",
	"adminNotes": "Repeated policy violations."
}
```

`adminNotes` is required when `status` is `banned`.

#### Scenario: active → suspended

Status: `200`

```json
{
	"status": "success",
	"data": {
		"userId": "22222222-2222-4222-8222-222222222222",
		"previousStatus": "active",
		"accountStatus": "suspended"
	}
}
```

#### Scenario: banned without admin notes

Request:

```json
{
	"status": "banned"
}
```

Status: `400`

```json
{
	"status": "error",
	"message": "adminNotes is required when banning a user"
}
```

#### Scenario: admin tries to suspend themselves

Status: `403`

```json
{
	"status": "error",
	"message": "You cannot change your own account status"
}
```

#### Scenario: admin tries to change another admin

Status: `403`

```json
{
	"status": "error",
	"message": "You cannot change the account status of another admin"
}
```

#### Scenario: invalid transition

Example: current status is `active`, requested status is `active`.

Status: `422`

```json
{
	"status": "error",
	"message": "Cannot transition account status from 'active' to 'active'"
}
```

#### Scenario: concurrent update conflict

Status: `409`

```json
{
	"status": "error",
	"message": "Account status changed concurrently — please refresh and retry"
}
```

#### Scenario: target user not found

Status: `404`

```json
{
	"status": "error",
	"message": "User not found"
}
```

#### Scenario: invalid user ID format

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "params.userId",
			"message": "Invalid user ID"
		}
	]
}
```

#### Scenario: invalid `status` value

Request:

```json
{
	"status": "deactivated"
}
```

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.status",
			"message": "status must be one of: active, suspended, banned"
		}
	]
}
```

---

## Rating Visibility Management

### `GET /admin/ratings`

Paginated rating audit feed with filters and open-report counts.

### Request Contract

- Auth required: Yes
- Role required: `admin`
- Optional query filters:
    - `isVisible` (`true | false`)
    - `revieweeType` (`user | property`)
    - `revieweeId` (UUID)
    - `limit`
    - `cursorTime`
    - `cursorId`

### Scenario: list hidden user ratings

Request:

```http
GET /api/v1/admin/ratings?isVisible=false&revieweeType=user&limit=1
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"ratingId": "88888888-8888-4888-8888-888888888888",
				"reviewerId": "11111111-1111-4111-8111-111111111111",
				"revieweeType": "user",
				"revieweeId": "22222222-2222-4222-8222-222222222222",
				"connectionId": "77777777-7777-4777-8777-777777777777",
				"overallScore": 1,
				"cleanlinessScore": 1,
				"communicationScore": 1,
				"reliabilityScore": 1,
				"valueScore": 1,
				"comment": "This review was hidden pending moderation.",
				"isVisible": false,
				"createdAt": "2026-04-12T10:00:00.000Z",
				"openReportCount": 2,
				"reviewer": {
					"fullName": "Priya Sharma",
					"profilePhotoUrl": null
				},
				"reviewee": {
					"name": "Rohan Mehta",
					"type": "user"
				}
			}
		],
		"nextCursor": null
	}
}
```

### Scenario: malformed `revieweeId`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.revieweeId",
			"message": "revieweeId must be a valid UUID"
		}
	]
}
```

### Scenario: invalid `revieweeType`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.revieweeType",
			"message": "revieweeType must be either 'user' or 'property'"
		}
	]
}
```

### Scenario: invalid `isVisible` value

Example request:

```http
GET /api/v1/admin/ratings?isVisible=maybe
```

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.isVisible",
			"message": "Invalid input: expected boolean, received string"
		}
	]
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

### Scenario: invalid `limit`

Examples:

- `GET /api/v1/admin/ratings?limit=0`
- `GET /api/v1/admin/ratings?limit=101`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.limit",
			"message": "Too small: expected number to be >=1"
		}
	]
}
```

### `PATCH /admin/ratings/:ratingId/visibility`

Directly hides or restores a rating, outside report resolution flow.

#### Scenario: hide rating

Request:

```json
{
	"isVisible": false,
	"adminNotes": "Suspicious coordinated review activity."
}
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"ratingId": "88888888-8888-4888-8888-888888888888",
		"isVisible": false,
		"changed": true
	}
}
```

#### Scenario: restore rating

Request:

```json
{
	"isVisible": true,
	"adminNotes": "Appeal accepted after additional evidence."
}
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"ratingId": "88888888-8888-4888-8888-888888888888",
		"isVisible": true,
		"changed": true
	}
}
```

#### Scenario: no-op toggle (already in requested state)

Status: `200`

```json
{
	"status": "success",
	"data": {
		"ratingId": "88888888-8888-4888-8888-888888888888",
		"isVisible": true,
		"changed": false
	}
}
```

#### Scenario: hide without `adminNotes`

Request:

```json
{
	"isVisible": false
}
```

Status: `400`

```json
{
	"status": "error",
	"message": "adminNotes is required when hiding a rating"
}
```

#### Scenario: rating not found

Status: `404`

```json
{
	"status": "error",
	"message": "Rating not found"
}
```

#### Scenario: invalid rating ID format

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "params.ratingId",
			"message": "Invalid rating ID"
		}
	]
}
```

#### Scenario: invalid `isVisible` type

Request:

```json
{
	"isVisible": "false"
}
```

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.isVisible",
			"message": "isVisible must be a boolean"
		}
	]
}
```

---

## Platform Analytics

### `GET /admin/analytics/platform`

Returns one dashboard snapshot with user, listing, connection, and rating metrics.

### Scenario: admin fetches analytics

Status: `200`

```json
{
	"status": "success",
	"data": {
		"users": {
			"total": 1240,
			"newToday": 18,
			"newThisWeek": 102,
			"byRole": {
				"student": 910,
				"pgOwner": 330
			},
			"byStatus": {
				"active": 1201,
				"restricted": 39
			}
		},
		"listings": {
			"total": 680,
			"active": 402,
			"filledThisMonth": 156,
			"expiredThisMonth": 39
		},
		"connections": {
			"total": 415,
			"totalConfirmed": 271,
			"confirmedThisMonth": 64
		},
		"ratings": {
			"total": 988,
			"visibleCount": 940,
			"hiddenCount": 48,
			"avgPlatformScore": 4.32
		}
	}
}
```

### Scenario: no visible ratings yet

Status: `200`

```json
{
	"status": "success",
	"data": {
		"ratings": {
			"total": 0,
			"visibleCount": 0,
			"hiddenCount": 0,
			"avgPlatformScore": null
		}
	}
}
```

### Scenario: transport or authorization failure

Status: `401` or `403`, with the same auth/role envelopes shown at the top of this document.

### Scenario: unexpected server error

Status: `500`

```json
{
	"status": "error",
	"message": "An unexpected error occurred"
}
```

---

## Integrator Notes

- Admin endpoints use a stable top-level envelope: `status`, then `data` or `message`.
- Queue/list endpoints use `data.items` + `data.nextCursor` for consistent infinite-scroll behavior.
- Verification queue currently returns snake_case item fields (`request_id`, `submitted_at`, etc.); newer admin
  endpoints return camelCase.
- `PATCH /admin/users/:userId/status` and `PATCH /admin/ratings/:ratingId/visibility` model lifecycle transitions
  explicitly and return the post-transition state.
- `resolved_removed` and direct rating hide both rely on DB triggers to keep rating aggregates consistent.
- Validation errors are always `400` with `message: "Validation failed"` plus structured `errors[]`.
- Any route may still return `500` with `"An unexpected error occurred"` for unhandled infrastructure/runtime failures.
