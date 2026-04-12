# Interest Requests API

Interest requests are the first step of the trust pipeline. Students send them. Listing posters review them. Accepting one can create a connection and may fill the listing.

## `POST /listings/:listingId/interests`

Student-only endpoint for expressing interest in a listing.

### Request Body

Minimal request:

```json
{}
```

With optional message:

```json
{
  "message": "Hi, I can move in by 1 May and would like to visit this weekend."
}
```

### Scenario: student sends interest with message

Status: `201`

```json
{
  "status": "success",
  "data": {
    "interestRequestId": "66666666-6666-4666-8666-666666666666",
    "studentId": "11111111-1111-4111-8111-111111111111",
    "listingId": "55555555-5555-4555-8555-555555555555",
    "message": "Hi, I can move in by 1 May and would like to visit this weekend.",
    "status": "pending",
    "createdAt": "2026-04-11T11:00:00.000Z"
  }
}
```

### Scenario: student sends interest without message

Status: `201`

```json
{
  "status": "success",
  "data": {
    "interestRequestId": "66666666-6666-4666-8666-666666666666",
    "studentId": "11111111-1111-4111-8111-111111111111",
    "listingId": "55555555-5555-4555-8555-555555555555",
    "message": null,
    "status": "pending",
    "createdAt": "2026-04-11T11:00:00.000Z"
  }
}
```

### Scenario: listing not found

Status: `404`

```json
{
  "status": "error",
  "message": "Listing not found"
}
```

### Scenario: listing expired

Status: `422`

```json
{
  "status": "error",
  "message": "Listing has expired and is no longer available"
}
```

### Scenario: listing unavailable

Status: `422`

```json
{
  "status": "error",
  "message": "Listing is no longer available"
}
```

### Scenario: student is the poster

Status: `422`

```json
{
  "status": "error",
  "message": "You cannot express interest in your own listing"
}
```

### Scenario: duplicate active request

Status: `409`

```json
{
  "status": "error",
  "message": "You already have a pending or accepted interest request for this listing"
}
```

## `GET /listings/:listingId/interests`

Poster-facing dashboard for all requests on a listing.

### Request Contract

- Auth required: Yes
- Listing ownership required: Yes
- Query params:
  - `status`
  - `limit`
  - `cursorTime`
  - `cursorId`

### Scenario: poster views listing interests

Status: `200`

```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "interestRequestId": "66666666-6666-4666-8666-666666666666",
        "studentId": "11111111-1111-4111-8111-111111111111",
        "status": "pending",
        "message": "Hi, I can move in by 1 May and would like to visit this weekend.",
        "createdAt": "2026-04-11T11:00:00.000Z",
        "updatedAt": "2026-04-11T11:00:00.000Z",
        "student": {
          "userId": "11111111-1111-4111-8111-111111111111",
          "fullName": "Priya Sharma",
          "profilePhotoUrl": null,
          "averageRating": 4.7
        }
      }
    ],
    "nextCursor": null
  }
}
```

### Scenario: non-owner tries to view listing interests

If the listing exists but belongs to someone else:

Status: `403`

```json
{
  "status": "error",
  "message": "You do not own this listing"
}
```

If the listing does not exist:

Status: `404`

```json
{
  "status": "error",
  "message": "Listing not found"
}
```

## `GET /interests/me`

Student-facing dashboard of all requests the authenticated student has sent.

### Scenario: success

Status: `200`

```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "interestRequestId": "66666666-6666-4666-8666-666666666666",
        "listingId": "55555555-5555-4555-8555-555555555555",
        "status": "pending",
        "message": "Hi, I can move in by 1 May and would like to visit this weekend.",
        "createdAt": "2026-04-11T11:00:00.000Z",
        "updatedAt": "2026-04-11T11:00:00.000Z",
        "listing": {
          "listingId": "55555555-5555-4555-8555-555555555555",
          "title": "Single room in verified PG",
          "city": "Pune",
          "listingType": "pg_room",
          "rentPerMonth": 9500
        }
      }
    ],
    "nextCursor": null
  }
}
```

## `GET /interests/:interestId`

Returns a single interest request if the caller is either the sender or the listing poster.

### Scenario: sender fetches request

Status: `200`

```json
{
  "status": "success",
  "data": {
    "interestRequestId": "66666666-6666-4666-8666-666666666666",
    "studentId": "11111111-1111-4111-8111-111111111111",
    "listingId": "55555555-5555-4555-8555-555555555555",
    "message": "Hi, I can move in by 1 May and would like to visit this weekend.",
    "status": "pending",
    "createdAt": "2026-04-11T11:00:00.000Z",
    "updatedAt": "2026-04-11T11:00:00.000Z",
    "listing": {
      "listingId": "55555555-5555-4555-8555-555555555555",
      "title": "Single room in verified PG",
      "city": "Pune",
      "listingType": "pg_room"
    },
    "student": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "fullName": "Priya Sharma",
      "profilePhotoUrl": null
    }
  }
}
```

### Scenario: poster fetches request

Status: `200`

Response shape is the same as above.

### Scenario: outsider fetches request

Status: `404`

```json
{
  "status": "error",
  "message": "Interest request not found"
}
```

This is privacy-preserving behavior. The API does not reveal whether the request exists.

## `PATCH /interests/:interestId/status`

Updates an interest request status.

Allowed body:

```json
{
  "status": "accepted"
}
```

Other allowed target values are `declined` and `withdrawn`.

### Scenario: poster declines pending request

Request:

```json
{
  "status": "declined"
}
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "interestRequestId": "66666666-6666-4666-8666-666666666666",
    "studentId": "11111111-1111-4111-8111-111111111111",
    "listingId": "55555555-5555-4555-8555-555555555555",
    "status": "declined",
    "updatedAt": "2026-04-11T11:30:00.000Z"
  }
}
```

### Scenario: student withdraws pending request

Request:

```json
{
  "status": "withdrawn"
}
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "interestRequestId": "66666666-6666-4666-8666-666666666666",
    "studentId": "11111111-1111-4111-8111-111111111111",
    "listingId": "55555555-5555-4555-8555-555555555555",
    "status": "withdrawn",
    "updatedAt": "2026-04-11T11:35:00.000Z"
  }
}
```

### Scenario: poster accepts pending request

Request:

```json
{
  "status": "accepted"
}
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "interestRequestId": "66666666-6666-4666-8666-666666666666",
    "studentId": "11111111-1111-4111-8111-111111111111",
    "listingId": "55555555-5555-4555-8555-555555555555",
    "status": "accepted",
    "connectionId": "77777777-7777-4777-8777-777777777777",
    "whatsappLink": "https://wa.me/+919876543210?text=Hi%20Rohan%20Mehta%2C%20my%20interest%20request%20for%20Single%20room%20in%20verified%20PG%20was%20accepted%21",
    "listingFilled": false
  }
}
```

### Accept side effects

When acceptance succeeds, the service does all of the following atomically before commit:

- marks the interest request as `accepted`
- creates a connection row
- increments `current_occupants`
- marks the listing `filled` when capacity is exhausted
- expires other pending requests when the listing becomes filled

After commit, notifications are enqueued asynchronously.

### Scenario: accept fails because request is no longer pending

Status: `422`

```json
{
  "status": "error",
  "message": "Cannot accept a request with status 'declined'"
}
```

### Scenario: decline or withdraw on non-pending request

Status: `409`

```json
{
  "status": "error",
  "message": "Interest request cannot be withdrawn — current status is 'accepted'"
}
```

### Scenario: actor is not allowed

Status: `403`

```json
{
  "status": "error",
  "message": "You are not authorised to perform this action"
}
```

### Scenario: listing expired during acceptance

Status: `422`

```json
{
  "status": "error",
  "message": "Listing has expired and is no longer available"
}
```

### Scenario: listing unavailable during acceptance

Status: `422`

```json
{
  "status": "error",
  "message": "Listing is no longer available"
}
```

### Scenario: concurrent listing status change

Status: `409`

```json
{
  "status": "error",
  "message": "Listing status has already changed — please refresh"
}
```

### Scenario: unsupported target status

Status: `400`

```json
{
  "status": "error",
  "message": "Invalid target status: expired"
}
```

## Interest Scenario Matrix

| Scenario | Actor | Status | Meaning |
| --- | --- | --- | --- |
| Create request | student | `201` | request stored as `pending` |
| Decline request | poster | `200` | request becomes `declined` |
| Withdraw request | student | `200` | request becomes `withdrawn` |
| Accept request | poster | `200` | request becomes `accepted`, connection created |
| Outsider reads request | unrelated user | `404` | existence hidden |
| Non-owner reads listing requests | unrelated user | `403` or `404` | ownership enforced |

## Integrator Notes

- Students can only create and withdraw their own requests.
- Posters can only accept or decline requests on their own listings.
- The accept path is the main trust pipeline transition and has the most side effects.
