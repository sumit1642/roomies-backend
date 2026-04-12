# Auth API

This document covers account creation, login, token refresh, OTP verification, session management, logout, and Google OAuth.

Shared response and error conventions live in [conventions.md](./conventions.md).

## Transport Summary

- Browser clients should use cookie mode.
- Mobile and API clients should send `X-Client-Transport: bearer` to receive tokens in the JSON body.
- Protected routes accept cookie auth and bearer auth unless otherwise noted.
- Silent refresh only happens when the expired access token came from a cookie.

## `POST /auth/register`

Creates a new student or PG owner account and immediately starts a signed-in session.

### Request Contract

- Auth required: No
- Rate limited: Yes, via the auth limiter
- Headers:
  - Optional: `X-Client-Transport: bearer`
- Body:

```json
{
  "email": "priya@iitb.ac.in",
  "password": "Pass1234",
  "role": "student",
  "fullName": "Priya Sharma"
}
```

PG owner registration adds `businessName`:

```json
{
  "email": "owner@sunrisepg.in",
  "password": "Owner1234",
  "role": "pg_owner",
  "fullName": "Rohan Mehta",
  "businessName": "Sunrise PG"
}
```

### Scenario: Student registers with institution email and is auto-verified

Request:

```json
{
  "email": "priya@iitb.ac.in",
  "password": "Pass1234",
  "role": "student",
  "fullName": "Priya Sharma"
}
```

Status: `201`

Cookie-mode response body:

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

Explanation: the service matches the email domain to a known institution and marks the user verified inside the registration transaction.

### Scenario: Student registers with non-institution email and must verify later

Request:

```json
{
  "email": "arjun@roomies-test.in",
  "password": "Pass1234",
  "role": "student",
  "fullName": "Arjun Rao"
}
```

Status: `201`

Bearer-mode response body:

```json
{
  "status": "success",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.access",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh",
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "arjun@roomies-test.in",
      "roles": ["student"],
      "isEmailVerified": false
    }
  }
}
```

Explanation: the account is created and signed in, but the user must later call the OTP endpoints to verify their email.

### Scenario: PG owner registers successfully

Request:

```json
{
  "email": "owner@sunrisepg.in",
  "password": "Owner1234",
  "role": "pg_owner",
  "fullName": "Rohan Mehta",
  "businessName": "Sunrise PG"
}
```

Status: `201`

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "22222222-2222-4222-8222-222222222222",
      "email": "owner@sunrisepg.in",
      "roles": ["pg_owner"],
      "isEmailVerified": false
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

### Scenario: PG owner registration fails because `businessName` is missing

Status: `400`

```json
{
  "status": "error",
  "message": "Business name is required for PG owner registration"
}
```

### Scenario: validation failure

Request:

```json
{
  "email": "not-an-email",
  "password": "short",
  "role": "student",
  "fullName": "P"
}
```

Status: `400`

```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "body.email",
      "message": "Must be a valid email address"
    },
    {
      "field": "body.password",
      "message": "Password must be at least 8 characters"
    },
    {
      "field": "body.fullName",
      "message": "Full name must be at least 2 characters"
    }
  ]
}
```

### Scenario: email already exists

Status: `409`

```json
{
  "status": "error",
  "message": "An account with this email already exists"
}
```

## `POST /auth/login`

Authenticates an existing email/password account and creates a new session.

### Request

```json
{
  "email": "priya@iitb.ac.in",
  "password": "Pass1234"
}
```

### Scenario: browser login success

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

Also sets `Set-Cookie` headers for `accessToken` and `refreshToken`.

### Scenario: bearer-client login success

Headers:

```http
X-Client-Transport: bearer
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.access",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh",
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    }
  }
}
```

### Scenario: wrong password

Status: `401`

```json
{
  "status": "error",
  "message": "Invalid credentials"
}
```

### Scenario: account inactive

Status: `401`

```json
{
  "status": "error",
  "message": "Account is suspended"
}
```

The same branch pattern also applies to `banned` and `deactivated`.

## `POST /auth/refresh`

Rotates the refresh token and issues a fresh access token.

### Request Contract

- Auth required: No
- Rate limited: Yes
- Body: optional when using the refresh token cookie

Bearer/mobile request example:

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh"
}
```

### Scenario: refresh succeeds in cookie mode

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

Explanation: the controller reads the refresh token from the cookie and the response rotates the cookies as well.

### Scenario: refresh succeeds for bearer client

Headers:

```http
X-Client-Transport: bearer
```

Request:

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh"
}
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.new-access",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.new-refresh",
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    }
  }
}
```

### Scenario: refresh token missing

Status: `401`

```json
{
  "status": "error",
  "message": "Refresh token is required"
}
```

### Scenario: refresh token revoked, invalid, or superseded

Status: `401`

```json
{
  "status": "error",
  "message": "Refresh token is invalid or has been revoked"
}
```

### Scenario: account is no longer active during refresh

Status: `401`

```json
{
  "status": "error",
  "message": "Account inactive"
}
```

## `POST /auth/logout`

Revokes a session using the refresh token from the body or cookie.

### Request

Cookie-based browser request can send no body.

Bearer/mobile request example:

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh"
}
```

### Scenario: logout succeeds

Status: `200`

```json
{
  "status": "success",
  "message": "Logged out"
}
```

### Scenario: refresh token missing

Status: `401`

```json
{
  "status": "error",
  "message": "Refresh token is required"
}
```

### Scenario: session already revoked

Status: `401`

```json
{
  "status": "error",
  "message": "Session not found or already revoked"
}
```

## `POST /auth/logout/current`

Revokes the currently authenticated session only.

### Scenario: current-session logout succeeds

Status: `200`

```json
{
  "status": "success",
  "message": "Logged out"
}
```

### Scenario: refresh token does not belong to current user

Status: `403`

```json
{
  "status": "error",
  "message": "Refresh token does not belong to current user"
}
```

### Scenario: token session does not match authenticated session

Status: `403`

```json
{
  "status": "error",
  "message": "Refresh token session does not match the authenticated session"
}
```

## `POST /auth/logout/all`

Revokes all sessions for the authenticated user.

### Scenario: success

Status: `200`

```json
{
  "status": "success",
  "message": "Logged out from all sessions"
}
```

## `GET /auth/sessions`

Lists active sessions for the authenticated user.

### Scenario: success

Status: `200`

```json
{
  "status": "success",
  "data": [
    {
      "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "isCurrent": true,
      "expiresAt": "2026-04-18T09:45:00.000Z",
      "issuedAt": "2026-04-11T09:45:00.000Z"
    },
    {
      "sid": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "isCurrent": false,
      "expiresAt": "2026-04-17T18:00:00.000Z",
      "issuedAt": "2026-04-10T18:00:00.000Z"
    }
  ]
}
```

## `DELETE /auth/sessions/:sid`

Revokes a specific session ID.

### Request Contract

- Auth required: Yes
- Path param:
  - `sid` must be a UUID

### Scenario: revoke another device session

Status: `200`

```json
{
  "status": "success",
  "message": "Session revoked"
}
```

### Scenario: revoke current session

Status: `200`

```json
{
  "status": "success",
  "message": "Session revoked"
}
```

The controller also clears auth cookies when the revoked `sid` matches the current session.

### Scenario: validation failure for malformed sid

Status: `400`

```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "params.sid",
      "message": "sid must be a valid UUID"
    }
  ]
}
```

### Scenario: session not found

Status: `404`

```json
{
  "status": "error",
  "message": "Session not found"
}
```

## `POST /auth/otp/send`

Sends an email OTP to the authenticated user.

### Request Contract

- Auth required: Yes
- Rate limited: Yes, stricter OTP limiter
- Body: none

### Scenario: OTP send succeeds

Status: `200`

```json
{
  "status": "success",
  "message": "OTP sent to your email"
}
```

### Scenario: email already verified

Status: `409`

```json
{
  "status": "error",
  "message": "Email is already verified"
}
```

### Scenario: email delivery fails downstream

Status: `502`

```json
{
  "status": "error",
  "message": "Failed to send OTP email — try again shortly"
}
```

## `POST /auth/otp/verify`

Verifies the latest OTP for the authenticated user and marks the account email as verified.

### Request

```json
{
  "otp": "123456"
}
```

### Scenario: verification succeeds

Status: `200`

```json
{
  "status": "success",
  "message": "Email verified successfully"
}
```

### Scenario: wrong OTP with attempts remaining

Status: `400`

```json
{
  "status": "error",
  "message": "Incorrect OTP — 4 attempts remaining"
}
```

### Scenario: too many incorrect attempts

Status: `429`

```json
{
  "status": "error",
  "message": "Too many incorrect attempts — request a new OTP"
}
```

### Scenario: OTP expired or never sent

Status: `400`

```json
{
  "status": "error",
  "message": "OTP has expired or was never sent — request a new one"
}
```

### Scenario: IP throttle trips

Status: `429`

```json
{
  "status": "error",
  "message": "Too many OTP verification attempts from this IP — please wait 15 minutes"
}
```

### Scenario: infrastructure fail-closed on IP throttle

Status: `429`

```json
{
  "status": "error",
  "message": "OTP verification is temporarily unavailable"
}
```

## `GET /auth/me`

Returns the authenticated identity currently attached to the access token.

### Scenario: success

Status: `200`

```json
{
  "status": "success",
  "data": {
    "userId": "11111111-1111-4111-8111-111111111111",
    "email": "priya@iitb.ac.in",
    "roles": ["student"],
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "isEmailVerified": true
  }
}
```

## `POST /auth/google/callback`

Accepts a Google ID token issued on the client, verifies it server-side, then either signs in an existing user, links an existing email/password account, or creates a new account.

### Request Contract

- Auth required: No
- Rate limited: Yes
- Body:

```json
{
  "idToken": "google-id-token-from-client",
  "role": "student",
  "fullName": "Priya Sharma",
  "businessName": "Sunrise PG"
}
```

`role`, `fullName`, and `businessName` are only required for brand-new registrations.

### Scenario: returning linked Google user

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

### Scenario: account linking by email

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

Explanation: the email/password account already existed, had no `google_id`, and is now linked.

### Scenario: brand-new student registration via Google

Request:

```json
{
  "idToken": "google-id-token-from-client",
  "role": "student",
  "fullName": "Priya Sharma"
}
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "11111111-1111-4111-8111-111111111111",
      "email": "priya@iitb.ac.in",
      "roles": ["student"],
      "isEmailVerified": true
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

### Scenario: brand-new PG owner registration via Google

Request:

```json
{
  "idToken": "google-id-token-from-client",
  "role": "pg_owner",
  "fullName": "Rohan Mehta",
  "businessName": "Sunrise PG"
}
```

Status: `200`

```json
{
  "status": "success",
  "data": {
    "user": {
      "userId": "22222222-2222-4222-8222-222222222222",
      "email": "owner@sunrisepg.in",
      "roles": ["pg_owner"],
      "isEmailVerified": true
    },
    "sid": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

### Scenario: role missing for new Google registration

Status: `400`

```json
{
  "status": "error",
  "message": "Role is required for new account registration via Google"
}
```

### Scenario: full name missing for new Google registration

Status: `400`

```json
{
  "status": "error",
  "message": "Full name is required for new account registration"
}
```

### Scenario: business name missing for new PG owner registration

Status: `400`

```json
{
  "status": "error",
  "message": "Business name is required for PG owner registration"
}
```

### Scenario: Google OAuth not configured on server

Status: `503`

```json
{
  "status": "error",
  "message": "Google OAuth is not configured on this server"
}
```

### Scenario: invalid or expired Google token

Status: `401`

```json
{
  "status": "error",
  "message": "Invalid or expired Google token"
}
```

### Scenario: Google email is not verified

Status: `400`

```json
{
  "status": "error",
  "message": "Google account does not have a verified email address"
}
```

### Scenario: Google account already linked elsewhere

Status: `409`

```json
{
  "status": "error",
  "message": "This Google account is already linked to another user"
}
```

### Scenario: local account already linked to a different Google account

Status: `409`

```json
{
  "status": "error",
  "message": "This account is already linked to a different Google account"
}
```

## Auth Scenario Matrix

| Scenario | Client sends | Service branch | Status | Response pattern |
| --- | --- | --- | --- | --- |
| Student institution signup | register body | institution domain match | `201` | session created, `isEmailVerified: true` |
| Student non-institution signup | register body | no institution match | `201` | session created, `isEmailVerified: false` |
| PG owner signup missing business name | register body | service cross-field rule | `400` | operational error |
| Browser login | login body | cookie mode | `200` | safe body + cookies |
| Mobile login | login body + bearer transport header | bearer mode | `200` | raw tokens in body |
| Refresh missing token | no body and no cookie | controller guard | `401` | operational error |
| OTP wrong but not exhausted | `otp` body | compare fails | `400` | attempts remaining message |
| OTP exhausted | repeated wrong OTP | attempt ceiling hit | `429` | request new OTP |
| Google return user | `idToken` only | find by `google_id` | `200` | session created |
| Google first-time user | `idToken` plus onboarding fields | new account path | `200` | session created |

## Integrator Notes

- Treat the auth response body shape as transport-dependent.
- Do not expect silent refresh for bearer tokens.
- Logout is refresh-token based; it is intentionally available even when the access token is already expired.
- Google callback is not an OAuth redirect endpoint. The client obtains the Google ID token and POSTs it here.
