# Grounds Control Vehicle Inspections — Build Spec

Owner: Tyler Longshore (Business Systems & Technology Manager)
Status: phase 1 (MVP) built, plus trailer types and branding; phase 2 maintenance log built; fleet management waiting on answers (§9)
Target: a DigitalOcean droplet (since 2026-11-12; it ran on Tyler's Windows PC 2026-11-11/12). Moves to a company server later.

## 1. Why

Truck inspections at Grounds Control are done on paper, one sheet per truck, monthly or quarterly. That causes three problems:

- Damage is only found at the next inspection, so nobody knows when it happened or who was driving.
- Completed sheets aren't searchable, and repairs written on them don't reliably get done.
- Only 2 of the 10 paper forms have signature lines, so there's no sign-off chain.

The app moves the same sheet onto a phone and adds damage pins, photos, signatures, supervisor review and repair follow-through.

## 2. Users and roles

| Role | Who | Can |
|---|---|---|
| crew | Crew leads and drivers | Sign in with name + PIN, start or resume an inspection, upload photos, submit |
| supervisor | Crew supervisors, fleet/shop | Everything crew can do, plus review and sign off inspections, mark repairs resolved, export PDFs, file and read incident reports |
| shop | Shop manager | Everything crew can do, plus log, edit and void maintenance entries, and close repair items; can't sign off inspections or export PDFs |
| admin | Tyler, COO | Everything, plus manage trucks, trailers, diagrams, checklist items, users and branding |

Crew sign-in has to be fast on a phone in a truck: pick your name, enter a 4–6 digit PIN, and the session stays signed in for about 30 days. Supervisors and admins use email + password. Microsoft 365 SSO is a later phase (see §9).

## 3. Stack (recommended; Claude Code may adjust with a reason)

- **Runtime:** Docker Compose on Ubuntu Server 24.04 VM
- **DB:** PostgreSQL 16 (`db/schema.sql` is the starting point, already tested to load cleanly)
- **App:** Node.js 24 + TypeScript (Node 20 left support in April 2026; 24 runs the TypeScript directly), Fastify API. Frontend is a mobile-first web app; the prototype's plain HTML/JS UI is a fine base, or SvelteKit if the app grows. No native app.
- **Photos and signatures:** files on a Docker volume (`/data/uploads/yyyy/mm/<uuid>.jpg`), path stored in Postgres. Resize on the client to max 1600px JPEG before upload, as the prototype does. Keep it behind an interface so it can move to S3 or Azure Blob later.
- **PDF:** server-side, render an HTML print template with headless Chromium (Playwright) → PDF
- **Reverse proxy / TLS:** Caddy
- **Backups:** nightly `pg_dump` plus an uploads tarball into `backups/` on the server, keeping 30 days (copy them off the
  server for a second location; see docs/PHASE3-REVIEW.md). The app also takes one itself before it migrates the
  database during an update (§4a), and Admin → About shows the last backup (§9 item 8).

### Remote access (decide early)

Crews are on cellular in the field, so a VM on Tyler's machine is not reachable from their phones by default. Options:

1. **Cloudflare Tunnel** (recommended for the pilot): no open ports, real HTTPS hostname, free. Add Cloudflare Access later if wanted.
2. Tailscale Funnel: works, but Funnel is less flexible for a production hostname.
3. Port-forward and dynamic DNS: not recommended.

The pilot can start on Wi-Fi at the yard if needed.

**Current decision (Nov 2026):** Tyler moved it to a DigitalOcean droplet on 2026-11-12, so it's on the open internet
(Caddy on 80/443; HTTPS needs `SITE_ADDRESS` set to a domain). The PC copy no longer hosts it.
Hardening for the open internet (done 2026-11-17, migration 009):
- The app trusts forwarded headers only from its own proxies (private addresses), so the sign-in limits count the
  phone's real address. The domain is proxied through Cloudflare, so the phone's address is Cloudflare's
  `CF-Connecting-IP`, used only when the connection really comes from Cloudflare's published ranges (listed in
  `src/auth.ts`; recheck cloudflare.com/ips once a year). Someone going around Cloudflare straight to the droplet can't fake it.
- Wrong sign-ins: an account still locks after 5 wrong tries in a row, for 15 minutes, doubling with each lockout that
  day (30, 60, 120, then 240 minutes). Tries sent all at once count too. One network gets 20 wrong tries an hour
  across all accounts; for IPv6 a network is its /64. A yard's crew share its Wi-Fi address, so a person's own typos
  stop counting once they sign in. An admin setting a new PIN or password unlocks the account at once.
- Photo uploads stop at 1 GB per person per 24 hours (`UPLOAD_DAILY_MB`), and pause for everyone while the server disk
  has under 2 GB free (`UPLOAD_MIN_FREE_MB`), because the database is on the same disk. Either way the phone keeps the
  photos and keeps retrying, and the draft shows why.
- HSTS over HTTPS (one year).

Tyler's decisions (2026-11-17): keep 4-digit crew PINs and the public crew name list; backups staying on the droplet
are fine for now. He'll add a DigitalOcean Cloud Firewall (web only from Cloudflare, SSH only from the office) and
remove the unused UFW rules for 2375/2376; steps in docs/DEPLOY.md "Firewall".

## 4. Screens (all phone-first, also good on iPad)

1. **Sign in:** name picker + PIN pad, or email/password for supervisors and admins.
2. **Home / pick a truck:** searchable list of trucks (code, year/make/model, plate, VIN). Each shows badges for last inspection date (warn if over 35 days), open repair count, draft in progress, and registration expired.
3. **Truck page:** header info, Start/Resume inspection, open repairs from all past inspections, **damage on file** (the
   truck picture with every damage mark from every inspection, numbered oldest first, and a list newest first with the date,
   a link to the inspection and its photos), and inspection history. Each mark on file has **Log fix** (shop/admin) and
   **Mark repaired** (supervisor/admin); repaired marks move to a **Repaired** list with before and after photos (§9).
4. **Inspection form** (same order as the paper sheet):
   - Truck header (read-only)
   - Date (default today), inspector name (default signed-in user), mileage (numeric keypad), oil change due Yes/No
   - **Damage diagram:** tap to drop a numbered pin and describe it. All damage already on file (every pin from every earlier inspection, since crews only mark new damage) shows as grey
     dots. A "Damage already on file" list under the picture shows each one's description and date; tapping one darkens and
     numbers its dot, so crews don't mark the same damage twice. Pins drawn on a picture the truck no longer uses are left off
     the form (still listed on the truck page). A photo can be attached to a pin.
   - Existing notes (prefilled from the previous inspection's notes and observations) and New observations
   - Checklist sections, Exterior (16) and Interior (16). Each item has big OK / Repair buttons; Repair requires a short note and allows a photo. "Mark rest OK" per section.
   - Trailer switch (defaults on if the truck usually pulls a trailer). When on: trailer number/plate, trailer diagram with pins, and the Trailer & crew checklist (17).
   - Photos with captions; upload them as they're added
   - Comments
   - Employee signature (finger-drawn)
   - Sticky bottom bar with progress (N of M items) and Save. Save is blocked until required fields are done, and the missing items are listed and highlighted.
   - Drafts autosave on the device (IndexedDB) and survive closing the browser
5. **Inspection detail:** everything submitted, repairs listed first, damage diagram with pins, photo gallery with full-screen view, full checklist, signatures. Supervisor sign-off happens here (name + finger signature). **Export PDF** button.
   **Archive or delete** card (§9): Archive / Un-archive (supervisor+), Delete / Restore (admin), with the history of each change;
   an archived or deleted inspection shows a banner saying so.
6. **Repairs board** (built; supervisor, shop, admin; Menu or the home screen button with the open count): all open repair
   items across the fleet from live inspections on trucks in service, filterable by truck, grouped by truck (oldest first) or
   one list oldest first, each with how long it's been open (amber from 14 days, red from 30) and its photos. Resolve with a
   note (supervisor/admin) or Log fix to close it through a maintenance entry (shop/admin).
6a. **Maintenance log** (shop, admin; supervisors can read): on the truck page, "Next due" (from the newest entry of each type,
   orange within 500 miles or 14 days, red when due), the list of entries, and "+ Log maintenance". The entry form has date,
   mileage, types of work (one or more of: oil change, tires, brakes, repair, preventive maintenance, inspection/registration,
   other), work done, parts, cost, done by, outside shop, the truck's open repairs and damage to tick off, next due
   mileage/date for each type picked, photos, notes. An entry
   shows its repairs, photos and every change ("Cost: $64.20 → $66.40"). Shop/admin can edit it or void it with a reason.
   **Closing repairs:** every open repair (truck page and inspection) has a **Log fix** button for shop/admin that opens a new
   entry with that repair ticked and the type of work picked. Picking a type of work also ticks matching open repairs
   (oil change → engine oil; tires → tire items; brakes → brake items but not brake lights; inspection/registration → plate,
   tag and registration items), shown with a "Matches …" label; a tick the shop set or cleared by hand is never changed.
   Saving closes the ticked repairs; the inspection then shows "✓ Repairs fixed" (green) instead of red, and each fixed
   repair links to its entry. Supervisors keep the quick **Resolve** (note only).
7. **Admin:** trucks (add, edit every header field, retire, pick or upload the body diagram, set the trailer type or "no trailer"), trailer types (name + picture), users and PINs, branding (company name, app name, header color, logo), checklist items (add, reorder, deactivate; never hard-delete).
   **About & updates** (§9 item 8): the running version, the database's migration level, the last backup and whether it
   worked, and the optional update check.

A trailer type is a named trailer diagram. Every inspection records which truck and trailer pictures it was drawn on, so changing a truck's diagram or trailer type later never moves old pins.

## 4a. Data safety (top priority)

Losing an inspection, photo or log entry is the worst failure this app can have. Every change is judged against that first.

- Nothing is erased by accident or in a hurry. Since 2026-11-19 (020) an admin can erase a record on purpose, through
  one guarded path (the trash, below); everything else is as before: trucks, users, diagrams and checklist items are
  retired, not removed, and every guard in the database still refuses deletes and changes.
- **The trash and Delete forever (020; Tyler 2026-11-19: "We might need a way to delete things").** What Tyler wants gone:
  test records before rollout, mistakes, personal information on request, and records past an age. Admins only.
  - **Delete puts a record in the trash** (Admin → Trash), never erases it: inspections, incident reports, yard walks,
    equipment checks, maintenance entries (truck and equipment), repair tickets, and retired trucks and inactive users that
    have nothing on file. A record in the trash is out of every list and off the truck; Restore puts it back. Maintenance
    entries and tickets are voided as they go in (as a void always does, a maintenance entry's repairs reopen), and come
    back voided. A truck or user with any record on file stays retired instead, so their history is never orphaned.
  - **After 7 days in the trash** (Tyler's choice) an admin can **Delete forever**: the record, everything that is only
    part of it (checklist answers, damage marks and their repairs, notes, edit history, photos, signature and sketch
    files) goes. Things that stand on their own stay: a ticket or maintenance entry that listed its repairs just loses
    those lines, damage a deleted maintenance entry fixed stays repaired (with its photo), and a registration update made
    at sign-off stays in the truck's history. The screen first shows exactly what will go (worked out by doing it and
    rolling it back) and asks for the truck number (or the yard, trailer, tag or person's name) to be typed.
  - **Old records:** Admin → Trash → Move old records to the trash takes every record of the ticked kinds dated before a
    day (count typed to confirm); maintenance entries and tickets go in voided, but repairs they fixed stay fixed. They can
    be restored like any other until deleted forever. **Delete forever all ready** does every record past its 7 days.
  - **The database enforces it:** every guard still refuses deletes and changes, except inside one transaction started by
    `gc_begin_purge(kind, id)`, which itself refuses a record that isn't in the trash or hasn't been there 7 days. Files
    are removed only after that transaction commits, and only if nothing in the database still points at them.
  - **The log:** each permanent delete is a line in `purge_log` (Admin → Trash → Deleted forever): what kind of record,
    which truck, its date, why, who put it in the trash and who deleted it forever, and how many rows and files went.
    Never the record's contents; a user is logged as "User #12 (crew)", without the name. The log can't be changed or
    erased.
  - Nightly backups keep 30 days, so a record deleted forever is still in the backups for up to 30 days, then gone.
- **A backup before every database migration (021, 2026-11-23).** When the app starts on an existing database (one with
  migrations already applied) and finds migrations to apply, it first takes a labeled backup, `before-migrate-NNN` (NNN =
  the first pending migration), while holding the migration lock: `db_<stamp>_before-migrate-NNN.dump` and
  `uploads_<stamp>_before-migrate-NNN.tar.gz` in the backup folder, with the nightly job's names and rules (temp file,
  flushed, renamed when complete; never overwrites; a failed try leaves no files, not even half a pair, so a retry loop
  can't fill the disk), so `scripts/restore.sh` restores it like any other. **If the backup fails, no migration is
  applied**: the app logs it loudly (what's pending, why, how to fix it), doesn't serve, and tries again on its own
  (30 s, doubling up to 15 minutes) without exiting, so Docker doesn't restart it in a loop. A migration that fails
  after a good backup is retried the same way, reusing that backup (nothing can write in between), so retries never
  pile up backups. A new, empty database has nothing to back up. `PRE_MIGRATE_BACKUP=off` skips the backup, for
  development and test databases only. Each pre-migration backup, good or failed, is recorded in `backup_runs`.
  **How (Claude's choice, 2026-11-23):** the app image has PostgreSQL's own `pg_dump` 16 (from apt.postgresql.org;
  Debian bookworm only packages 15, which can't dump a 16 server), and the backup folder (`BACKUP_DIR`) is mounted into
  the app container at `/backups`. Handing the job to the backup container instead was ruled out: that container only
  starts once the app is healthy (so the first backup never runs against an empty database), and an update rebuilds only
  the app, so it may still be running the old `backup.sh`; the app waiting on it could wait forever. The app container
  starts as root for one step only, making the app's user the owner of the backup folder if it can't write there
  (Docker creates that host folder owned by root), then runs as `node` (`scripts/app-entrypoint.sh`).
- Submitted records are read-only in the database (triggers), and corrections go in notes.
- The phone keeps a draft until the server confirms it; submits are idempotent; uploads retry.
- Files are written to a temp file, flushed to disk and renamed, so a crash never leaves a half-written photo.
- Schema changes only add numbered migrations, each in one transaction.
- Damage repairs (006) can't be edited or deleted, only ended (undo / voided entry) with who, when and why.
- The database refuses to delete inspections, their checklist answers and damage marks, and any photo once it's attached
  (005). "Delete" in the app only marks an inspection deleted (in the trash), restorable, with every change kept as history;
  only Delete forever (020) erases it.
- Nightly backups (database + uploads) into `backups/` on the server (the same disk as the data for now, Tyler's call
  2026-11-17; copy them off the server for a true second location), and a restore is tested (done 2026-11-11 on Tyler's PC: restored
  data matched the backup row for row and file for file). A backup is written to a temp file and renamed only when complete,
  never overwrites an existing backup, and runs one at a time. A restore first saves the current data as a `_before-restore`
  backup, so a wrong restore can be undone.
- The app survives the database restarting under it (a dropped connection is logged and replaced, not a crash).
- Maintenance entries: never deleted (void with a reason; the database refuses deletes), every edit saves the previous version,
  an edit made from an out-of-date copy is refused instead of overwriting, and voiding reopens the repairs the entry closed.
  Orphan-photo cleanup skips photos attached to an entry.
- Uploads pause (the phone keeps the photos and retries) before the disk the database lives on fills up (009).
- Repair tickets (010) can't be deleted or changed, only voided once with a reason; the repairs on a ticket never change.
- Checklist items (011) are retired, never deleted, and every checklist change is kept; editing the checklist never
  changes a submitted inspection or bounces one that's being filled in.
- Yard walks (012) are read-only once submitted and never deleted; only a finding's resolution is recorded later. Yards,
  yard checklist items and their change history can't be deleted either, and a walk's photos are protected like any other.
- Equipment checks (013) are read-only and never deleted the same way. Trailers, equipment, their change history and
  the equipment checklist can't be deleted. Which records a photo can belong to is one list (`src/photo-owners.ts`),
  used by every photo check and the clean-up, so a new kind of record can't leave its photos unprotected.
- Equipment maintenance entries (014) can only be voided (with a reason), never edited or deleted; voiding reopens the
  problems the entry closed.
- Truck status changes (015) are recorded by the database itself for every change, however it's made, and the history
  can't be edited or deleted. Trailer moves are kept with the other asset changes.
- Phase 3 review (2026-11-18, docs/PHASE3-REVIEW.md): trucks, users and truck pictures can't be deleted in the database
  either (017). A file written for a save that then fails is removed only once the database confirms nothing points at
  it (the save may have gone through after all). Every photo upload gets its own file name, and a file's folder is
  flushed after it's written. A photo already uploaded from a phone can be sent by whoever is signed in on it (shared
  phones), and one cleaned up mid-save is simply uploaded again. The phone's offline cache keeps the newest 400 items,
  so it can't grow until the browser clears the app's storage. A 60-minute burn-in (30 phones, bad signal, app crashes,
  database restarts) checks that nothing is lost, duplicated or incomplete: `scripts/burnin.ts`.
- Incident reports (018) follow the inspection rules: idempotent submit on `client_id`, read-only once filed (the
  database refuses changes and deletes to the report, its damage marks, notes and who-has-read-it rows), corrections
  and later facts are notes added with who and when, and archive/delete only changes a state row with history (delete
  is admin-only with a reason; restore from Admin → Trash). Their photos are attached like any other record's
  (PHOTO_OWNERS) and the week-old clean-up never touches them. The burn-in files incident reports too.

## 5. Business rules

- Required to submit: date, inspector, mileage, oil change due, every visible checklist item answered, a note on every Repair, and the employee signature.
- Mileage must be at least the truck's last recorded mileage. If it's lower, warn but allow (odometer typo), and flag the record.
- An inspection is immutable after submit, except for the supervisor sign-off and repair resolution fields. Corrections go in a supervisor note.
- Inspections store a snapshot of checklist labels, so editing the checklist never changes old records.
- Submits are idempotent: the phone generates `client_id` (uuid). A retried submit with the same `client_id` returns the existing record.
- Weak signal is normal. Uploads and submits retry with backoff, the draft stays on the device until the server confirms, and the UI shows "Saved on phone, not yet uploaded" rather than failing.
- Retention: keep everything; it's small. FMCSA's DVIR minimum is 90 days if any of these vehicles count as CMVs.

## 6. PDF export

- One inspection → one PDF that looks like the paper Truck Inspection Sheet (see `reference/AZ018 Truck Inspection Sheet - 2500.pdf`):
  - Page 1: header table, damage diagram with numbered pins and a legend, notes, the two-column checklist with OK/Repair checkmarks
  - Page 2, if a trailer was inspected: trailer diagram, trailer checklist, comments, signatures
  - Final pages: photos, 2 per row, with captions
- Filename: `<TruckCode>_<YYYY-MM-DD>_inspection.pdf`
- The logo and company name from branding print at the top of page 1.
- If repairs were closed through the maintenance log, a "Repairs fixed — maintenance log" section follows the sign-off: one
  table per entry (number, type, date, mileage, done by / outside shop, cost, repairs fixed, work done, parts, notes, who
  logged it and whether it was edited later). The checklist line says "✓ Fixed <date> (maintenance entry N)", and the
  entry's photos go on the photo pages captioned "Maintenance entry N". Voided entries are left out.
- Page 1 stays one page: the diagram shrinks (down to 1.9in) when repair notes, a long damage legend or long notes need the
  room. A sheet too busy even for that continues on the next page with the checklist header repeated, never leaving a
  blank page. Timestamps print in the server's time zone (TZ), not UTC.
- **Batch export (built):** Export PDFs screen (supervisor+, from the menu, home or a truck's history). Filter by truck and
  dates (quick picks: last 7 days, this month, last month), then tick the inspections wanted (or Select all). Each becomes
  **its own PDF**, named like a single export (`_2`, `_3` added if two share a name), never one combined PDF; saved together
  in `inspections_<date>.zip`, or shared as separate PDFs where the phone supports sharing files (needs HTTPS).
  The phone fetches the PDFs two at a time and retries each one on a weak signal, with progress and Cancel; any that still
  fail are listed with "Try again", which fetches only those. Up to 100 per export; the list shows the newest 200.
  The zip is built on the phone (`public/js/zip.js`, stored, no compression), so the server only ever makes single PDFs.
- **CSV export (built 2026-11-17):** a Download CSV screen (supervisor, shop, admin; from the menu and from a "Download
  CSV" link on Export PDFs, the repairs board, a truck's Maintenance section and Admin → Trucks, carrying that screen's
  truck). Pick what: **Inspections** (supervisor+; one row each: date, truck, inspector, mileage, oil due, trailer,
  repairs needed and how many are still open, notes, registration on file then, sign-off, archived, link),
  **Repairs** (one row per repair item: truck, item, note, reported, days open, fixed when/by/how, maintenance entry, link),
  **Maintenance log** (one row per entry: every type of work with its next due, description, parts, cost, vendor, who
  entered and last edited it, link) or **Trucks** (VIN, plate, registration, trailer, last inspection and mileage, open
  repairs, damage on file, last maintenance, link). Filters: truck, dates (with the same quick picks), and "include
  archived inspections / fixed repairs / voided entries / retired trucks". Every matching row is in the file (up to 20,000).
  Lists count what the truck page counts (live inspections; deleted ones are never exported). The file is UTF-8 with a
  byte-order mark so Excel opens names correctly; dates are 2026-11-17, times 2026-11-17 14:05 (Phoenix). Text that a
  spreadsheet would run as a formula (starting with = + - @) gets a leading apostrophe. The phone shows how many rows,
  then Save or Share; if nothing matches it says so instead of saving an empty file.

## 7. API sketch

```
POST /auth/pin            {user_id, pin}
POST /auth/login          {email, password}
GET  /vehicles            -> vehicle_status rows
GET  /vehicles/:id        -> vehicle + open repairs + history + damage on file (with photos)
GET  /vehicles/:id/last   -> last inspection (to prefill notes) + all damage on file that fits today's picture (grey pins)
POST /photos              multipart -> {id}   (before submit; orphan cleanup after 7 days)
POST /inspections         {client_id, ..., items[], damage[], photo_ids[]}
GET  /inspections?limit&status&vehicle_id&from&to&archived   (from/to: inclusive dates; archived=only|include, else live only)
POST /inspections/:id/archive {reason?} · /unarchive          supervisor+
POST /inspections/:id/delete {reason} · /restore             admin
GET  /admin/deleted-inspections                               admin (older app copies; Admin → Trash uses the routes below)
GET  /admin/trash                                             admin: everything in the trash, with ready / ready_at / confirm
POST /admin/trash {kind, id, reason} · /admin/trash/restore {kind, id}       admin (kind: inspection, incident, yard_walk,
                                 equipment_check, service_log, equipment_service, repair_ticket, vehicle, user)
POST /admin/trash/preview {kind, id}                          admin: what Delete forever would remove (done, then rolled back)
POST /admin/trash/purge {kind, id, confirm}                   admin: Delete forever (7+ days in the trash; idempotent)
POST /admin/trash/purge-ready {confirm} · {more, skip[]}      admin: everything ready, a batch per call
GET  /admin/old-records?before&kinds · POST /admin/old-records/trash {before, kinds[], reason, confirm}   admin
GET  /admin/purge-log                                         admin
GET  /admin/about                -> {version, database: {latest, count, pending, unknown}, backups: {last, last_ok, recent,
                                     folder, last_good_at, stale}, updates (null when UPDATE_CHECK_REPO is blank), update_steps}   admin
PUT  /admin/update-check {enabled}                            admin (404 when UPDATE_CHECK_REPO is blank)
POST /damage-marks/:id/repair {client_id, note, photo_ids[]}   supervisor+ (photo required; idempotent)
POST /vehicles/:id/registration {client_id, expires, was, from: form|sign-off|truck, inspection_id?, note?, photo_ids[]?}
                                 supervisor+; 409 if the date changed since `was`; idempotent; history in GET /vehicles/:id
POST /damage-repairs/:id/undo {reason}                       supervisor+ (supervisor repairs only)
POST/PATCH /service-logs also take damage_mark_ids[], with photos[].damage_mark_id for the photo of each fix
GET  /inspections/:id
POST /inspections/:id/review     {signature (png)}        supervisor+
POST /inspection-items/:id/resolve {note}                 supervisor+
GET  /inspections/:id/pdf
GET  /repairs?vehicle_id                 -> open repairs across the fleet (repairs board)   supervisor, shop, admin
GET  /export/inspections.csv?vehicle_id&from&to&include=1   (archived too)      supervisor+
GET  /export/repairs.csv?vehicle_id&from&to&include=1       (fixed too)         supervisor, shop, admin
GET  /export/maintenance.csv?vehicle_id&from&to&include=1   (voided too)        supervisor, shop, admin
GET  /export/trucks.csv?include=1                           (retired too)       supervisor, shop, admin

Repair tickets (built), supervisor, shop, admin:
POST /repair-tickets {client_id, vehicle_id, item_ids[], sent_to?, note?}   -> {id, number}  (200 + duplicate on a retry)
GET  /repair-tickets/:id             -> the ticket, its truck, and each repair with whether and how it was fixed
GET  /repair-tickets/:id/pdf[?inline=1]
POST /repair-tickets/:id/void {reason}
GET  /vehicles/:id/repair-tickets    -> the truck's tickets with fixed counts
GET  /repair-tickets/sent-to         -> recent "Sent to" names
admin CRUD: /vehicles, /trailers, /diagrams, /users
Checklist editor (built), admin only:
GET  /admin/checklist                -> {sections, items (with how often each was answered), changes}
POST /admin/checklist {section, label}
PATCH /admin/checklist/:id {label}
POST /admin/checklist/:id/move {direction: "up" | "down"}
POST /admin/checklist/:id/retire, /restore
GET  /form-config now also returns as_of; the phone sends it back as checklist_as_of with the inspection.
/admin/yard-checklist: the same five calls for the yard checklist.

Yard walks (built):
GET  /yards                          -> yards with walked_today, last_date, open_findings     supervisor, shop, admin
GET  /yard-config                    -> {sections, checklist, as_of}                          supervisor+
POST /yard-inspections {client_id, yard_id, inspection_date, inspector_name, comments, checklist_as_of, items, photos, signature}
                                     -> {id, failed} (200 + duplicate on a retry)              supervisor+
GET  /yards/:id/inspections          -> the yard's walks, newest first                         supervisor, shop, admin
GET  /yard-inspections/:id           -> walk, items (with resolutions), photos                 supervisor, shop, admin
GET  /yard-inspections/:id/signature, /pdf (supervisor+)
GET  /yard-findings                  -> open findings, oldest first                            supervisor, shop, admin
POST /yard-findings/:id/resolve {note}                                                         supervisor+

Equipment (built):
GET  /admin/equipment                -> {types, check_days, trailers, equipment}                admin
POST /admin/trailers, PATCH /admin/trailers/:id; POST /admin/equipment, PATCH /admin/equipment/:id   admin (moves = trailer_id)
PUT  /admin/equipment-settings {check_days}                                                     admin
/admin/equipment-checklist: the same five calls as the other checklists                         admin
GET  /equipment                      -> trailers with pieces (last_checked, due, open_problems), unassigned   supervisor, shop, admin
GET  /equipment/:id                  -> a piece, its history and checks                          supervisor, shop, admin
GET  /equipment-config/:trailer|none -> {trailer, pieces, sections, checklist, as_of}            supervisor, shop, admin
POST /equipment-checks {client_id, trailer_id, check_date, checker_name, comments, checklist_as_of, pieces, photos}
                                     -> {id, failed} (200 + duplicate on a retry)               supervisor, shop, admin
GET  /equipment-checks?trailer=…, /equipment-checks/:id
GET  /equipment-findings; POST /equipment-findings/:id/resolve {note}                           supervisor, shop, admin
GET  /equipment-service-config       -> {work}                                                  supervisor, shop, admin
GET  /equipment/:id/service          -> {entries, next_due}                                     supervisor, shop, admin
POST /equipment-service {client_id, equipment_id, service_date, work:[{type, next_due_date}], description, parts, cost,
     performed_by, vendor, notes, fix_item_ids, photos} -> {id, fixed} (200 + duplicate on a retry)   shop, admin
GET  /equipment-service/:id; POST /equipment-service/:id/void {reason}                          read: supervisor, shop, admin; void: shop, admin

Fleet (built), supervisor, shop, admin:
GET  /fleet-config                   -> {statuses, shop_statuses}
POST /vehicles/:id/status {status, note}     (the shop: in_service, in_shop, on_hold, trucks in the fleet only)
GET  /vehicles/:id/status-history
GET  /trailers; POST /trailers/:id/assign {vehicle_id | null}
GET  /reminders                      -> {due, soon, items: [{kind, state, title, detail, link}]}
GET  /vehicles/:id now includes vehicle.status and vehicle.trailer.

Maintenance log (built):
GET  /service-config                -> {categories}                          shop, supervisor, admin
GET  /vehicles/:id/service          -> {entries, next_due, current_mileage}  shop, supervisor, admin
GET  /service-logs?limit            -> recent entries across the fleet
GET  /service-logs/:id              -> entry + repairs + photos + history
POST /service-logs                  {client_id, vehicle_id, ..., repair_item_ids[], photos[]}   shop, admin (idempotent)
PATCH /service-logs/:id             {version, changed fields, more repair_item_ids/photos}      shop, admin (409 if stale)
POST /service-logs/:id/void         {reason}                                                    shop, admin
```

## 8. Data notes from the paper forms

- There are 10 paper forms, one per truck model. They're identical except for the header and the vehicle diagram, so there's one checklist and a different diagram per model.
- Forms in use: 2017 Ram 1500, 2022 Ram 1500, 2016 Ram 2500, 2025 Ram 2500 (AZ018), International 4900 chassis, Isuzu NPR (AZ070), and others. Get the master vehicle list before seeding; it's still outstanding.
- Fixes made in the digital version: "Reflectors and Sings" → Signs; "Safety Chains Property Attached" → Properly; removed the duplicate "Check Visibility in Vehicle Mirrors" on the trailer page.
- Data to double-check: AZ070 (Isuzu NPR) shows registration expiration Feb 2021, and its VIN's 10th character decodes to 1999, not 1998. AZ018's registration shows 3/15/2026.
- Truck codes are AZ### or TX###.

## 9. Phases

1. **MVP (built):** auth, trucks, inspection form, photos, signatures, detail view, supervisor sign-off, single PDF export, backups, Cloudflare Tunnel.
   Added after review: full truck editor with trailer type, and branding.
2. **Maintenance log and fleet management:**
   - **Maintenance log (built, see §4 6a):** for the shop manager (`shop` role): log service and repairs on a truck, close the
     repair items it fixes, next-due tracking, and each truck's full history. Replaces Frank's paper logs.
   - **Several types of work on one maintenance entry (built 2026-11-11, migration 007):** an entry used to have exactly
     one type (oil change, tires, brakes, …); one shop visit often covers several, e.g. oil change + tires + brakes.
     - Form: "Type of work" becomes a multi-select (tap chips on and off, at least one).
     - **Next-due is separate per type (Tyler, 2026-11-11):** each selected type gets its own optional "next due" mileage
       and/or date under the chips (e.g. oil at +5,000 mi, tires at +40,000 mi). The truck page's "Next due" list keeps
       one line per type, taken from the newest live entry with that type (if that entry has no next-due for it, an older
       one is out of date and isn't shown).
     - Data: an additive migration stores the entry's work as a list of {type, next-due mileage, next-due date} on the entry
       row, filled from today's single type and next-due, so edit history, version checks and voiding cover it unchanged.
       The old columns stay and mirror the first type, so nothing already logged changes, and an older copy of the app
       (or a save queued on a phone before the update) that sends one type and one next-due is still accepted.
     - Everything that reads the type follows it: repair auto-ticking matches any selected type, lists and the inspection
       PDF show every type with its next-due, edit history shows type changes.
   - **Mark damage repaired (built 2026-11-11, migration 006):** damage on file (§4 item 3) used to build up forever, even
     after the body shop fixed it.
     - Each mark in "Damage on file" on the truck page gets **Repaired**: shop/admin can **Log fix** (opens a maintenance entry
       with that damage ticked, like repair items), and supervisors can mark it repaired with a short note.
     - **A photo of the fixed area is required (Tyler, 2026-11-11)**, either way it's marked: proof for lease returns. With
       Log fix, the maintenance entry can't be saved with that damage ticked until it has a photo tagged to it. The photo
       shows next to the original damage photo on the truck page.
     - A repaired mark drops off the inspection form's grey dots. The truck page keeps it, greyed out, under "Repaired", with
       when, who and the maintenance entry; nothing is deleted. Voiding that maintenance entry puts the damage back on file.
     - Data: an additive migration with a separate repairs record per mark (damage marks stay read-only, like inspections).
     - A supervisor's "mark repaired" can be undone (reason required) if it was a mistake; the repair record and its photo
       are kept and the damage goes back on file. A Log fix is undone by voiding its maintenance entry.
     - Feeds the lease-return checklist's "damage repaired" step in fleet management.
   - **Archive or delete inspections (built 2026-11-11, migration 005):** for mistakes (wrong truck, a duplicate, a test)
     and for clearing old ones out of the lists. It has to fit §4a ("nothing is hard-deleted from the app"), so proposed:
     - **Archive** (supervisor+): hides the inspection from home, truck history, the export list and sign-off lists. Still
       opens from a link or an "Archived" filter, still exports to PDF, and can be un-archived.
     - **Delete** (admin only, reason required): for inspections that should never have existed. It moves to a **Deleted**
       list under Admin, where it can be restored; the app itself never erases it. Its repair items leave the open-repairs
       lists and its pins leave "Damage on file" while it's deleted.
     - The submitted inspection itself stays read-only (the database triggers don't change): archived/deleted state lives
       in its own record (additive migration), with who, when and why, and every archive/delete/restore is kept as history.
     - **Deleted inspections are never erased (Tyler, 2026-11-11):** they stay recoverable from the Deleted list for good. No
       purge, no automatic clean-up, and no erase tool. **Changed 2026-11-19 (Tyler):** the Deleted list is now Admin →
       Trash, and after 7 days there an admin can delete one forever (§4a, migration 020). Still no automatic clean-up.
     - **Archiving also takes the inspection's open repairs and damage off the truck (Tyler, 2026-11-11)**, the same as
       deleting: they leave the open-repairs lists and "Damage on file" while it's archived, and come back if it's
       un-archived. So nothing drops out of sight by accident, the Archive confirmation names what will come off (e.g.
       "2 open repairs and 1 damage mark will come off AZ018's page").
   - **Fleet management, first part (built 2026-11-18, migration 015):**
     - **Status** on the truck page (Change): In service, In the shop, On hold, Preparing for return, Returned, Sold, and
       Retired (added for trucks taken out for any other reason, and those already switched off in Admin). The shop sets
       In service / In the shop / On hold on trucks in the fleet; supervisors and admins set any. Returned, Sold and
       Retired take the truck out of the fleet (crews no longer see it); Admin → Trucks' Active switch stays in step.
       Every change, from anywhere, is recorded by the database with who, when and an optional note (Status history on
       the truck page). Home screen truck cards show any status other than In service.
     - **Trailers on trucks:** the truck page's Trailer row (Change) puts a trailer on the truck; a truck pulls one
       trailer, so one already there comes off, and a trailer moves off its old truck. Moves are kept. The inspection
       form fills in the trailer on the truck; the equipment page shows which truck each trailer is on.
     - **Reminders** (Menu → Reminders, and a card on the home screen; supervisors, shop, admin): registrations expired or
       within 30 days, truck maintenance due or within two weeks (date or 500 miles), equipment due for a check, equipment
       maintenance due, the yard walk not done today, and trucks not inspected in 35 days (one line, with the numbers).
     - **Still to come:** lease details and the lease-return checklist (when Tyler has them), insurance dates, phone push.
     Original plan: add trucks, retire/remove them (kept in history), track lease details and **prepare for lease return**,
     and the rest of the truck's lifecycle. Tyler's answers (2026-11-17):
     - **Status:** in service, in the shop, **on hold** (Tyler added it), preparing for return, returned, sold. Shop,
       supervisors and admins can change it; every change is kept with who and when.
     - **Lease details and the lease-return checklist:** Tyler doesn't have them yet, so they wait. Build the rest without
       them and add the fields when he has a lease and a return form.
     - **Reminders** (registration, service due, and later insurance and lease end): an in-app list for supervisors.
     - **Trailers** are their own numbered assets. They move between trucks, but not often: each trailer is on one truck
       at a time and can be reassigned, with the history kept.
   - **Batch PDF export as separate PDFs (built, see §6)** and the **repairs board (built, see §4 item 6)**.
     **CSV export (built, see §6).**
   - **Checklist editor (built 2026-11-17, migration 011).** Admin → Checklist (admin only, Tyler 2026-11-17) lists the
     Exterior, Interior and Trailer & crew items in form order. An admin adds an item (at the end of its section), rewords
     one, moves it up or down, retires it (off the form for new inspections) or restores it (back at the end). No two
     items in use in a section may read the same. Every change is kept with who and when ("Recent changes"), and items are
     never deleted. Changes apply to new inspections only: submitted inspections keep the items, wording and order they
     had (detail screen and PDF), because each answer stores its wording and is listed in the order it was saved.
     A form already open on a phone keeps working: the form sends when it loaded the checklist, so the server doesn't
     demand items added after that and still accepts answers to items retired since. A draft that doesn't say (made
     before this) needs every current item, as before. The original items can never be skipped this way (a claimed
     checklist time counts back at most 90 days). Separate checklists for yards and equipment come with those features.
3. **Code review and hardening (done 2026-11-18, docs/PHASE3-REVIEW.md):** full code review; review and optimize performance
   while keeping stability; a burn-in test (many simulated phones submitting with bad signal over hours) to prove nothing
   is lost or duplicated; data-loss review against §4a.
4. Later: pull vehicle list and odometer from the **Geotab** API; Microsoft 365 / Entra ID SSO for supervisors and admins.
   (Moving off Tyler's machine is done: it runs on a DigitalOcean droplet since 2026-11-12.)
5. **Wishlist (Tyler; not scheduled):** Yard and equipment inspections share one foundation: an inspection type for
   something other than a truck (a yard, a piece of equipment), each type with its own checklist. That foundation is the
   phase-2 checklist editor plus "assets" beyond trucks (trailers are already in fleet management's scope), so build those
   together rather than three times.
   - **Supervisors update the registration expiration (built 2026-11-17, migration 008).** The inspection form, the
     sign-off screen and the truck page show the truck's registration expiration (red once expired, amber within 30 days);
     a supervisor or admin taps **Update**, enters the new date and can add a note and a photo of the new registration or
     sticker. It changes the truck, not the inspection (submitted inspections stay read-only), and needs signal: it isn't
     queued like the inspection itself. The screen sends the date it showed, so if someone changed it meanwhile nothing is
     overwritten and the new date is shown. Every change, including Admin → Trucks edits and any made outside the app, is kept
     for good in a registration history (who, when, from where, old and new date, note, photo) listed on the truck page.
     An inspection, its detail screen and its PDF show the date that was on file when it was submitted; one set while
     signing it off shows on that inspection. Tyler (2026-11-17): crew don't enter it, and plate and insurance don't get the
     same update.
   - **Yard inspections (built 2026-11-17, migration 012; asked for after the yard fire on 11/13/26).** Built as answered below:
     - **Who and where:** supervisors and admins walk a yard (the AZ yard for now; yards are a table, so more can be added);
       the shop can see yards, walks and findings. Menu → Yard walks, or the yard card on the home screen.
     - **The walk:** date, inspector (the signed-in name), the yard checklist in four sections (Fire safety; Fuel, oil &
       chemicals; Equipment & charging; Access & security) with OK / Repair, a note for each Repair, photos (on a problem or
       general), comments and a finger signature. Drafts are saved on the phone and queued like truck inspections, so a
       walk saved with no signal uploads by itself later (checked: saved with the server down, sent when it came back).
     - **Findings:** each Repair stays open until a supervisor resolves it with a note: on the yard page, the walk, and the
       top of the repairs board ("Yard findings"). Supervisors' home screen shows each yard with "Walked today" or "Not
       walked today" and its open findings, with a red banner while any are open (the in-app notice; phone push later).
     - **Records:** a walk is read-only once submitted (database triggers); only a finding's resolution is recorded later.
       Photos on a walk are never reused elsewhere or cleaned up. Each walk has a PDF (supervisors).
     - **The checklist** starts from the fire-review list below (12 items) and is edited in Admin → Checklist → Yard walk,
       the same way as the truck checklist (011), with the same rule that a walk opened before a change still sends.
     Original plan: a walk-through of a yard on its own checklist,
     with the same OK / Repair, notes, photos and signature as a truck inspection. Each finding becomes an open item on the
     repairs board until someone resolves it with a note. A fire-focused starting checklist to confirm: extinguishers present,
     charged and tagged; fuel and oil in closed cans or a cabinet, away from heat; oily rags in a closed metal can; green-waste
     and debris piles small and away from buildings, fences and equipment; mower decks and engines cleaned of clippings;
     equipment parked to cool away from piles; battery chargers and cords in good shape and not left charging unattended;
     clear access for fire trucks; gates, locks and lighting; emergency numbers posted. Tyler's answers (2026-11-17): no
     paper form yet, so start from the checklist above; one yard for now, **AZ**; **daily**, done by a **supervisor**; a
     failed item notifies **supervisors in the app** (an in-app notification first; a push to the phone can follow, which
     needs the app added to the home screen on iPhone but no paid service).
   - **Equipment checks (built 2026-11-18, migration 013).** Decided by Claude where Tyler hadn't said (told to him):
     - **Records:** Admin → Equipment keeps the trailers (number, description, plate, notes) and the equipment (tag, kind,
       make, model, serial, trailer, notes). A piece is moved by changing its trailer; trailers and pieces are retired,
       never deleted (a trailer only once its equipment is moved off), and every add, edit, move and retirement is kept
       with who and when (a piece's page shows it). Tags and trailer numbers are unique (ignoring case).
     - **Checklist:** an "All equipment" part (guards, leaks, starts, throttle/stop switch, air filter, tag) plus a part
       per kind (string trimmer, blower, hedge trimmer, edger, chainsaw, pole saw, mower, sprayer, other), edited in
       Admin → Checklist → Equipment with the same rules as the others. A piece is checked on "All equipment" + its kind.
     - **Checking:** the shop or a supervisor checks a trailer at a time (Menu → Equipment checks): each piece OK / Repair
       with a note and photos for each problem, or "Not here" (with where it is). No signature. Saved on the phone and
       queued like the other forms. Read-only once submitted; only a problem's resolution is recorded later.
     - **Due:** every piece every 30 days by default (Admin → Equipment changes it); "Not here" doesn't count as checked.
       The equipment page shows each trailer's pieces with Due / OK; the home screen shows how many are due and open problems.
     - **Problems** stay open (equipment page, repairs board "Equipment problems", the check) until the shop or a
       supervisor resolves them with a note.
     - **Maintenance log for equipment (built 2026-11-18, migration 014):** on a piece's page, the shop (and admins) log
       work: date, types of work (sharpen blade or chain, trimmer line/head, air filter, spark plug, fuel system/carburetor,
       oil change, tune-up, repair, other), each with an optional next-due date; what was done, parts, cost, who did it or
       which outside shop, notes, photos, and which of the piece's open problems it fixes ("Log fix" on a problem ticks it;
       saving resolves them). Next due per type comes from the newest live entry with that type, like trucks; once a date
       passes the piece shows "Service due" on the equipment page. Saved on the phone and queued like the other forms.
       Entries aren't edited: a mistaken one is voided with a reason, which reopens the problems it closed. The database
       refuses edits and deletes, and its photos are protected like any other. (Unlike the truck log, no editing yet.)
     - **Not built yet:** a PDF or CSV of equipment checks and maintenance, and hour meters.
     Original plan: inspections of equipment other than trucks, each piece with its own ID, its
     type's checklist and hours instead of mileage where it has a meter. Needs equipment as assets (add, retire, history),
     which overlaps fleet management. Tyler's answers (2026-11-17): the **yard-care equipment carried on the trailers**,
     about **8 pieces** (string trimmers, blowers and the like); each is numbered or tagged; **periodic** inspections for
     now; equipment gets **maintenance entries and next-due** like trucks. Paper forms per type: ask for copies if they exist.
   - **PDF repair ticket (built 2026-11-17, migration 010).** A printable or shareable ticket for repairs that go to the shop or an outside vendor.
     From the repairs board (a **Ticket** button per truck) or a truck page (**Make repair ticket** above its open repairs),
     a supervisor, the shop or an admin ticks the repairs (all start ticked), adds an optional "Sent to" (names used before
     are suggested) and note, and taps **Make ticket**. It needs signal, like a registration update; a retry never makes a
     second ticket. The ticket gets the next number (**RT-0001**…) and opens with **Share or email PDF** (where the phone
     can share files), **Save PDF** and **Open PDF to print**. Each repair on a ticket shows an RT pill on the board and the
     truck page; the truck page lists its tickets (Open, "1 of 2 fixed", All fixed, Voided). A ticket's **Log fix** (shop,
     admin) opens a maintenance entry with its still-open repairs ticked and "Repair ticket RT-0001" in the notes; fixes made
     any way show on the ticket and its PDF ("Fixed 11/20/2026 by Frank (maintenance log): …"). A mistaken ticket is
     **voided** with a reason: it stays listed, its PDF says VOID, and its repairs stay open. Tickets are never deleted and
     their repairs never change (database triggers); the repairs CSV lists each repair's tickets. Original plan: the ticket
     carries a ticket number, branding, the truck (code, VIN, plate, last mileage), each problem with its note, photos, who
     reported it and when, and blank lines for the shop: work done, parts, cost, date, signature. The ticket is logged on the
     truck, and closing its repairs still goes through a maintenance entry (Log fix), which can name the ticket. Tyler's
     answers (2026-11-17): it goes to **both** Frank's shop and outside vendors; it's a PDF that can be **printed, shared
     or emailed** from the phone's share sheet (no mail service needed); a ticket holds **one or several** repairs on one
     truck (whatever is ticked); **no PO or work-order number** for now. Since 2026-11-18 (019) a ticket can also hold
     damage from an incident report, but **only if someone ticks it**: the picker never ticks incident damage for you
     (Tyler: a totaled truck mustn't go to the mechanic). It's listed under the repairs as "Incident damage", named by
     its description; the board's Ticket button on a piece of incident damage ticks just that piece.
   - **Incident reports (2026-11-12; built 2026-11-18).** Built from GC's incident forms (Tyler, 2026-11-18; copies in
     `reference/incidents/`): the Managers Incident Report, Vehicle Accident Report, Photograph Log, Employee
     Injury/Near Miss Report and Employee Refusal of Medical Treatment. Tyler's answers (2026-11-18): **leave the
     driver's home address, birth date and license number blank** (printed blank; not kept in the app) and there's **no
     employee ID** yet; the **Enterprise Unit ID** prints blank until Tyler has access to Enterprise's list; the app
     **doesn't collect** the injury forms but **generates them** in the PDF when our employee was hurt (the refusal form
     only if they weren't taken for a medical evaluation), filled in as far as the report knows; the **map** is a
     screenshot the supervisor adds plus the phone's location printed as a Google Maps link (no paid map service); HR's
     **claim numbers** and the photo log's **Task ID** print blank; **supervisors and admins** only. What was built:
     a supervisor files a report from the truck page (form in the Vehicle Accident Report's order; only the date,
     driver, injuries yes/no, what happened and the manager's name and signature are required); damage pins go on the
     truck's damage on file and count as open repairs until marked repaired or fixed through the maintenance log
     (repairs board "Incident damage", repairs CSV); supervisors and admins see new reports on their home screen until
     they open them; the PDF is the forms filled in, plus a damage diagram page and any notes added later. Incident
     damage can go on a repair ticket only when it's ticked (019, see the repair ticket answers above). Original
     starting point: filed from the phone by whoever was there, tied to a truck (and trailer) when one was
     involved; date, time and location; what happened; people involved and any injuries; the other party, their vehicle and
     insurance; police report number; photos, damage pins on the truck diagram and a signature; supervisor review and a PDF.
     Same data rules as inspections (§4a): read-only once submitted, corrections in a supervisor note, archive/delete without
     erasing. Tyler's answers (2026-11-17): **vehicle incidents only** for now; **supervisors** file them and **supervisors**
     are told right away; damage from an incident **goes into the truck's "Damage on file" and repair items**.
6. **Build order (Tyler left it to Claude, 2026-11-17):** PDF repair ticket (built) → checklist editor (built) → yard
   inspections (built) → equipment checks (built) → maintenance log for equipment (built) → fleet management (status,
   trailers on trucks, supervisor reminders: built; lease details when Tyler has them) → incident reports (built
   2026-11-18).
   Phase 3 (code review, performance, burn-in, data-loss review): done 2026-11-18, see docs/PHASE3-REVIEW.md.
7. **Delete for real, and dark mode (Tyler, 2026-11-19; built the same day, migration 020).** "We need to revisit my never
   delete anything core value. We might need a way to delete things." Tyler's answers: delete **all of these** (test data,
   mistakes, personal info on request, records by age), a **7-day** wait in the trash before Delete forever, **admins
   only**. Built as the trash in §4a. Also "needs a dark mode": the app follows the phone's light or dark setting, and
   Menu → Appearance picks Auto, Light or Dark (kept on the phone). Photos, diagrams, signatures and the sketch stay on
   white, like paper; PDFs don't change.
8. **About & updates, and a backup before migrations (Tyler, 2026-11-23; built the same day, migration 021).** For the
   public copy of the app (people running their own server want to know when there's a new version), built here so
   both get it. Tyler agreed to this design:
   - **No one-click update, on purpose (a security decision).** Installing an update means rebuilding containers, which
     needs root-level control of Docker on the host (the Docker socket). Giving the app that would let anyone who takes
     over the app or an admin account take over the whole server. And a failed database migration needs a person
     looking at it, not a button. So the app never installs anything and has no access to Docker or the host:
     whoever runs the server installs updates (docs/DEPLOY.md §6), and Admin → About shows the steps.
   - **Admin → About & updates** (admins only): the running version (`package.json` `version`), the database's migration
     level (the latest applied migration and how many), and the **last backup**: when it ran, whether it worked, its
     files and sizes, and the recent runs. The nightly job records every run in `backup_runs` (021) with `psql`
     (kind, label, times, file names, sizes, a short error; no secrets); recording never makes a backup fail. The
     backup folder is read too, as a second witness (restoring a backup brings back an older `backup_runs`). A red
     warning shows when the last good backup is over 2 days old, none is on record, or the last run failed.
   - **Optional update check, off by default.** Only when `UPDATE_CHECK_REPO` (`owner/name`) is set; blank hides it
     (this repository is private, so it stays blank here). An admin turns it on in About (kept in `settings`). Then the
     server sends one plain GET to GitHub's latest-release API for that repository at most once a day (the answer is
     kept in `settings`, so restarts don't ask again; a failed check also waits a day), with no version, user or record
     in it, and compares the release's semver tag with the running version. About shows "Version X is available" with
     the release notes (as plain text), a link to the release page (built from the repository name, never taken from
     the answer), and the update steps. No network, a rate limit or an odd answer shows "Couldn't check", never an
     error page.
   - **Automatic backup before migrations:** §4a.
   - The public copy also gets versioned releases with a CHANGELOG and prebuilt Docker images; those live in the public
     repository only, which sets `UPDATE_CHECK_REPO` and bumps `package.json` versions per release.

## 10. Acceptance checklist for MVP

- [ ] A crew lead on an iPhone in Safari can sign in, complete an AZ018 inspection with 3 damage pins and 4 photos, and submit in under 5 minutes.
- [ ] Turning Wi-Fi/cell off mid-form loses nothing; the submit succeeds when signal returns, and a double tap on Save creates one record.
- [ ] A supervisor can sign off, and the PDF matches the paper layout, including pins, photos and both signatures.
- [ ] The next inspection on that truck shows all earlier damage as grey dots and prefills the notes.
- [x] `docker compose up -d` brings everything up (first on Tyler's PC, now on a DigitalOcean droplet); a restore from backup is tested once.
  (2026-11-11: stack running; full flow, PDFs, backup, restore and undo checked on a throwaway copy of the stack.)
