Looking at the codebase, here are the notable missing or incomplete features:

**Authentication & Security**

- No password reset / forgot password flow

- No email change flow

- No account deletion endpoint (soft-delete exists in DB but no API)

- No phone number verification (column exists, `is_phone_verified` present but unused)

**Listings**

- No listing renewal/extension endpoint (listings expire after 60 days with no way to extend)

- No duplicate/relist feature

- `spatial.js` is completely empty — proximity search SQL exists but the utility file has no exports

**Interest Requests**

- No route to create interest requests for `pg_room`/`hostel_bed` (only `student_room` flow via listing, but `authorize("student")` blocks pg_owners who might also want to inquire)

**Reports**

- `getReportQueueSchema` uses `keysetPaginationQuerySchema` but the controller manually parses cursor params rather than using validated `req.query` — inconsistency with the rest of the codebase


**Notifications**

- No `DELETE /notifications/:id` endpoint (soft-delete column exists in schema)

**Photos**

- No orphaned staging file cleanup cron (referenced in `mediaProcessor.js` comments but never implemented)

- No total photo count limit per listing enforced in code
- A single property listing to rent , from all pov , can have upto 5 photos according to user based roles.

**Connections**

- No `DELETE /connections/:id` or denial flow — `confirmation_status` has `denied` and `denial_reason` column but no endpoint sets them

- No `connection_requested` notification ever enqueued (type exists in enum and worker messages)

**Misc**

- `_buildWhatsAppLink` in `interest.service.js` is prefixed with `_` (private convention) but is exported implicitly through usage — minor inconsistency

- `src/db/utils/spatial.js` is an empty file


**NOTE**: See , we have soft delete implemented, suppose a listing gets occupied and then later de-occupied then i want that listing status to be active and thus be re-usable.