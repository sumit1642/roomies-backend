# Listings API

Shared conventions: [conventions.md](./conventions.md)

This document covers listing discovery, CRUD, lifecycle transitions, preferences, saved listings, and photo processing.

Listings are role-sensitive:

- students can create `student_room` listings
- verified PG owners can create `pg_room` and `hostel_bed` listings

Prices are expressed in rupees in the API, even though the database stores paise internally.

## Auth Policy for Read Routes

`GET /listings` and `GET /listings/:listingId` are the only listing endpoints that accept unauthenticated requests. All
other listing endpoints require a valid access token.

| Caller           | Browsing                       | Compatibility score       | Saving          | Interest        |
| ---------------- | ------------------------------ | ------------------------- | --------------- | --------------- |
| Guest (no token) | ✅ Up to 20 items per request  | ❌ Always 0 / unavailable | ❌ 401          | ❌ 401          |
| Authenticated    | ✅ Up to 100 items per request | ✅ When preferences exist | ✅ Student only | ✅ Student only |

Guests receive identical listing data to authenticated users. The only differences are the item cap, the absence of
compatibility scoring, and the inability to use write endpoints.

## Search and Retrieval

### `GET /listings`

Searches active, non-expired listings.

#### Request Contract

- Auth required: **No** (auth optional — send a token to unlock compatibility scoring and higher page limits)
- Supported query filters:
    - `city`
    - `minRent`
    - `maxRent`
    - `roomType`
    - `bedType`
    - `preferredGender`
    - `listingType`
    - `availableFrom`
    - `lat`, `lng`
    - `radius`
    - `amenityIds`
    - `limit`
    - `cursorTime`
    - `cursorId`

#### Scenario: guest searches with city filter

Request (no Authorization header, no cookie):

```http
GET /api/v1/listings?city=Pune&listingType=pg_room
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listingId": "55555555-5555-4555-8555-555555555555",
				"listingType": "pg_room",
				"title": "Single room near Viman Nagar",
				"city": "Pune",
				"locality": "Viman Nagar",
				"rentPerMonth": 9500,
				"depositAmount": 5000,
				"compatibilityScore": 0,
				"compatibilityAvailable": false,
				"roomType": "single",
				"preferredGender": "female",
				"availableFrom": "2026-05-01T00:00:00.000Z",
				"status": "active"
			}
		],
		"nextCursor": null
	}
}
```

`compatibilityScore` is always `0` and `compatibilityAvailable` is always `false` for guests.

#### Scenario: authenticated search with city, rent, and amenity filters

Request:

```http
GET /api/v1/listings?city=Pune&minRent=7000&maxRent=12000&listingType=pg_room&amenityIds=2db2f8fc-d90c-47a1-aebb-c6fa9ea4450a,eec6f390-2906-4d50-bf26-4f937833c6f8
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listingId": "55555555-5555-4555-8555-555555555555",
				"listingType": "pg_room",
				"title": "Single room near Viman Nagar",
				"city": "Pune",
				"locality": "Viman Nagar",
				"rentPerMonth": 9500,
				"depositAmount": 5000,
				"compatibilityScore": 2,
				"compatibilityAvailable": true,
				"roomType": "single",
				"preferredGender": "female",
				"availableFrom": "2026-05-01T00:00:00.000Z",
				"status": "active"
			}
		],
		"nextCursor": null
	}
}
```

#### Scenario: search with proximity filters

Request:

```http
GET /api/v1/listings?lat=18.5679&lng=73.9143&radius=5000&listingType=pg_room
```

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listingId": "55555555-5555-4555-8555-555555555555",
				"listingType": "pg_room",
				"title": "Single room near Viman Nagar",
				"city": "Pune",
				"rentPerMonth": 9500,
				"compatibilityScore": 0,
				"compatibilityAvailable": false
			}
		],
		"nextCursor": {
			"cursorTime": "2026-04-11T10:20:00.000Z",
			"cursorId": "55555555-5555-4555-8555-555555555555"
		}
	}
}
```

#### Scenario: invalid rent range

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.minRent",
			"message": "minRent cannot be greater than maxRent"
		}
	]
}
```

#### Scenario: only one proximity coordinate is supplied

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "query.lng",
			"message": "lat and lng must be provided together for proximity search"
		}
	]
}
```

#### Scenario: partial cursor supplied

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

### `GET /listings/:listingId`

Fetches full listing detail. Also increments `views_count` asynchronously.

#### Request Contract

- Auth required: **No** (auth optional)

#### Scenario: guest fetches listing detail

Status: `200`

Full listing object is returned. Same shape as the authenticated response below.

#### Scenario: authenticated fetch

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"postedBy": "22222222-2222-4222-8222-222222222222",
		"propertyId": "44444444-4444-4444-8444-444444444444",
		"listingType": "pg_room",
		"title": "Single room near Viman Nagar",
		"description": "Ideal for students and interns.",
		"rentPerMonth": 9500,
		"depositAmount": 5000,
		"roomType": "single",
		"bedType": "single_bed",
		"totalCapacity": 1,
		"currentOccupants": 0,
		"preferredGender": "female",
		"availableFrom": "2026-05-01T00:00:00.000Z",
		"availableUntil": null,
		"addressLine": null,
		"city": "Pune",
		"locality": null,
		"landmark": null,
		"pincode": null,
		"latitude": null,
		"longitude": null,
		"status": "active",
		"viewsCount": 12,
		"expiresAt": "2026-06-10T10:00:00.000Z",
		"poster_rating": 4.5,
		"poster_rating_count": 12,
		"poster_name": "Rohan Mehta",
		"amenities": [],
		"preferences": [],
		"photos": [],
		"property": {
			"propertyId": "44444444-4444-4444-8444-444444444444",
			"propertyName": "Sunrise PG Viman Nagar",
			"propertyType": "pg",
			"addressLine": "Lane 5, Viman Nagar",
			"city": "Pune",
			"locality": "Viman Nagar",
			"latitude": 18.5679,
			"longitude": 73.9143,
			"houseRules": "No smoking inside rooms.",
			"averageRating": 4.5,
			"ratingCount": 12
		}
	}
}
```

#### Scenario: listing not found

Status: `404`

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

## Create, Update, and Delete

### `POST /listings`

Creates a listing owned by the authenticated user.

**Auth required.**

#### Student room request example

```json
{
	"listingType": "student_room",
	"title": "Looking for a roommate near IIT Bombay",
	"description": "Two-bedroom flat, one room available.",
	"rentPerMonth": 12000,
	"depositAmount": 15000,
	"rentIncludesUtilities": false,
	"isNegotiable": true,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "female",
	"availableFrom": "2026-05-01",
	"addressLine": "Flat 8B, Powai Residency",
	"city": "Mumbai",
	"locality": "Powai",
	"landmark": "Near IIT Main Gate",
	"pincode": "400076",
	"latitude": 19.1334,
	"longitude": 72.9133,
	"amenityIds": [],
	"preferences": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		}
	]
}
```

#### PG room request example

```json
{
	"listingType": "pg_room",
	"propertyId": "44444444-4444-4444-8444-444444444444",
	"title": "Single room in verified PG",
	"description": "Meals and Wi-Fi included.",
	"rentPerMonth": 9500,
	"depositAmount": 5000,
	"rentIncludesUtilities": true,
	"isNegotiable": false,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "female",
	"availableFrom": "2026-05-01",
	"amenityIds": [],
	"preferences": []
}
```

#### Scenario: student creates `student_room`

Status: `201`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"listingType": "student_room",
		"title": "Looking for a roommate near IIT Bombay",
		"rentPerMonth": 12000
	}
}
```

#### Scenario: PG owner creates `pg_room`

Status: `201`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"listingType": "pg_room",
		"propertyId": "44444444-4444-4444-8444-444444444444",
		"title": "Single room in verified PG",
		"rentPerMonth": 9500
	}
}
```

#### Scenario: PG owner creates `hostel_bed`

Status: `201`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"listingType": "hostel_bed",
		"propertyId": "44444444-4444-4444-8444-444444444444",
		"title": "Hostel bed near college",
		"rentPerMonth": 6500
	}
}
```

#### Scenario: student tries to create `pg_room`

Status: `403`

```json
{
	"status": "error",
	"message": "Only verified PG owners can create pg_room or hostel_bed listings"
}
```

#### Scenario: PG owner tries to create `student_room`

Status: `403`

```json
{
	"status": "error",
	"message": "Only students can create student_room listings"
}
```

#### Scenario: PG owner is not verified

Status: `403`

```json
{
	"status": "error",
	"message": "Your account must be verified before you can manage properties or listings"
}
```

#### Scenario: property does not belong to owner

Status: `404`

```json
{
	"status": "error",
	"message": "Property not found or does not belong to you"
}
```

#### Scenario: student-room create missing `addressLine` and `city`

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.addressLine",
			"message": "addressLine and city are required for student_room listings"
		}
	]
}
```

#### Scenario: PG or hostel create includes coordinates

Status: `400`

```json
{
	"status": "error",
	"message": "Validation failed",
	"errors": [
		{
			"field": "body.latitude",
			"message": "Coordinates are not accepted for pg_room or hostel_bed listings — location is inherited from the property"
		}
	]
}
```

### `PUT /listings/:listingId`

**Auth required.** Updates a listing owned by the authenticated user.

#### Request example

```json
{
	"title": "Updated title",
	"description": "Now includes cleaning twice a week.",
	"rentPerMonth": 9800,
	"isNegotiable": true
}
```

#### Scenario: update succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"title": "Updated title",
		"rentPerMonth": 9800,
		"isNegotiable": true
	}
}
```

#### Scenario: no valid fields provided

Status: `400`

```json
{
	"status": "error",
	"message": "No valid fields provided for update"
}
```

#### Scenario: PG/hostel update attempts property-owned location fields

Status: `422`

```json
{
	"status": "error",
	"message": "Location fields (city, latitude) cannot be updated on a pg_room listing — they are inherited from the parent property. Update the property's address instead."
}
```

#### Scenario: listing not found

Status: `404`

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

### `DELETE /listings/:listingId`

**Auth required.** Soft-deletes a listing and expires pending requests.

#### Scenario: delete succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"deleted": true
	}
}
```

## Lifecycle and Preferences

### `PATCH /listings/:listingId/status`

**Auth required.** Supports poster-driven lifecycle transitions among `active`, `filled`, and `deactivated`.

#### Request

```json
{
	"status": "deactivated"
}
```

#### Scenario: update from active to deactivated

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"status": "deactivated"
	}
}
```

#### Scenario: update from active to filled

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"status": "filled"
	}
}
```

#### Scenario: invalid transition

Status: `422`

```json
{
	"status": "error",
	"message": "Cannot change listing status from 'filled' to 'deactivated'"
}
```

#### Scenario: listing already expired

Status: `422`

```json
{
	"status": "error",
	"message": "Listing has expired and is no longer available"
}
```

#### Scenario: concurrent state change

Status: `409`

```json
{
	"status": "error",
	"message": "Listing status has already changed — please refresh"
}
```

### `GET /listings/:listingId/preferences`

**Auth required.**

#### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		},
		{
			"preferenceKey": "cleanliness",
			"preferenceValue": "high"
		}
	]
}
```

### `PUT /listings/:listingId/preferences`

**Auth required.**

#### Request

```json
{
	"preferences": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		}
	]
}
```

#### Scenario: update preferences succeeds

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"preferenceKey": "sleep_schedule",
			"preferenceValue": "early"
		}
	]
}
```

## Interest Requests (Listing-Scoped)

These are child-resource routes under a listing and are mounted in the listings router.

### `POST /listings/:listingId/interests`

Creates an interest request on a listing.

**Auth required.** Role: `student`.

#### Request body

Minimal body:

```json
{}
```

With optional message:

```json
{
	"message": "Hi, I can move in by 1 May and would like to visit this weekend."
}
```

#### Scenario: interest created with message

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

#### Scenario: interest created without message

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

#### Scenario: listing not found

Status: `404`

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

#### Scenario: listing expired

Status: `422`

```json
{
	"status": "error",
	"message": "Listing has expired and is no longer available"
}
```

#### Scenario: listing not active

Status: `422`

```json
{
	"status": "error",
	"message": "Listing is no longer available"
}
```

#### Scenario: student tries own listing

Status: `422`

```json
{
	"status": "error",
	"message": "You cannot express interest in your own listing"
}
```

#### Scenario: duplicate active request (pending/accepted already exists)

Status: `409`

```json
{
	"status": "error",
	"message": "You already have a pending or accepted interest request for this listing"
}
```

### `GET /listings/:listingId/interests`

Poster-facing list of requests for one listing.

**Auth required.** Ownership required.

#### Query params

- `status` (`pending | accepted | declined | withdrawn | expired`)
- `limit`
- `cursorTime`
- `cursorId`

Sorted by `createdAt DESC`, then `interestRequestId ASC`.

#### Scenario: listing owner fetches interest requests

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

#### Scenario: caller does not own the listing

Status: `403`

```json
{
	"status": "error",
	"message": "You do not own this listing"
}
```

#### Scenario: listing not found

Status: `404`

```json
{
	"status": "error",
	"message": "Listing not found"
}
```

## Saved Listings

### `POST /listings/:listingId/save`

**Auth required.** Role: `student`.

#### Scenario: save succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"saved": true
	}
}
```

#### Scenario: wrong role

Status: `403`

```json
{
	"status": "error",
	"message": "Forbidden"
}
```

#### Scenario: listing expired

Status: `422`

```json
{
	"status": "error",
	"message": "Listing has expired and is no longer available"
}
```

#### Scenario: listing unavailable

Status: `422`

```json
{
	"status": "error",
	"message": "Listing is no longer available"
}
```

### `DELETE /listings/:listingId/save`

**Auth required.** Role: `student`.

#### Scenario: unsave succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"listingId": "55555555-5555-4555-8555-555555555555",
		"saved": false
	}
}
```

### `GET /listings/me/saved`

**Auth required.** Role: `student`. Returns the student's saved active listings.

#### Scenario: paginated saved listings

Status: `200`

```json
{
	"status": "success",
	"data": {
		"items": [
			{
				"listing_id": "55555555-5555-4555-8555-555555555555",
				"listing_type": "pg_room",
				"title": "Single room in verified PG",
				"city": "Pune",
				"locality": "Viman Nagar",
				"room_type": "single",
				"preferred_gender": "female",
				"available_from": "2026-05-01T00:00:00.000Z",
				"status": "active",
				"saved_at": "2026-04-11T10:30:00.000Z",
				"property_name": "Sunrise PG Viman Nagar",
				"average_rating": 4.5,
				"cover_photo_url": null,
				"rentPerMonth": 9500,
				"depositAmount": 5000
			}
		],
		"nextCursor": null
	}
}
```

## Photos

Photo uploads are asynchronous. The HTTP request inserts a provisional row and queues a worker job. Clients should poll
`GET /listings/:listingId/photos`.

**All photo endpoints require authentication.**

### `GET /listings/:listingId/photos`

Returns completed photos only. Processing placeholders are hidden.

#### Scenario: success

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
			"photoUrl": "https://storage.example.com/listings/555/photo-1.webp",
			"isCover": true,
			"displayOrder": 0,
			"createdAt": "2026-04-11T10:40:00.000Z"
		}
	]
}
```

### `POST /listings/:listingId/photos`

**Auth required.** Uploads a staged image using `multipart/form-data`.

#### Multipart requirements

- field name: `photo`
- accepted MIME types: `image/jpeg`, `image/png`, `image/webp`
- max size: `10MB`

#### Scenario: upload accepted and queued

Status: `202`

```json
{
	"status": "success",
	"data": {
		"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
		"status": "processing"
	}
}
```

#### Scenario: file missing

Status: `400`

```json
{
	"status": "error",
	"message": "No file uploaded — send the image under the field name 'photo'"
}
```

#### Scenario: unsupported MIME or extension

Status: `400`

```json
{
	"status": "error",
	"message": "Unsupported file type: image/gif. Accepted types: JPEG, PNG, WebP"
}
```

#### Scenario: queue unavailable

Status: `503`

```json
{
	"status": "error",
	"message": "Photo processing queue is temporarily unavailable. Please retry."
}
```

### `DELETE /listings/:listingId/photos/:photoId`

**Auth required.**

#### Scenario: delete succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
		"deleted": true
	}
}
```

### `PATCH /listings/:listingId/photos/:photoId/cover`

**Auth required.**

#### Scenario: set cover succeeds

Status: `200`

```json
{
	"status": "success",
	"data": {
		"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
		"isCover": true
	}
}
```

### `PUT /listings/:listingId/photos/reorder`

**Auth required.**

#### Request

```json
{
	"photos": [
		{
			"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
			"displayOrder": 0
		},
		{
			"photoId": "bcf8f73b-b1bd-4e30-9a7e-a82a18252d28",
			"displayOrder": 1
		}
	]
}
```

#### Scenario: reorder succeeds

Status: `200`

```json
{
	"status": "success",
	"data": [
		{
			"photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
			"photoUrl": "https://storage.example.com/listings/555/photo-1.webp",
			"isCover": true,
			"displayOrder": 0,
			"createdAt": "2026-04-11T10:40:00.000Z"
		}
	]
}
```

#### Scenario: duplicate `photoId`

Status: `422`

```json
{
	"status": "error",
	"message": "Duplicate photo IDs in reorder payload: 6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e"
}
```

#### Scenario: incomplete payload

Status: `422`

```json
{
	"status": "error",
	"message": "Reorder payload must include all photos. Submitted 1, expected 3."
}
```

## Listing Scenario Matrix

| Scenario                         | Endpoint                              | Status | Key behavior                               |
| -------------------------------- | ------------------------------------- | ------ | ------------------------------------------ |
| Guest browses listings           | `GET /listings`                       | `200`  | up to 20 items, no compatibility score     |
| Guest fetches listing detail     | `GET /listings/:listingId`            | `200`  | full detail, no auth required              |
| Guest tries to save a listing    | `POST /listings/:listingId/save`      | `401`  | auth required                              |
| Guest tries to express interest  | `POST /listings/:listingId/interests` | `401`  | auth required                              |
| Student sends interest request   | `POST /listings/:listingId/interests` | `201`  | creates pending request                    |
| Poster lists listing interests   | `GET /listings/:listingId/interests`  | `200`  | owner-only, keyset paginated               |
| Student creates roommate listing | `POST /listings`                      | `201`  | requires address and city                  |
| PG owner creates PG listing      | `POST /listings`                      | `201`  | requires verified owner and owned property |
| Expired listing save attempt     | `POST /listings/:listingId/save`      | `422`  | expired listings cannot be saved           |
| Status changed concurrently      | `PATCH /listings/:listingId/status`   | `409`  | caller should refresh                      |
| Photo upload request             | `POST /listings/:listingId/photos`    | `202`  | worker-based async processing              |

## Integrator Notes

- `GET /listings` and `GET /listings/:listingId` are the only endpoints that accept requests without a token.
- Guests see at most 20 listings per request. Authenticated users may request up to 100.
- `compatibilityScore` and `compatibilityAvailable` are always `0` / `false` for guests — there are no user preferences
  to compare against.
- `student_room` listings own their own location fields. `pg_room` and `hostel_bed` listings inherit location from the
  parent property.
- `GET /listings/:listingId/interests` is poster-only; ownership is enforced server-side.
- Listing expiry is also system-driven (cron). Expired listings are moved to `expired` and pending interest requests are
  expired in bulk.
- Photo uploads are not immediately visible after `202 Accepted`.
- Saved listings only return currently active, non-expired listings.
