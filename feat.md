I'll analyze the codebase first to understand the existing patterns before designing the system.I have a thorough
picture of the codebase. Let me now produce the full system design document.Now I have everything I need to produce a
thorough, well-structured design document. Let me build it as an interactive HTML artifact.Here's the full system design
across six tabs. A few things worth calling out explicitly:

**On the roommate feed query pattern** — the service will fetch a page of candidate IDs first (students with
`looking_for_roommate = TRUE`, excluding blocks, with keyset cursor on `looking_updated_at`), then call
`scoreUsersForUser` with just those IDs. This is the same two-phase pattern as `scoreListingsForUser` in the existing
codebase. Sorting by score alone would require computing scores for every user in the DB, which doesn't scale — so the
feed shows candidates in reverse-recency order, with score surfaced as a secondary display field, unless you add a
`sortBy=compatibility` mode (which fetches a larger batch, scores all of it, sorts, then paginates in memory — same
tradeoff as the existing listing search).

**On the rent index** — the DB trigger approach means you never need to backfill. Every listing that goes active from
now on feeds the index automatically. The `HAVING COUNT(*) >= 3` floor is conservative; you can tune it via the
`CRON_RENT_INDEX_MIN_SAMPLE` env var once you have real data.

**On mount order** — the `GET /students/roommates` route must go above `GET /students/:userId/profile` in `student.js`.
Express will greedily match `roommates` as a `:userId` param otherwise. The easiest fix is to put all the new roommate
routes in a dedicated `roommate.js` router mounted at `/students` before the parameterised routes.
