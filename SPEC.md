# Grounds Control Vehicle Inspections — Build Spec

Owner: Tyler Longshore (Business Systems & Technology Manager)
Status: phase 1 (MVP) built, plus trailer types and branding; phase 2 maintenance log built; fleet management waiting on answers (§9)
Target: for now, Docker Desktop on Tyler's own Windows PC, used from Tyler's phone only. Moves to a company server later.

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
| supervisor | Crew supervisors, fleet/shop | Everything crew can do, plus review and sign off inspections, mark repairs resolved, export PDFs |
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
- **Backups:** nightly `pg_dump` plus an uploads tarball to a second location, keeping 30 days

### Remote access (decide early)

Crews are on cellular in the field, so a VM on Tyler's machine is not reachable from their phones by default. Options:

1. **Cloudflare Tunnel** (recommended for the pilot): no open ports, real HTTPS hostname, free. Add Cloudflare Access later if wanted.
2. Tailscale Funnel: works, but Funnel is less flexible for a production hostname.
3. Port-forward and dynamic DNS: not recommended.

The pilot can start on Wi-Fi at the yard if needed.

**Current decision (Nov 2026):** the app runs on Tyler's PC and only Tyler's phone uses it. On the same Wi-Fi that works at
`http://<pc-address>`. Away from that network, or for offline use (the service worker needs HTTPS), it needs the Cloudflare
Tunnel, which needs a domain on Tyler's Cloudflare account.

## 4. Screens (all phone-first, also good on iPad)

1. **Sign in:** name picker + PIN pad, or email/password for supervisors and admins.
2. **Home / pick a truck:** searchable list of trucks (code, year/make/model, plate, VIN). Each shows badges for last inspection date (warn if over 35 days), open repair count, draft in progress, and registration expired.
3. **Truck page:** header info, Start/Resume inspection, open repairs from all past inspections, and inspection history.
4. **Inspection form** (same order as the paper sheet):
   - Truck header (read-only)
   - Date (default today), inspector name (default signed-in user), mileage (numeric keypad), oil change due Yes/No
   - **Damage diagram:** tap to drop a numbered pin and describe it. Pins from the previous inspection show as grey dots for reference. A photo can be attached to a pin.
   - Existing notes (prefilled from the previous inspection's notes and observations) and New observations
   - Checklist sections, Exterior (16) and Interior (16). Each item has big OK / Repair buttons; Repair requires a short note and allows a photo. "Mark rest OK" per section.
   - Trailer switch (defaults on if the truck usually pulls a trailer). When on: trailer number/plate, trailer diagram with pins, and the Trailer & crew checklist (17).
   - Photos with captions; upload them as they're added
   - Comments
   - Employee signature (finger-drawn)
   - Sticky bottom bar with progress (N of M items) and Save. Save is blocked until required fields are done, and the missing items are listed and highlighted.
   - Drafts autosave on the device (IndexedDB) and survive closing the browser
5. **Inspection detail:** everything submitted, repairs listed first, damage diagram with pins, photo gallery with full-screen view, full checklist, signatures. Supervisor sign-off happens here (name + finger signature). **Export PDF** button.
6. **Repairs board** (supervisor): all open repair items across the fleet, filterable by truck. Mark resolved with a note, optionally linked to a service log entry.
6a. **Maintenance log** (shop, admin; supervisors can read): on the truck page, "Next due" (from the newest entry of each type,
   orange within 500 miles or 14 days, red when due), the list of entries, and "+ Log maintenance". The entry form has date,
   mileage, type of work (oil change, tires, brakes, repair, preventive maintenance, inspection/registration, other), work done,
   parts, cost, done by, outside shop, the truck's open repairs to tick off, next due mileage/date, photos, notes. An entry
   shows its repairs, photos and every change ("Cost: $64.20 → $66.40"). Shop/admin can edit it or void it with a reason.
   **Closing repairs:** every open repair (truck page and inspection) has a **Log fix** button for shop/admin that opens a new
   entry with that repair ticked and the type of work picked. Picking a type of work also ticks matching open repairs
   (oil change → engine oil; tires → tire items; brakes → brake items but not brake lights; inspection/registration → plate,
   tag and registration items), shown with a "Matches …" label; a tick the shop set or cleared by hand is never changed.
   Saving closes the ticked repairs; the inspection then shows "✓ Repairs fixed" (green) instead of red, and each fixed
   repair links to its entry. Supervisors keep the quick **Resolve** (note only).
7. **Admin:** trucks (add, edit every header field, retire, pick or upload the body diagram, set the trailer type or "no trailer"), trailer types (name + picture), users and PINs, branding (company name, app name, header color, logo), checklist items (add, reorder, deactivate; never hard-delete).

A trailer type is a named trailer diagram. Every inspection records which truck and trailer pictures it was drawn on, so changing a truck's diagram or trailer type later never moves old pins.

## 4a. Data safety (top priority)

Losing an inspection, photo or log entry is the worst failure this app can have. Every change is judged against that first.

- Nothing is hard-deleted from the app: trucks, users, diagrams and checklist items are retired, not removed.
- Submitted records are read-only in the database (triggers), and corrections go in notes.
- The phone keeps a draft until the server confirms it; submits are idempotent; uploads retry.
- Files are written to a temp file, flushed to disk and renamed, so a crash never leaves a half-written photo.
- Schema changes only add numbered migrations, each in one transaction.
- Nightly backups (database + uploads) to a second location, and a restore is tested (done 2026-11-11 on Tyler's PC: restored
  data matched the backup row for row and file for file). A backup is written to a temp file and renamed only when complete,
  never overwrites an existing backup, and runs one at a time. A restore first saves the current data as a `_before-restore`
  backup, so a wrong restore can be undone.
- The app survives the database restarting under it (a dropped connection is logged and replaced, not a crash).
- Maintenance entries: never deleted (void with a reason; the database refuses deletes), every edit saves the previous version,
  an edit made from an out-of-date copy is refused instead of overwriting, and voiding reopens the repairs the entry closed.
  Orphan-photo cleanup skips photos attached to an entry.

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
- CSV export of inspections and repair items: not built yet.

## 7. API sketch

```
POST /auth/pin            {user_id, pin}
POST /auth/login          {email, password}
GET  /vehicles            -> vehicle_status rows
GET  /vehicles/:id        -> vehicle + open repairs + history
GET  /vehicles/:id/last   -> last inspection (to prefill notes and grey pins)
POST /photos              multipart -> {id}   (before submit; orphan cleanup after 7 days)
POST /inspections         {client_id, ..., items[], damage[], photo_ids[]}
GET  /inspections?limit&status&vehicle_id&from&to   (from/to: inclusive inspection dates, YYYY-MM-DD)
GET  /inspections/:id
POST /inspections/:id/review     {signature (png)}        supervisor+
POST /inspection-items/:id/resolve {note}                 supervisor+
GET  /inspections/:id/pdf
GET  /export/inspections.csv?from&to&vehicle
admin CRUD: /vehicles, /trailers, /diagrams, /users, /checklist-items

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
   - **Several types of work on one maintenance entry (requested 2026-11-11, not started):** today an entry has exactly one
     type (oil change, tires, brakes, …); one shop visit often covers several, e.g. oil change + tires + brakes. Make "Type of
     work" a multi-select (tap chips on and off, at least one). Plan: an additive migration adds a list of types per entry,
     filled from the current single type, with the old column kept so nothing already logged changes. Everything that reads
     the type follows it: repair auto-ticking matches any selected type, lists and the inspection PDF show every type, edit
     history records type changes. **To decide with Tyler first:** next-due is tracked per type today (one "next due"
     mileage/date per entry); with several types on one entry, should each selected type get its own next-due (e.g. oil
     at +5,000 mi, tires at +40,000 mi), or one shared next-due for the visit?
   - **Fleet management:** add trucks, retire/remove them (kept in history), track lease details and **prepare for lease return**,
     and the rest of the truck's lifecycle. Scope to confirm with Tyler before building; proposed:
     status (in service, in the shop, preparing for return, returned, sold), lease info (lessor, start/end dates, mileage
     allowance), a lease-return checklist (damage repaired, keys, documents, final inspection and photos), registration and
     insurance dates with reminders, and trailers as their own assets.
   - **Batch PDF export as separate PDFs (built, see §6).** Still to do: CSV export, repairs board, checklist editor.
3. **Code review and hardening:** full code review; review and optimize performance while keeping stability; a burn-in test
   (many simulated phones submitting with bad signal over hours) to prove nothing is lost or duplicated; data-loss review against §4a.
4. Later: pull vehicle list and odometer from the **Geotab** API; Microsoft 365 / Entra ID SSO for supervisors and admins;
   move off Tyler's machine to a company VM or Azure.

## 10. Acceptance checklist for MVP

- [ ] A crew lead on an iPhone in Safari can sign in, complete an AZ018 inspection with 3 damage pins and 4 photos, and submit in under 5 minutes.
- [ ] Turning Wi-Fi/cell off mid-form loses nothing; the submit succeeds when signal returns, and a double tap on Save creates one record.
- [ ] A supervisor can sign off, and the PDF matches the paper layout, including pins, photos and both signatures.
- [ ] The next inspection on that truck shows the previous pins as grey dots and prefills the notes.
- [x] `docker compose up -d` (on Tyler's PC with Docker Desktop for now) brings everything up; a restore from backup is tested once.
  (2026-11-11: stack running; full flow, PDFs, backup, restore and undo checked on a throwaway copy of the stack.)
