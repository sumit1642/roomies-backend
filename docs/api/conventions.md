# Roomies API Conventions

This document centralizes behavior shared across the API so the feature docs can stay focused on feature-specific contracts and scenarios.

## Success Envelopes

Most successful endpoints return one of these shapes.

Success with data:

```json
{
  "status": "success",
  "data": {}
}
```

Success with message:

```json
{
  "status": "success",
  "message": "OTP sent to your email"
}
```

Accepted-for-processing response:

```json
{
  "status": "success",
  "data": {
    "photoId": "6fd7cf0b-d6a7-4f31-bd0a-fdbcf5a5ef2e",
    "status": "processing"
  }
}
```

## Error Envelopes

Simple operational error:

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
      "field": "body.password",
      "message": "Password must contain at least one letter and one number"
    }
  ]
}
```

Validation errors come from Zod and always use the same top-level `message`.

## Authentication Failures

These are the common auth-related error bodies you will see across protected endpoints.

No token provided:

```json
{
  "status": "error",
  "message": "No token provided"
}
```

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

Expired session during cookie auth or silent-refresh failure:

```json
{
  "status": "error",
  "message": "Session expired"
}
```

User no longer exists:

```json
{
  "status": "error",
  "message": "User not found"
}
```

Inactive account:

```json
{
  "status": "error",
  "message": "Account is suspended"
}
```

Some auth flows return a slightly different message:

```json
{
  "status": "error",
  "message": "Account inactive"
}
```

That difference is service-specific and documented in the auth feature doc.

## Authorization and Privacy Conventions

Roomies intentionally uses two different patterns depending on the sensitivity of the resource.

Standard authorization failure:

```json
{
  "status": "error",
  "message": "Forbidden"
}
```

Privacy-preserving not found:

```json
{
  "status": "error",
  "message": "Connection not found"
}
```

Some endpoints return `404` instead of `403` when the caller is not a party to the resource. This prevents the API from confirming whether the resource exists at all.

This pattern is used for:

- some connection lookups
- some interest lookups
- some rating/report lookups

## Rate Limit and Anti-Abuse Responses

Auth route rate limiter example:

```json
{
  "status": "error",
  "message": "Too many requests, please try again later."
}
```

OTP verify IP throttle:

```json
{
  "status": "error",
  "message": "Too many OTP verification attempts from this IP — please wait 15 minutes"
}
```

Guest contact reveal quota exhausted:

```json
{
  "status": "error",
  "message": "Free contact reveal limit reached. Please log in or sign up to continue.",
  "code": "CONTACT_REVEAL_LIMIT_REACHED",
  "loginRedirect": "/login/signup"
}
```

## Upload Error Responses

Unsupported file type:

```json
{
  "status": "error",
  "message": "Unsupported file type: image/gif. Accepted types: JPEG, PNG, WebP"
}
```

Unexpected multipart field:

```json
{
  "status": "error",
  "message": "Unexpected file field. Use field name 'photo'"
}
```

Missing file:

```json
{
  "status": "error",
  "message": "No file uploaded — send the image under the field name 'photo'"
}
```

File too large:

```json
{
  "status": "error",
  "message": "File is too large. Maximum allowed size is 10MB"
}
```

Queue temporarily unavailable after the file is uploaded to staging:

```json
{
  "status": "error",
  "message": "Photo processing queue is temporarily unavailable. Please retry."
}
```

## Pagination Pattern

Most feed endpoints return:

```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "id": "example"
      }
    ],
    "nextCursor": {
      "cursorTime": "2026-04-11T09:30:00.000Z",
      "cursorId": "0ab4fca0-86a5-4c85-b668-1b6dfb4bd0f8"
    }
  }
}
```

No next page:

```json
{
  "status": "success",
  "data": {
    "items": [],
    "nextCursor": null
  }
}
```

If only one cursor field is supplied, validation fails:

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

## Example Value Conventions

The feature docs use consistent sample values.

- Student user: `11111111-1111-4111-8111-111111111111`
- PG owner user: `22222222-2222-4222-8222-222222222222`
- Admin user: `33333333-3333-4333-8333-333333333333`
- Property: `44444444-4444-4444-8444-444444444444`
- Listing: `55555555-5555-4555-8555-555555555555`
- Interest request: `66666666-6666-4666-8666-666666666666`
- Connection: `77777777-7777-4777-8777-777777777777`
- Rating: `88888888-8888-4888-8888-888888888888`
- Report: `99999999-9999-4999-8999-999999999999`
- Session ID: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`

Representative emails and locations:

- `priya@iitb.ac.in`
- `arjun@roomies-test.in`
- `owner@sunrisepg.in`
- `Mumbai`
- `Pune`
- `560001`
- `400076`

Representative phone numbers:

- `+919876543210`
- `9876543210`
