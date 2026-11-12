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

A trailer type is a named trailer diagram. Every inspection records which truck and trailer pictures it was drawn on, so changing a truck's diagram or trailer type later never moves old pins.

## 4a. Data safety (top priority)

Losing an inspection, photo or log entry is the worst failure this app can have. Every change is judged against that first.

- Nothing is hard-deleted from the app: trucks, users, diagrams and checklist items are retired, not removed.
- Submitted records are read-only in the database (triggers), and corrections go in notes.
- The phone keeps a draft until the server confirms it; submits are idempotent; uploads retry.
- Files are written to a temp file, flushed to disk and renamed, so a crash never leaves a half-written photo.
- Schema changes only add numbered migrations, each in one transaction.
- Damage repairs (006) can't be edited or deleted, only ended (undo / voided entry) with who, when and why.
- The database refuses to delete inspections, their checklist answers and damage marks, and any photo once it's attached
  (005). "Delete" in the app only marks an inspection deleted; it stays restorable for good, with every change kept as history.
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
GET  /vehicles/:id        -> vehicle + open repairs + history + damage on file (with photos)
GET  /vehicles/:id/last   -> last inspection (to prefill notes) + all damage on file that fits today's picture (grey pins)
POST /photos              multipart -> {id}   (before submit; orphan cleanup after 7 days)
POST /inspections         {client_id, ..., items[], damage[], photo_ids[]}
GET  /inspections?limit&status&vehicle_id&from&to&archived   (from/to: inclusive dates; archived=only|include, else live only)
POST /inspections/:id/archive {reason?} · /unarchive          supervisor+
POST /inspections/:id/delete {reason} · /restore             admin
GET  /admin/deleted-inspections                               admin
POST /damage-marks/:id/repair {client_id, note, photo_ids[]}   supervisor+ (photo required; idempotent)
POST /damage-repairs/:id/undo {reason}                       supervisor+ (supervisor repairs only)
POST/PATCH /service-logs also take damage_mark_ids[], with photos[].damage_mark_id for the photo of each fix
GET  /inspections/:id
POST /inspections/:id/review     {signature (png)}        supervisor+
POST /inspection-items/:id/resolve {note}                 supervisor+
GET  /inspections/:id/pdf
GET  /repairs?vehicle_id                 -> open repairs across the fleet (repairs board)   supervisor, shop, admin
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
       purge, no automatic clean-up, and no erase tool.
     - **Archiving also takes the inspection's open repairs and damage off the truck (Tyler, 2026-11-11)**, the same as
       deleting: they leave the open-repairs lists and "Damage on file" while it's archived, and come back if it's
       un-archived. So nothing drops out of sight by accident, the Archive confirmation names what will come off (e.g.
       "2 open repairs and 1 damage mark will come off AZ018's page").
   - **Fleet management:** add trucks, retire/remove them (kept in history), track lease details and **prepare for lease return**,
     and the rest of the truck's lifecycle. Scope to confirm with Tyler before building; proposed:
     status (in service, in the shop, preparing for return, returned, sold), lease info (lessor, start/end dates, mileage
     allowance), a lease-return checklist (damage repaired, keys, documents, final inspection and photos), registration and
     insurance dates with reminders, and trailers as their own assets.
   - **Batch PDF export as separate PDFs (built, see §6)** and the **repairs board (built, see §4 item 6)**.
     Still to do: CSV export, checklist editor.
3. **Code review and hardening:** full code review; review and optimize performance while keeping stability; a burn-in test
   (many simulated phones submitting with bad signal over hours) to prove nothing is lost or duplicated; data-loss review against §4a.
4. Later: pull vehicle list and odometer from the **Geotab** API; Microsoft 365 / Entra ID SSO for supervisors and admins;
   move off Tyler's machine to a company VM or Azure.

## 10. Acceptance checklist for MVP

- [ ] A crew lead on an iPhone in Safari can sign in, complete an AZ018 inspection with 3 damage pins and 4 photos, and submit in under 5 minutes.
- [ ] Turning Wi-Fi/cell off mid-form loses nothing; the submit succeeds when signal returns, and a double tap on Save creates one record.
- [ ] A supervisor can sign off, and the PDF matches the paper layout, including pins, photos and both signatures.
- [ ] The next inspection on that truck shows all earlier damage as grey dots and prefills the notes.
- [x] `docker compose up -d` (on Tyler's PC with Docker Desktop for now) brings everything up; a restore from backup is tested once.
  (2026-11-11: stack running; full flow, PDFs, backup, restore and undo checked on a throwaway copy of the stack.)
