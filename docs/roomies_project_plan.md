# Roomies — Project Plan

**Student Roommate & PG Discovery Platform — India**

---

## What Roomies Solves

Roomies is a trust-first platform built for Indian college students seeking paying-guest accommodation and compatible
roommates near their institutions. The platform does not simply list rooms — its core differentiation is a verified
reputation system that cannot be gamed, built on the principle that trust must be earned through confirmed real-world
interactions rather than self-reported claims.

The platform serves three distinct personas whose interactions are deeply interconnected across every feature.

| Persona  | Registration Path                                               | Primary Actions                                                                       |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Student  | College email → auto-verified via institution domain match      | Search listings, send interest requests, confirm connections, earn and give ratings   |
| PG Owner | Manual registration → document upload → admin review → verified | Create properties and listings, manage interest requests, confirm stays, earn ratings |
| Admin    | Seeded directly into DB with admin role                         | Review PG owner documents, moderate flagged ratings, manage user accounts             |

---

## The Central Design Principle

Every major architectural decision traces back to a single idea: **trust must be earned, not claimed.** A student cannot
rate a PG owner simply by saying they stayed there. The system requires a two-sided confirmation of the real-world
interaction before any rating is accepted. This constraint lives at the database level, meaning it is physically
impossible to submit a fake review regardless of application bugs or API manipulation.

---

## The WhatsApp Contact Flow

During the current phase, real-time messaging infrastructure is not yet built. Once a student's interest request is
accepted by a PG owner, the application exposes the poster's WhatsApp number as a `wa.me/91XXXXXXXXXX` deep-link. The
student taps the link and goes directly to WhatsApp. This is intentional — it is how the majority of Indian PG discovery
currently works, it ships with zero external API dependency, and it gets replaced by in-app messaging in a future phase.

---

## Contact Reveal System

Roomies supports two tiers of contact visibility to balance openness for discovery against protection from scraping.

Verified users (authenticated with a confirmed email) get unlimited contact reveals — they see both email and WhatsApp
phone number for any user they look up. Guests and unverified users get up to 10 free email-only reveals in a 30-day
rolling window. On the 11th attempt, the API returns a login/signup redirect hint. Counting is backed primarily by Redis
(keyed on a SHA-256 fingerprint of IP + User-Agent) with an HttpOnly cookie as a fallback when Redis is unavailable.

---

## Environment Strategy

The project runs with two environment files that serve distinct purposes. `.env.local` contains local development
configuration: PostgreSQL on the host machine, local Redis, Ethereal Mail for fake SMTP, and local disk for file
storage. `.env.azure` is used for local connectivity checks against Azure services. Email transport is selected by
`EMAIL_PROVIDER` (`ethereal` for local testing, `brevo` for real delivery), and Brevo credentials are supplied via
`BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, and `BREVO_SMTP_FROM`.

---

## Phase Summary

| Phase                     | Focus                                                                                       | Status      | What Becomes Possible                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| 1 — Foundation & Identity | Auth, profiles, institutions, Google OAuth, PG owner verification                           | ✅ Complete | Register, log in, verify email, upload documents, admin approve/reject                     |
| 2 — Listings & Search     | Properties, listings, async photo upload, proximity + compatibility search, saved listings  | ✅ Complete | Post listings, search by filters + proximity, compress photos, bookmark listings           |
| 3 — Interaction Pipeline  | Interest requests, connections, two-sided confirmation, notification feed, ratings baseline | ✅ Complete | Full trust loop: interest → accept → WhatsApp → confirm → rate → notify                    |
| 4 — Reputation Moderation | Report pipeline, admin moderation, aggregate-safe rating takedowns                          | ✅ Complete | Report abusive ratings, admin review queue, remove ratings with auto-recalculated averages |
| 5 — Operations & Admin    | Cron jobs, email worker, full admin control panel, analytics                                | 🔄 Partial  | Cron maintenance jobs done; admin panel, email worker, and analytics still planned         |
| 6 — Real-Time             | WebSocket push over Redis pub/sub                                                           | ⏳ Deferred | Replace polling with push — requires real user volume to justify infrastructure            |

---

## Phase 5 — What Remains

The three scheduled maintenance cron jobs are written and wired into the server. What still needs to be built is the
email delivery worker (BullMQ-backed, replacing the direct Nodemailer calls), the full admin control panel for user
management and rating visibility management, and the platform analytics endpoint. These will be addressed in
`phase5/admin`.

---

## Phase 6 — Real-Time (Deferred)

WebSocket infrastructure will be additive — the existing HTTP notification endpoints remain in place. WebSocket push
requires Redis pub/sub for cross-instance fanout, which is necessary on Azure App Service where multiple instances mean
a user's socket may be on a different instance than the one processing the notification job. This phase begins only
after Phase 3 polling is confirmed working with real users.

---

## Future Upgrade Notes

**View counting on listings:** The current `getListing` implementation increments `views_count` with a detached,
fire-and-forget `pool.query` after the listing read. This is correct for reliability but is a direct database write on
every view. When traffic grows, replace this with a queue/event approach — buffer view events in Redis, batch flush to
Postgres, and optionally deduplicate by user/session/time window. If `views_count` later affects ranking or
monetisation, define whether it should be approximate or strongly consistent before redesigning. Changes would start in
`src/services/listing.service.js` (`getListing`) and extend into a new async analytics component.
