# Ratings and Reports API

Shared conventions: [conventions.md](./conventions.md)

Ratings are the reputation layer built on top of confirmed connections. Reports are the moderation layer for disputed
ratings.

## Ratings

### `POST /ratings`

Submits a rating for either a user or a property, anchored to a confirmed connection.

### Request Body

Minimal user-rating request:

```json
{
	"connectionId": "77777777-7777-4777-8777-777777777777",
	"revieweeType": "user",
	"revieweeId": "22222222-2222-4222-8222-222222222222",
	"overallScore": 5
}
```

Full property-rating request:

```json
{
	"connectionId": "77777777-7777-4777-8777-777777777777",
	"revieweeType": "property",
	"revieweeId": "44444444-4444-4444-8444-444444444444",
	"overallScore": 4,
	"cleanlinessScore": 5,
	"communicationScore": 4,
	"reliabilityScore": 4,
	"valueScore": 4,
	"comment": "Clean property and smooth onboarding process."
}
```

### Scenario: submit user rating after confirmed connection

Status: `201`

```json
{
	"status": "success",
	"data": {
		"ratingId": "88888888-8888-4888-8888-888888888888",
		"createdAt": "2026-04-12T10:00:00.000Z"
	}
}
```

### Scenario: submit property rating after confirmed stay

Status: `201`

```json
{
	"status": "success",
	"data": {
		"ratingId": "88888888-8888-4888-8888-888888888888",
		"createdAt": "2026-04-12T10:00:00.000Z"
	}
}
```

### Scenario: comment omitted

The request is valid without `comment`, and optional dimension scores may also be omitted.

### Scenario: invalid `revieweeType`

Status: `400`

```json
{
	"status": "error",
	"message": "Invalid revieweeType: must be 'user' or 'property'"
}
```

### Scenario: reviewee user not found

Status: `404`

```json
{
	"status": "error",
	"message": "Reviewee user not found"
}
```

### Scenario: reviewee property not found

Status: `404`

```json
{
	"status": "error",
	"message": "Reviewee property not found"
}
```

### Scenario: connection not found

Status: `404`

```json
{
	"status": "error",
	"message": "Connection not found"
}
```

### Scenario: connection exists but is not confirmed

Status: `422`

```json
{
	"status": "error",
	"message": "Ratings can only be submitted for confirmed connections"
}
```

### Scenario: caller tries to rate themselves or an invalid party

Status: `422`

```json
{
	"status": "error",
	"message": "The reviewee is not a valid party to this connection, or you cannot rate yourself"
}
```

### Scenario: duplicate rating

Status: `409`

```json
{
	"status": "error",
	"message": "You have already submitted a rating for this connection and reviewee"
}
```

## `GET /ratings/connection/:connectionId`

Returns ratings for one connection from the caller's perspective.

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"myRatings": [
			{
				"ratingId": "88888888-8888-4888-8888-888888888888",
				"reviewerId": "11111111-1111-4111-8111-111111111111",
				"revieweeType": "user",
				"revieweeId": "22222222-2222-4222-8222-222222222222",
				"overallScore": 5,
				"cleanlinessScore": null,
				"communicationScore": null,
				"reliabilityScore": null,
				"valueScore": null,
				"comment": "Very responsive and transparent.",
				"createdAt": "2026-04-12T10:00:00.000Z"
			}
		],
		"theirRatings": []
	}
}
```

### Scenario: outsider tries to view connection ratings

Status: `404`

```json
{
	"status": "error",
	"message": "Connection not found"
}
```

## `GET /ratings/user/:userId`

Public endpoint that returns visible ratings received by a user.

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"ratingId": "88888888-8888-4888-8888-888888888888",
				"overallScore": 5,
				"cleanlinessScore": 5,
				"communicationScore": 5,
				"reliabilityScore": 5,
				"valueScore": 4,
				"comment": "Very responsive and transparent.",
				"createdAt": "2026-04-12T10:00:00.000Z",
				"reviewer": {
					"fullName": "Priya Sharma",
					"profilePhotoUrl": null
				}
			}
		],
		"nextCursor": null
	}
}
```

## `GET /ratings/me/given`

Returns the authenticated user's rating history, including `isVisible`.

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"ratingId": "88888888-8888-4888-8888-888888888888",
				"connectionId": "77777777-7777-4777-8777-777777777777",
				"revieweeType": "user",
				"revieweeId": "22222222-2222-4222-8222-222222222222",
				"overallScore": 5,
				"cleanlinessScore": 5,
				"communicationScore": 5,
				"reliabilityScore": 5,
				"valueScore": 4,
				"comment": "Very responsive and transparent.",
				"isVisible": true,
				"createdAt": "2026-04-12T10:00:00.000Z",
				"reviewee": {
					"fullName": "Rohan Mehta",
					"profilePhotoUrl": null,
					"type": "user"
				}
			}
		],
		"nextCursor": null
	}
}
```

## `GET /ratings/property/:propertyId`

Public endpoint that returns visible ratings received by a property.

### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"ratingId": "88888888-8888-4888-8888-888888888888",
				"overallScore": 4,
				"cleanlinessScore": 5,
				"communicationScore": 4,
				"reliabilityScore": 4,
				"valueScore": 4,
				"comment": "Clean property and smooth onboarding process.",
				"createdAt": "2026-04-12T10:00:00.000Z",
				"reviewer": {
					"fullName": "Priya Sharma",
					"profilePhotoUrl": null
				}
			}
		],
		"nextCursor": null
	}
}
```

### Scenario: property not found

Status: `404`

```json
{
	"status": "error",
	"message": "Property not found"
}
```

## Reports

### `POST /ratings/:ratingId/report`

Lets a party to the underlying connection report a rating.

### Request Contract

- Auth required: Yes
- Party-membership gate: Yes (must belong to the connection behind the rating)
- Path param:
    - `ratingId` must be a UUID
- Body:
    - `reason` enum: `fake | abusive | conflict_of_interest | other`
    - `explanation` optional free-text context

### Request Examples

```json
{
	"reason": "fake",
	"explanation": "The stay never happened and this review is fabricated."
}
```

```json
{
	"reason": "abusive",
	"explanation": "The review contains personal abuse unrelated to the stay."
}
```

```json
{
	"reason": "conflict_of_interest",
	"explanation": "The reviewer is closely connected to the property owner."
}
```

```json
{
	"reason": "other",
	"explanation": "Additional context for the moderator."
}
```

### Scenario: report submitted successfully

Status: `201`

```json
{
	"status": "success",
	"data": {
		"reportId": "99999999-9999-4999-8999-999999999999",
		"reporterId": "11111111-1111-4111-8111-111111111111",
		"ratingId": "88888888-8888-4888-8888-888888888888",
		"reason": "fake",
		"status": "open",
		"createdAt": "2026-04-12T11:00:00.000Z"
	}
}
```

### Scenario: rating not found or reporter is not a party

Status: `404`

```json
{
	"status": "error",
	"message": "Rating not found or you are not a party to this connection"
}
```

Explanation: this route intentionally returns a privacy-preserving `404` so outsiders cannot probe whether a rating
exists.

### Scenario: duplicate open report

Status: `409`

```json
{
	"status": "error",
	"message": "A record with this value already exists"
}
```

Explanation: duplicate open reports hit the database unique constraint and are surfaced by the global PostgreSQL
conflict handler.

## Report Re-Submission Rule

The code allows only one open report per reporter per rating at a time.

- open report already exists: conflict
- previous report resolved: a new report may be submitted later

## Admin Moderation Linkage

After submission, open reports flow into the admin queue:

- `GET /admin/report-queue` returns open reports oldest-first.
- `PATCH /admin/reports/:reportId/resolve` closes a report as:
    - `resolved_kept` (rating remains visible), or
    - `resolved_removed` (rating is hidden).

When `resolved_removed` is used, rating visibility is turned off and aggregate recomputation is handled downstream by
database trigger logic.

## Ratings and Reports Scenario Matrix

| Scenario                                    | Status | Why                                                       |
| ------------------------------------------- | ------ | --------------------------------------------------------- |
| Rate after confirmed connection             | `201`  | trust gate satisfied                                      |
| Rate before confirmation                    | `422`  | connection exists but is not yet eligible                 |
| Rate wrong target or self                   | `422`  | reviewee is not a valid rating target for that connection |
| Public property ratings on missing property | `404`  | property existence checked first                          |
| Report duplicate open report                | `409`  | partial unique index on open reports                      |

## Integrator Notes

- Ratings for users and properties share the same endpoint, distinguished by `revieweeType`.
- Public ratings endpoints only return visible ratings.
- Reviewers can still see their own hidden ratings in `GET /ratings/me/given` because that endpoint includes
  `isVisible`.
