# Contact Reveal System Design

## Goal

- Allow **verified users** to reveal other users' contact details (email/WhatsApp) without per-user hard cap.
- Allow **guest/unverified users** up to **10 free contact reveals**.
- On the 11th reveal attempt, API responds with a login/signup redirect hint.

## API Contract

### Public reveal endpoints

- `GET /api/v1/students/:userId/contact/reveal`
- `GET /api/v1/pg-owners/:userId/contact/reveal`

### Success response

```json
{
	"status": "success",
	"data": {
		"user_id": "uuid",
		"full_name": "...",
		"owner_full_name": "...",
		"business_name": "...",
		"email": "...",
		"whatsapp_phone": "..."
	}
}
```

### Limit reached response

HTTP `401`

```json
{
	"status": "error",
	"message": "Free contact reveal limit reached. Please log in or sign up to continue.",
	"code": "CONTACT_REVEAL_LIMIT_REACHED",
	"loginRedirect": "/login/signup"
}
```

## Access Control / Metering

1. `optionalAuthenticate` tries to resolve user context if a valid access token exists.
2. `contactRevealGate` applies policy:
    - `req.user.isEmailVerified === true`: allow unlimited reveals.
    - Guest/unverified: metered flow with cap 10.
3. Metering storage:
    - Primary: Redis (`contactRevealAnon:<sha256(ip|userAgent)>`) with 30-day TTL.
    - Fallback: HttpOnly cookie `contactRevealAnonCount` (also 30-day TTL).

## Why dual storage (Redis + cookie)

- Cookie alone can be reset by clearing browser data.
- Redis fingerprint reduces easy bypass while still keeping implementation lightweight.
- Cookie fallback keeps system functional if Redis is unavailable.

## Privacy-by-default profile responses

- Standard profile endpoints keep sensitive fields hidden for non-self views.
- Contact details are returned only through explicit `/contact/reveal` endpoints.

## Frontend Integration

1. Load regular profile/listing cards with non-sensitive fields only.
2. On eye-icon click:
    - call the relevant `/contact/reveal` endpoint;
    - show returned `email` / `whatsapp_phone`.
3. If API returns `CONTACT_REVEAL_LIMIT_REACHED`, route to `/login/signup`.

## Recommended enhancements (next iteration)

`Cookie based implementations , but rarely db implementation, as dbs cost gonna boom everything, so we will try to keep things mostly cookies based. don't think if the user deletes the cookies , what will happen, we are not going full hardenening by ip rate limiting and storing ips in db, nooo, ye we may use the cookies best method`

- Add device fingerprint token to reduce IP sharing edge cases.
- Add per-day and per-hour reveal analytics.
- Add abuse scoring (many reveals across short interval).
