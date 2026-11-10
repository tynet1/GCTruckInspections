# Grounds Control Vehicle Inspections — Build Spec

Owner: Tyler Longshore (Business Systems & Technology Manager)
Status: prototype done (see `prototype/`), production build next
Target: self-hosted on a Linux VM (starts on Tyler's machine, moves to a company server later)

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
| admin | Tyler, COO | Everything, plus manage trucks, trailers, diagrams, checklist items and users |

Crew sign-in has to be fast on a phone in a truck: pick your name, enter a 4–6 digit PIN, and the session stays signed in for about 30 days. Supervisors and admins use email + password. Microsoft 365 SSO is a later phase (see §9).

## 3. Stack (recommended; Claude Code may adjust with a reason)

- **Runtime:** Docker Compose on Ubuntu Server 24.04 VM
- **DB:** PostgreSQL 16 (`db/schema.sql` is the starting point, already tested to load cleanly)
- **App:** Node.js 20 + TypeScript, Fastify API. Frontend is a mobile-first web app; the prototype's plain HTML/JS UI is a fine base, or SvelteKit if the app grows. No native app.
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
7. **Admin:** trucks (add, edit, retire, upload diagram), trailers, users and PINs, checklist items (add, reorder, deactivate; never hard-delete).

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
- Batch export: a date range and optional truck as one combined PDF, plus CSV export of inspections and repair items

## 7. API sketch

```
POST /auth/pin            {user_id, pin}
POST /auth/login          {email, password}
GET  /vehicles            -> vehicle_status rows
GET  /vehicles/:id        -> vehicle + open repairs + history
GET  /vehicles/:id/last   -> last inspection (to prefill notes and grey pins)
POST /photos              multipart -> {id}   (before submit; orphan cleanup after 7 days)
POST /inspections         {client_id, ..., items[], damage[], photo_ids[]}
GET  /inspections/:id
POST /inspections/:id/review     {signature (png)}        supervisor+
POST /inspection-items/:id/resolve {note}                 supervisor+
GET  /inspections/:id/pdf
GET  /export/inspections.csv?from&to&vehicle
admin CRUD: /vehicles, /trailers, /diagrams, /users, /checklist-items
```

## 8. Data notes from the paper forms

- There are 10 paper forms, one per truck model. They're identical except for the header and the vehicle diagram, so there's one checklist and a different diagram per model.
- Forms in use: 2017 Ram 1500, 2022 Ram 1500, 2016 Ram 2500, 2025 Ram 2500 (AZ018), International 4900 chassis, Isuzu NPR (AZ070), and others. Get the master vehicle list before seeding; it's still outstanding.
- Fixes made in the digital version: "Reflectors and Sings" → Signs; "Safety Chains Property Attached" → Properly; removed the duplicate "Check Visibility in Vehicle Mirrors" on the trailer page.
- Data to double-check: AZ070 (Isuzu NPR) shows registration expiration Feb 2021, and its VIN's 10th character decodes to 1999, not 1998. AZ018's registration shows 3/15/2026.
- Truck codes are AZ### or TX###.

## 9. Phases

1. **MVP (pilot with 2–3 crew leads):** auth, trucks, inspection form, photos, signatures, detail view, supervisor sign-off, single PDF export, backups, Cloudflare Tunnel
2. Repairs board, batch PDF/CSV export, admin screens polished
3. Service log (Frank's paper logs) linked to vehicles and repairs; pull vehicle list and odometer from **Geotab** API
4. Microsoft 365 / Entra ID SSO for supervisors and admins; move off Tyler's machine to a company VM or Azure

## 10. Acceptance checklist for MVP

- [ ] A crew lead on an iPhone in Safari can sign in, complete an AZ018 inspection with 3 damage pins and 4 photos, and submit in under 5 minutes.
- [ ] Turning Wi-Fi/cell off mid-form loses nothing; the submit succeeds when signal returns, and a double tap on Save creates one record.
- [ ] A supervisor can sign off, and the PDF matches the paper layout, including pins, photos and both signatures.
- [ ] The next inspection on that truck shows the previous pins as grey dots and prefills the notes.
- [ ] `docker compose up -d` on a fresh Ubuntu VM brings everything up; a restore from backup is tested once.
