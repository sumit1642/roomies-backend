# Roomies Documentation

This folder contains the maintained backend documentation for the Roomies API and runtime architecture.

## Canonical Top-Level Docs

- [roomies_project_plan.md](./roomies_project_plan.md) — product goals, persona model, and phase status
- [ImplementationPlan.md](./ImplementationPlan.md) — implementation inventory, conventions, route surface, and codebase
  status
- [API.md](./API.md) — API entrypoint, transport rules, shared response conventions, and links to feature docs
- [TechStack.md](./TechStack.md) — runtime, database, queue, storage, validation, and operational decisions
- [Deployment.md](./Deployment.md) — broader deployment guidance
- [deployment/tier0.md](./deployment/tier0.md) — current Render/Neon/Upstash production baseline
- [deployment/tier1.md](./deployment/tier1.md) — first scale-up tier
- [deployment/tier2.md](./deployment/tier2.md) — higher-scale architecture guidance

## Detailed API Docs

Feature-level API documentation lives in `docs/api/`.

- [api/conventions.md](./api/conventions.md) — shared response envelopes, auth failures, pagination, and example
  conventions
- [api/auth.md](./api/auth.md) — registration, login, refresh, OTP, sessions, logout, and Google OAuth flows
- [api/profiles-and-contact.md](./api/profiles-and-contact.md) — student and PG owner profiles, contact reveal, and
  verification document submission
- [api/properties.md](./api/properties.md) — property CRUD and ownership rules
- [api/listings.api.md](./api/listings.api.md) — listing search, CRUD, lifecycle changes, saved listings, preferences,
  photo flows, and listing-scoped interests
- [api/interests.md](./api/interests.md) — interest request creation, dashboards, and transition state machine
- [api/connections.md](./api/connections.md) — connection dashboard, detail, and two-sided confirmation
- [api/notifications.md](./api/notifications.md) — notification feed, unread count, and mark-read modes
- [api/ratings-and-reports.md](./api/ratings-and-reports.md) — ratings, public reputation views, and rating report
  submission
- [api/preferences.md](./api/preferences.md) — preferences metadata and student preferences endpoints
- [api/admin.md](./api/admin.md) — admin surface scenarios (and current mount status)
- [api/health.md](./api/health.md) — dependency health probe behavior

## Maintenance Rules

- Treat the route files in `src/routes/` as the authoritative endpoint list.
- Treat the validators in `src/validators/` as the authoritative contract for params, query, and body shape.
- Treat service-layer `AppError` branches as the authoritative source for documented business-rule failures.
- Keep `API.md` as the front door and keep the feature-level detail inside `docs/api/`.
