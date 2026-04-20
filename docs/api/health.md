# Health API

Shared conventions: [conventions.md](./conventions.md)

## Endpoint

### `GET /health`

Checks API dependency readiness for:

- PostgreSQL
- Redis

No authentication is required.

## Response Shape

The health endpoint does not use the standard `{ status, data }` wrapper. It returns a direct health object.

Healthy response:

```json
{
	"status": "ok",
	"timestamp": "2026-04-11T09:40:00.000Z",
	"services": {
		"database": "ok",
		"redis": "ok"
	}
}
```

## Scenarios

### Scenario: all services healthy

Status: `200`

```json
{
	"status": "ok",
	"timestamp": "2026-04-11T09:40:00.000Z",
	"services": {
		"database": "ok",
		"redis": "ok"
	}
}
```

### Scenario: database degraded

Status: `503`

```json
{
	"status": "degraded",
	"timestamp": "2026-04-11T09:40:00.000Z",
	"services": {
		"database": "unhealthy",
		"redis": "ok"
	}
}
```

### Scenario: database timed out

Status: `503`

```json
{
	"status": "degraded",
	"timestamp": "2026-04-11T09:40:00.000Z",
	"services": {
		"database": "timeout",
		"redis": "ok"
	}
}
```

### Scenario: redis degraded

Status: `503`

```json
{
	"status": "degraded",
	"timestamp": "2026-04-11T09:40:00.000Z",
	"services": {
		"database": "ok",
		"redis": "unhealthy"
	}
}
```

### Scenario: redis timed out

Status: `503`

```json
{
	"status": "degraded",
	"timestamp": "2026-04-11T09:40:00.000Z",
	"services": {
		"database": "ok",
		"redis": "timeout"
	}
}
```

### Scenario: both dependencies degraded

Status: `503`

```json
{
	"status": "degraded",
	"timestamp": "2026-04-11T09:40:00.000Z",
	"services": {
		"database": "timeout",
		"redis": "unhealthy"
	}
}
```

## Notes

- The endpoint runs a timed probe against both dependencies.
- Internal connection details are never exposed in the response.
- Detailed failure information is logged server-side only.
