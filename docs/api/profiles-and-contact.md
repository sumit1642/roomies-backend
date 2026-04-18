# Profiles and Contact Reveal API

This document covers student profiles, PG owner profiles, contact reveal behavior, and PG owner verification document submission.

## `GET /students/:userId/profile`

Returns a student profile. The authenticated caller can always fetch the profile, but private fields such as email are only included when the caller is the profile owner.

### Request Contract

- Auth required: Yes
- Path param:
  - `userId` must be a UUID

### Scenario: fetch existing student profile as another authenticated user

Status: `200`

```json
{
  "status": "success",
  "data": {
    "profile_id": "a11f71df-dbc0-4b7c-a9a8-9718eebdd9d1",
    "user_id": "11111111-1111-4111-8111-111111111111",
    "full_name": "Priya Sharma",
    "date_of_birth": "2003-08-15T00:00:00.000Z",
    "gender": "female",
    "profile_photo_url": null,
    "bio": "I am looking for a quiet flatmate near Powai.",
    "course": "B.Tech",
    "year_of_study": 3,
    "institution_id": "c478b4c9-f4cf-4d58-b577-c5bca50d6f34",
    "is_aadhaar_verified": false,
    "email": null,
    "is_email_verified": true,
    "average_rating": 4.7,
    "rating_count": 6,
    "created_at": "2026-04-01T10:00:00.000Z"
  }
}
```

### Scenario: fetch own student profile

Status: `200`

```json
{
  "status": "success",
  "data": {
    "profile_id": "a11f71df-dbc0-4b7c-a9a8-9718eebdd9d1",
    "user_id": "11111111-1111-4111-8111-111111111111",
    "full_name": "Priya Sharma",
    "date_of_birth": "2003-08-15T00:00:00.000Z",
    "gender": "female",
    "profile_photo_url": null,
    "bio": "I am looking for a quiet flatmate near Powai.",
    "course": "B.Tech",
    "year_of_study": 3,
    "institution_id": "c478b4c9-f4cf-4d58-b577-c5bca50d6f34",
    "is_aadhaar_verified": false,
    "email": "priya@iitb.ac.in",
    "is_email_verified": true,
    "average_rating": 4.7,
    "rating_count": 6,
    "created_at": "2026-04-01T10:00:00.000Z"
  }
}
```

### Scenario: profile not found

Status: `404`

```json
{
  "status": "error",
  "message": "Student profile not found"
}
```

## `PUT /students/:userId/profile`

Updates the authenticated student profile.

### Request Body

Minimal valid body:

```json
{
  "bio": "Need a flatmate who is okay with early classes."
}
```

Full request example:

```json
{
  "fullName": "Priya Sharma",
  "bio": "Need a flatmate who is okay with early classes.",
  "course": "B.Tech CSE",
  "yearOfStudy": 3,
  "gender": "female",
  "dateOfBirth": "2003-08-15"
}
```

### Scenario: update own student profile

Status: `200`

```json
{
  "status": "success",
  "data": {
    "profile_id": "a11f71df-dbc0-4b7c-a9a8-9718eebdd9d1",
    "user_id": "11111111-1111-4111-8111-111111111111",
    "full_name": "Priya Sharma",
    "bio": "Need a flatmate who is okay with early classes.",
    "course": "B.Tech CSE",
    "year_of_study": 3,
    "gender": "female",
    "date_of_birth": "2003-08-15T00:00:00.000Z"
  }
}
```

### Scenario: caller tries to edit another student's profile

Status: `403`

```json
{
  "status": "error",
  "message": "Forbidden"
}
```

### Scenario: no valid fields provided

Status: `400`

```json
{
  "status": "error",
  "message": "No valid fields provided for update"
}
```

## `GET /students/:userId/contact/reveal`

Reveals student contact information using the guest/unverified/verified contact policy.

### Request Contract

- Auth required: Optional
- Auth transport accepted:
  - Cookie mode (`accessToken` cookie)
  - Bearer mode (`Authorization: Bearer <access-token>`)
- Quota-gated for guests and unverified users
- Student route uses `GET`
- Response header: `Cache-Control: no-store`

### Scenario: guest reveal gets email-only bundle

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user_id": "11111111-1111-4111-8111-111111111111",
    "full_name": "Priya Sharma",
    "email": "priya@iitb.ac.in"
  }
}
```

### Scenario: unverified logged-in user still gets email-only bundle

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user_id": "11111111-1111-4111-8111-111111111111",
    "full_name": "Priya Sharma",
    "email": "priya@iitb.ac.in"
  }
}
```

### Scenario: verified user still receives the student route response actually enforced by the service

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user_id": "11111111-1111-4111-8111-111111111111",
    "full_name": "Priya Sharma",
    "email": "priya@iitb.ac.in",
    "whatsapp_phone": "+919876543210"
  }
}
```

Important note: the reveal gate is the single source of truth for full-contact eligibility. Verified users receive full contact; guests and unverified users receive email-only.

### Scenario: guest hits free reveal limit

Status: `429`

```json
{
  "status": "error",
  "message": "Free contact reveal limit reached. Please log in or sign up to continue.",
  "code": "CONTACT_REVEAL_LIMIT_REACHED",
  "loginRedirect": "/login/signup"
}
```

### Scenario: malformed UUID

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

## `GET /pg-owners/:userId/profile`

Returns a PG owner profile. Sensitive fields such as `business_phone` and `email` are only included when the requester is the profile owner.

### Scenario: fetch existing PG owner profile

Status: `200`

```json
{
  "status": "success",
  "data": {
    "profile_id": "bc4cc5f8-93cb-4700-80f4-4f404410242f",
    "user_id": "22222222-2222-4222-8222-222222222222",
    "business_name": "Sunrise PG",
    "owner_full_name": "Rohan Mehta",
    "business_description": "Student-friendly PG near Viman Nagar.",
    "business_phone": null,
    "operating_since": 2018,
    "verification_status": "verified",
    "verified_at": "2026-04-02T12:00:00.000Z",
    "email": null,
    "is_email_verified": true,
    "average_rating": 4.5,
    "rating_count": 12,
    "created_at": "2026-03-20T08:00:00.000Z"
  }
}
```

### Scenario: profile not found

Status: `404`

```json
{
  "status": "error",
  "message": "PG owner profile not found"
}
```

## `PUT /pg-owners/:userId/profile`

Updates the authenticated PG owner profile.

### Request Example

```json
{
  "businessName": "Sunrise PG Premium",
  "ownerFullName": "Rohan Mehta",
  "businessDescription": "Secure PG with Wi-Fi, meals, and weekly cleaning.",
  "businessPhone": "+919876543210",
  "operatingSince": 2018
}
```

### Scenario: update own PG owner profile

Status: `200`

```json
{
  "status": "success",
  "data": {
    "profile_id": "bc4cc5f8-93cb-4700-80f4-4f404410242f",
    "user_id": "22222222-2222-4222-8222-222222222222",
    "business_name": "Sunrise PG Premium",
    "owner_full_name": "Rohan Mehta",
    "business_description": "Secure PG with Wi-Fi, meals, and weekly cleaning.",
    "business_phone": "+919876543210",
    "operating_since": 2018
  }
}
```

### Scenario: caller edits another PG owner's profile

Status: `403`

```json
{
  "status": "error",
  "message": "Forbidden"
}
```

### Scenario: no valid fields provided

Status: `400`

```json
{
  "status": "error",
  "message": "No valid fields provided for update"
}
```

## `POST /pg-owners/:userId/contact/reveal`

Reveals PG owner contact information. This endpoint is intentionally `POST`, not `GET`, and the route sets `Cache-Control: no-store`.

### Request Contract

- Auth required: Optional
- Auth transport accepted:
  - Cookie mode (`accessToken` cookie)
  - Bearer mode (`Authorization: Bearer <access-token>`)
- Route method: `POST`
- Response header: `Cache-Control: no-store`

### Scenario: guest or unverified user gets email-only bundle

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user_id": "22222222-2222-4222-8222-222222222222",
    "owner_full_name": "Rohan Mehta",
    "business_name": "Sunrise PG",
    "email": "owner@sunrisepg.in"
  }
}
```

### Scenario: verified user gets full contact bundle

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user_id": "22222222-2222-4222-8222-222222222222",
    "owner_full_name": "Rohan Mehta",
    "business_name": "Sunrise PG",
    "email": "owner@sunrisepg.in",
    "whatsapp_phone": "+919876543210"
  }
}
```

### Scenario: reveal limit reached

Status: `429`

```json
{
  "status": "error",
  "message": "Free contact reveal limit reached. Please log in or sign up to continue.",
  "code": "CONTACT_REVEAL_LIMIT_REACHED",
  "loginRedirect": "/login/signup"
}
```

## `GET /students/:userId/preferences`

Returns the student's preference profile used for compatibility-aware discovery.

### Request Contract

- Auth required: Yes
- Ownership required: caller must match `:userId`
- Path param:
  - `userId` must be a UUID

### Scenario: fetch preferences

Status: `200`

```json
{
  "status": "success",
  "data": [
    {
      "preferenceKey": "food_habit",
      "preferenceValue": "vegetarian"
    },
    {
      "preferenceKey": "smoking",
      "preferenceValue": "no"
    }
  ]
}
```

### Scenario: caller requests another student's preferences

Status: `403`

```json
{
  "status": "error",
  "message": "Forbidden"
}
```

## `PUT /students/:userId/preferences`

Updates the student's preference profile.

### Request Example

```json
{
  "preferences": [
    {
      "preferenceKey": "food_habit",
      "preferenceValue": "eggetarian"
    },
    {
      "preferenceKey": "sleep_schedule",
      "preferenceValue": "late_night"
    }
  ]
}
```

### Scenario: update succeeds

Status: `200`

```json
{
  "status": "success",
  "data": [
    {
      "preferenceKey": "food_habit",
      "preferenceValue": "eggetarian"
    },
    {
      "preferenceKey": "sleep_schedule",
      "preferenceValue": "late_night"
    }
  ]
}
```

### Scenario: validation failure (missing `preferences`)

Status: `400`

```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "body.preferences",
      "message": "Invalid input: expected array, received undefined"
    }
  ]
}
```

## `POST /pg-owners/:userId/documents`

Submits a verification document for PG owner approval.

### Request Body

```json
{
  "documentType": "property_document",
  "documentUrl": "https://storage.example.com/verification/owner-property-proof.pdf"
}
```

### Scenario: document submission succeeds

Status: `201`

```json
{
  "status": "success",
  "data": {
    "request_id": "abf62d6a-2783-4dd1-a808-72d758fb18da",
    "document_type": "property_document",
    "document_url": "https://storage.example.com/verification/owner-property-proof.pdf",
    "status": "pending",
    "submitted_at": "2026-04-11T10:00:00.000Z"
  }
}
```

### Scenario: caller is not the owner

Status: `403`

```json
{
  "status": "error",
  "message": "Forbidden"
}
```

### Scenario: PG owner profile not found

Status: `404`

```json
{
  "status": "error",
  "message": "PG owner profile not found"
}
```

### Scenario: pending request already exists

Status: `409`

```json
{
  "status": "error",
  "message": "You already have a pending verification request"
}
```

## Profile and Contact Scenario Matrix

| Scenario | Endpoint | Status | Key behavior |
| --- | --- | --- | --- |
| Student profile viewed by other user | `GET /students/:userId/profile` | `200` | email hidden |
| Student profile viewed by self | `GET /students/:userId/profile` | `200` | email included |
| PG owner profile viewed by other user | `GET /pg-owners/:userId/profile` | `200` | business phone hidden |
| Student contact reveal by guest | `GET /students/:userId/contact/reveal` | `200` | email only |
| PG owner contact reveal by verified user | `POST /pg-owners/:userId/contact/reveal` | `200` | email + WhatsApp phone |
| Student reads own preferences | `GET /students/:userId/preferences` | `200` | compatibility preference profile returned |
| Student updates preferences | `PUT /students/:userId/preferences` | `200` | preference profile updated for future matching |
| Guest quota exhausted | contact reveal routes | `429` | redirect hint included |
| Document submitted twice while pending | `POST /pg-owners/:userId/documents` | `409` | duplicate pending request blocked |

## Integrator Notes

- The student contact reveal route is `GET`, but the PG owner route is `POST` to avoid accidental caching or browser prefetch leaks.
- The PG owner contact reveal response can expose a WhatsApp phone number to verified users.
- The student contact reveal response is gate-controlled: verified users receive full contact, guests/unverified callers receive email-only.
