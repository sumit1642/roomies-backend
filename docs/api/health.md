# Health API

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

### All services healthy

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

### Database degraded

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

### Database timed out

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

### Redis degraded

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

### Both dependencies degraded

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
