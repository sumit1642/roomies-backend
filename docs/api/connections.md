# Connections API

Connections are created internally when an interest request is accepted. API consumers never create connections directly.

## `GET /connections/me`

Returns the authenticated user's connection dashboard.

### Request Contract

- Auth required: Yes
- Query params:
  - `confirmationStatus`
  - `connectionType`
  - `limit`
  - `cursorTime`
  - `cursorId`

### Scenario: fetch my connections with filters

Request:

```http
GET /api/v1/connections/me?confirmationStatus=pending&connectionType=pg_stay
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "connectionId": "77777777-7777-4777-8777-777777777777",
        "connectionType": "pg_stay",
        "confirmationStatus": "pending",
        "initiatorConfirmed": true,
        "counterpartConfirmed": false,
        "startDate": null,
        "endDate": null,
        "createdAt": "2026-04-11T11:40:00.000Z",
        "updatedAt": "2026-04-11T11:40:00.000Z",
        "listing": {
          "listingId": "55555555-5555-4555-8555-555555555555",
          "title": "Single room in verified PG",
          "city": "Pune",
          "rentPerMonth": 9500,
          "listingType": "pg_room"
        },
        "otherParty": {
          "userId": "22222222-2222-4222-8222-222222222222",
          "fullName": "Rohan Mehta",
          "profilePhotoUrl": null,
          "averageRating": 4.5
        }
      }
    ],
    "nextCursor": null
  }
}
```

## `GET /connections/:connectionId`

Returns detail for a single connection.

### Scenario: one of the parties fetches connection detail

Status: `200`

```json
{
  "status": "success",
  "data": {
    "connectionId": "77777777-7777-4777-8777-777777777777",
    "connectionType": "pg_stay",
    "confirmationStatus": "pending",
    "initiatorConfirmed": true,
    "counterpartConfirmed": false,
    "startDate": null,
    "endDate": null,
    "interestRequestId": "66666666-6666-4666-8666-666666666666",
    "createdAt": "2026-04-11T11:40:00.000Z",
    "updatedAt": "2026-04-11T11:40:00.000Z",
    "listing": {
      "listingId": "55555555-5555-4555-8555-555555555555",
      "title": "Single room in verified PG",
      "city": "Pune",
      "rentPerMonth": 9500,
      "roomType": "single",
      "listingType": "pg_room"
    },
    "otherParty": {
      "userId": "22222222-2222-4222-8222-222222222222",
      "fullName": "Rohan Mehta",
      "profilePhotoUrl": null,
      "averageRating": 4.5,
      "ratingCount": 12
    }
  }
}
```

### Scenario: outsider tries to fetch connection

Status: `404`

```json
{
  "status": "error",
  "message": "Connection not found"
}
```

This is privacy-preserving. The API does not reveal whether the connection exists.

## `POST /connections/:connectionId/confirm`

Marks the caller's side of the real-world interaction as confirmed.

### Scenario: initiator confirms first

Status: `200`

```json
{
  "status": "success",
  "data": {
    "connectionId": "77777777-7777-4777-8777-777777777777",
    "initiatorConfirmed": true,
    "counterpartConfirmed": false,
    "confirmationStatus": "pending",
    "updatedAt": "2026-04-11T12:00:00.000Z"
  }
}
```

### Scenario: counterpart confirms later and connection becomes fully confirmed

Status: `200`

```json
{
  "status": "success",
  "data": {
    "connectionId": "77777777-7777-4777-8777-777777777777",
    "initiatorConfirmed": true,
    "counterpartConfirmed": true,
    "confirmationStatus": "confirmed",
    "updatedAt": "2026-04-12T09:00:00.000Z"
  }
}
```

Explanation: the connection moves to `confirmed` only when both confirmation flags are true in the same atomic update.

### Scenario: connection not found

Status: `404`

```json
{
  "status": "error",
  "message": "Connection not found"
}
```

## Integrator Notes

- There is intentionally no `POST /connections` endpoint.
- Ratings depend on a connection being `confirmed`, not merely existing.
- When a confirmation causes the connection to become fully confirmed, notifications are enqueued after commit for both parties.
