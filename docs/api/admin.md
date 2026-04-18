# Admin API

Admin routes are protected by both authentication and the `admin` role gate.

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

## Verification Queue

### `GET /admin/verification-queue`

Returns pending PG owner verification requests oldest-first.

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

#### Scenario: request already resolved or missing

Status: `409`

```json
{
  "status": "error",
  "message": "Verification request not found or already resolved"
}
```

## Report Moderation

### `GET /admin/report-queue`

Returns open rating reports oldest-first with full rating and reporter context.

Request contract:

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

Behavior: report rows are still returned even if reporter/reviewer/reviewee profile rows are soft-deleted; identity sub-objects may contain fallback nulls while moderation metadata remains available.

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

#### Scenario: report already resolved or missing

Status: `409`

```json
{
  "status": "error",
  "message": "Report not found or already resolved"
}
```

## Integrator Notes

- Verification queue and report queue both use oldest-first ordering to avoid starvation.
- `resolved_removed` hides the rating and lets the database recalculate aggregates automatically.
- Admin routes are fully protected at the router level with `authenticate` and `authorize("admin")`.
- Report queue joins are intentionally resilient so moderators can still resolve historical reports even when related accounts are no longer active.
