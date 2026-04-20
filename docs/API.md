# Roomies API Reference

This file is the API front door. Endpoint-by-endpoint contracts live in `docs/api/*`.

## Base URLs

- Live API base URL: `https://roomies-api.onrender.com/api/v1`
- Live health check: `https://roomies-api.onrender.com/api/v1/health`
- Local base URL: `http://localhost:3000/api/v1`

## Feature Docs

- [Shared conventions](./api/conventions.md)
- [Auth/Authz matrix](./api/authz-matrix.md)
- [Auth](./api/auth.md)
- [Profiles and contact reveal](./api/profiles-and-contact.md)
- [Properties](./api/properties.md)
- [Listings](./api/listings.api.md)
- [Interests](./api/interests.md)
- [Connections](./api/connections.md)
- [Notifications](./api/notifications.md)
- [Ratings and reports](./api/ratings-and-reports.md)
- [Preferences](./api/preferences.md)
- [Admin](./api/admin.md) _(currently not mounted in this workspace; calls return 404)_
- [Health](./api/health.md)

## Service-owned Documentation Model

To reduce drift, each backend service now has a dedicated service contract page in `docs/services/README.md` that maps:

- route entrypoints (`src/routes/*`)
- validation contracts (`src/validators/*`)
- business rules (`src/services/*`)
- worker side effects (`src/workers/*`)

API consumers should still start with feature docs in `docs/api/*`, then use service docs when they need
implementation-backed edge-case behavior.

## Response Envelopes

Success with data:

```json
{
	"status": "success",
	"data": {}
}
```

Operational error:

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

Validation error:

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.email",
			"message": "Must be a valid email address"
		}
	]
}
```

## Auth Transport Modes

### Cookie mode

- Auth endpoints set `accessToken` and `refreshToken` as `HttpOnly` cookies.
- Browser clients receive a safe body (no raw token strings).
- Silent refresh is cookie-only.

### Bearer mode

- Send `X-Client-Transport: bearer` on auth endpoints.
- Send `Authorization: Bearer <access-token>` on protected endpoints.
- Auth responses include raw access/refresh tokens in JSON.

## Gate and Error Semantics

- Route gates (`contactRevealGate`, role gates, `guestListingGate`) are first-class outcomes and documented in feature
  docs.
- PostgreSQL error mapping in global error handler:
    - `23505` → `409`
    - `23503` → `409`
    - `23514` → `400`

## Pagination Conventions

Feed endpoints use keyset pagination with:

- `limit`
- `cursorTime`
- `cursorId`

Typical shape:

```json
{
	"status": "success",
	"data": {
		"items": [],
		"nextCursor": {
			"cursorTime": "2026-04-11T07:15:00.000Z",
			"cursorId": "33333333-3333-4333-8333-333333333333"
		}
	}
}
```

If there is no next page, `nextCursor` is `null`.

### Cursor pairing rule

`cursorTime` and `cursorId` must be sent together (or both omitted). Supplying only one returns `400`.

Example:

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

## Background Jobs That Affect API Behavior

### Listing expiry

- File: `src/cron/listingExpiry.js`
- Default schedule: `0 2 * * *`
- Env override: `CRON_LISTING_EXPIRY`
- Behavior: expires active listings where `expires_at < NOW()`, bulk-expires pending interests, enqueues
  `listing_expired` notifications.

### Expiry warning

- File: `src/cron/expiryWarning.js`
- Default schedule: `0 1 * * *`
- Env override: `CRON_EXPIRY_WARNING`
- Behavior: enqueues `listing_expiring` notifications for listings expiring within 7 days.
- Idempotency key format: `expiry_warning:{listing_id}:{YYYY-MM-DD}`

### Hard-delete cleanup

- File: `src/cron/hardDeleteCleanup.js`
- Default schedule: `0 4 * * 0`
- Env override: `CRON_HARD_DELETE`
- Behavior: hard-deletes old soft-deleted rows.
- Retention env var: `SOFT_DELETE_RETENTION_DAYS` (default `90`). Must be plain decimal integer only (for example
  `"90"`).

## HTTP Status Codes

| Code  | Meaning                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `200` | Success                                                                                                                  |
| `201` | Created                                                                                                                  |
| `202` | Accepted (async processing started; for example photo upload)                                                            |
| `400` | Validation or malformed request                                                                                          |
| `401` | Missing/invalid/expired authentication                                                                                   |
| `403` | Forbidden                                                                                                                |
| `404` | Resource not found (includes privacy-preserving not-found patterns)                                                      |
| `409` | Conflict (duplicates, concurrent transitions, already-resolved states)                                                   |
| `413` | Payload too large                                                                                                        |
| `422` | Semantic business-rule violation                                                                                         |
| `429` | Rate-limited / gate-limited                                                                                              |
| `500` | Internal server error                                                                                                    |
| `503` | Service unavailable (dependency unhealthy/timeouts, and temporary queue-unavailable paths such as photo enqueue failure) |
