# Service Contract Index

This directory provides one stable place to understand backend behavior service-by-service.

For each service below, treat source files as canonical in this order: route -> validator -> service -> worker.

## Auth service
- Source: `src/services/auth.service.js`
- Scope: Session lifecycle, token rotation, logout semantics, and OTP verification rules.

## Listing service
- Source: `src/services/listing.service.js`
- Scope: Search, detail, lifecycle transitions, save/unsave behavior, and pagination contracts.

## Photo service
- Source: `src/services/photo.service.js`
- Scope: Listing photo upload lifecycle, placeholder filtering, cover election, and reorder invariants.

## Interest service
- Source: `src/services/interest.service.js`
- Scope: Interest request creation, transitions, and accept-flow side effects.

## Connection service
- Source: `src/services/connection.service.js`
- Scope: Two-party connection reads and confirmation state transitions.

## Notification service
- Source: `src/services/notification.service.js`
- Scope: Notification feed reads, unread count, and mark-read updates.

## Verification service
- Source: `src/services/verification.service.js`
- Scope: PG owner verification request submission and admin decision state changes.

## Preferences service
- Source: `src/services/preferences.service.js`
- Scope: Student preference CRUD and metadata-backed validation behavior.

## Property service
- Source: `src/services/property.service.js`
- Scope: PG owner property CRUD and ownership guards.

## Ratings & reports service
- Source: `src/services/rating.service.js`
- Scope: Rating creation/reads and reporting lifecycle constraints.

## Student service
- Source: `src/services/student.service.js`
- Scope: Student profile reads, updates, and contact reveal shape controls.

## PG owner service
- Source: `src/services/pgOwner.service.js`
- Scope: PG owner profile reads, updates, and contact reveal shape controls.

## Report service
- Source: `src/services/report.service.js`
- Scope: Admin report queue and resolution updates.

