# Grounds Control Vehicle Inspections

Phone-first web app that replaces the paper Truck Inspection Sheet: crews sign in with a PIN, fill the same
checklist on their phone, drop numbered damage pins on the truck diagram, add photos and sign with a finger.
Supervisors sign off and export a PDF that looks like the paper form. The shop keeps a maintenance log, open repairs
are tracked across the fleet, repair tickets go out as PDFs, supervisors walk the yard daily on a fire-safety
checklist, the shop checks the equipment on each trailer, and everything exports to CSV. Works with weak or no signal:
drafts stay on the phone and upload when signal returns.

- **Spec:** [SPEC.md](SPEC.md) (source of truth, including the roadmap and Tyler's answers) · **Deploy:** [docs/DEPLOY.md](docs/DEPLOY.md)
- **Vehicle data questions:** [seed/DATA-ISSUES.md](seed/DATA-ISSUES.md)
- **Live:** a DigitalOcean droplet behind Cloudflare (since 2026-11-12). Updates: [docs/DEPLOY.md §6](docs/DEPLOY.md#6-updating).

## Phase 1 (MVP): done

| Area | Status |
|---|---|
| Sign in: crew name + PIN (30-day session), supervisor/admin email + password | done |
| Home: search trucks; badges for last inspection (amber over 35 days), open repairs, draft, registration expired | done |
| Truck page: start/resume, status and trailer, open repairs from all inspections, damage on file, maintenance, repair tickets, history | done |
| Inspection form: same order as paper; damage pins, with all damage already on file shown as grey dots and listed; photos on pins and repairs; trailer section; finger signature; save bar lists what's missing | done |
| Offline: draft autosaves to the phone (IndexedDB); uploads retry with backoff; "Saved on phone, not yet uploaded"; duplicate-proof submit (`client_id`) | done |
| Inspection detail: repairs first, pins, photo gallery, full checklist, supervisor sign-off, resolve repairs | done |
| PDF export matching the paper form (page 1 sheet, page 2 trailer + signatures, photo pages) | done |
| Admin: users and PINs, trucks (every header field, trailer type, diagram), trailers and equipment, truck/yard/equipment checklists, branding (name, color, logo), deleted inspections | done |
| Docker Compose: Postgres 16, app, Caddy, nightly backups, optional Cloudflare Tunnel | running on the droplet; backup and restore tested |

## Phase 2

| Area | Status |
|---|---|
| Maintenance log for the shop manager (`shop` role): log work per truck with mileage, parts, cost, photos; close inspection repairs; next-due mileage/date; edit history; void instead of delete; works offline | done |
| Maintenance log: several types of work on one entry (multi-select, next-due per type) | done |
| Mark damage repaired (photo of the fix required; Log fix or supervisor; drops off the form's grey dots, kept on the truck page) | done |
| Archive or delete inspections (delete = recoverable forever, admin only, reason required); database refuses to erase inspections | done |
| Batch PDF export: tick inspections, get one PDF each (zip, or share as separate files) | done |
| Repairs board: every open repair across the fleet, by truck or oldest first, with Log fix / Resolve / Ticket | done |
| CSV export: inspections, repairs, maintenance log, trucks, with truck/date filters (Download CSV in the menu) | done |
| Checklist editor (Admin → Checklist: truck inspection, yard walk or equipment): add, reword, reorder, retire and restore items, with a change history. New inspections only; submitted ones keep their items and wording, and a form already open on a phone still sends | done |
| Fleet management: truck status (in service, in the shop, on hold, preparing for return, returned, sold, retired) with history; trailers moved between trucks; a reminders list (registrations, inspections, maintenance, equipment, yard) | done (lease details and the lease-return checklist wait until Tyler has them) |

## Wishlist (SPEC §9 item 5)

| Area | Status |
|---|---|
| Registration expiration: supervisors update it from the form, sign-off or truck page; full history; PDFs keep the date on file | done |
| PDF repair ticket: tick repairs on a truck, numbered ticket (RT-0001) to print/share/email, Log fix from it, void with a reason | done |
| Yard walks (after the 11/13/26 yard fire): daily at AZ by a supervisor on a fire-safety checklist with OK/Repair, notes, photos and signature; works offline; problems stay open on the yard page, the repairs board and supervisors' home screen until resolved; PDF | done |
| Equipment checks: trailers and tagged equipment kept in Admin (moves between trailers and retirements kept); the shop or a supervisor checks a trailer at a time, each piece on its type's checklist or "Not here"; due every 30 days (changeable); works offline; problems on the equipment page, repairs board and home screen until resolved | done |
| Maintenance log for equipment: the shop logs work on a piece (types of work, next due per type, cost, photos), closes its open problems ("Log fix"), void with a reason; "Service due" once a date passes; works offline | done |
| Incident reports: vehicle incidents filed by supervisors; damage goes on the truck's record | waiting on a sample form |

Build order and every answered question are in SPEC §9.

## Phase 3: done (2026-11-18)

Full code review, performance check with five years of data, a one-hour burn-in test (30 simulated phones on a bad
connection while the app crashes and the database restarts), and a data-loss review against SPEC §4a. Findings and
fixes: [docs/PHASE3-REVIEW.md](docs/PHASE3-REVIEW.md).

## Security and data safety

- Nothing is hard-deleted: inspections, yard walks, equipment checks, trailers, equipment, maintenance entries, damage
  repairs, registration history, repair tickets and checklist items are kept for good (retire, void or archive
  instead), and the database refuses deletes. See SPEC §4a.
- Sign-in: lockout after 5 wrong tries (longer if it keeps happening that day), 20 wrong tries an hour per network,
  real client addresses behind Caddy and Cloudflare. Photo uploads: 1 GB per person a day, and they pause before the
  disk fills. HSTS over HTTPS. Details in SPEC §3.
- Burn-in tested: phones on a bad connection, app crashes and database restarts lose or duplicate nothing
  (`scripts/burnin.ts`, docs/PHASE3-REVIEW.md).

## Layout

```
src/                 Fastify API (TypeScript, run directly by Node 24, no build step)
  routes/            auth, vehicles, photos, inspections, service (maintenance), tickets, export (CSV),
                     checklist (editor), yard (yard walks), equipment (trailers, equipment, checks),
                     equipment-service (equipment maintenance), fleet (status, trailers, reminders), admin, branding
  photo-owners.ts    the one list of records a photo can belong to (used by every photo check and the clean-up)
  pdf.ts             paper-form HTML template -> PDF via headless Chromium
  ticket-pdf.ts      repair ticket PDF
  yard-pdf.ts        yard walk PDF
  csv.ts             CSV files for Excel (formula-safe)
  storage.ts         photo/signature storage (local disk today; S3/Azure later behind the same interface)
public/              the web app (plain HTML/CSS/JS modules, no framework), service worker, diagrams
  js/views/          one module per screen (home, truck, form, detail, repairs, tickets, yard, csv, export, admin…)
  js/drafts.js, svc.js, yardq.js, equipq.js, esvcq.js   what's saved on the phone and the upload queues
                     (inspections, maintenance, yard walks, equipment checks, equipment maintenance)
db/migrations/       numbered SQL migrations, applied automatically on start (never edit one that has shipped)
seed/vehicles.csv    trucks added on start if missing (never overwrites edits made in Admin)
scripts/             backup.sh (nightly, run by the backup container), restore.sh, burnin.ts (burn-in test)
test/                API tests against a real Postgres, plus browser-file and CSV checks
prototype/, reference/   the approved claude.ai prototype and the original paper forms
```

## Run it on the server

See [docs/DEPLOY.md](docs/DEPLOY.md). Short version:

```bash
cp .env.example .env    # then edit passwords, admin email, site address
docker compose up -d --build
```

## Develop locally

Needs Node 24+ and a Postgres 16 database.

```bash
npm install
npx playwright install chromium        # for PDF export
```

Create `.env.local` (gitignored) with at least `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, then:

```bash
npm run dev                            # http://localhost:3000, migrations run on start
npm run user -- add --name "Test Crew" --role crew --pin 1234
npm run typecheck
```

The tests need a throwaway Postgres; they wipe it. With Docker:

```bash
docker run -d --name gc-unit-pg -e POSTGRES_USER=gc -e POSTGRES_PASSWORD=gctest -e POSTGRES_DB=gc_test -p 127.0.0.1:54330:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://gc:gctest@localhost:54330/gc_test npm test
docker rm -f -v gc-unit-pg
```

Burn-in test (needs its own empty database; about an hour):

```bash
docker run -d --name gc-burn-pg -e POSTGRES_USER=gc -e POSTGRES_PASSWORD=gctest -e POSTGRES_DB=gc_burn -p 127.0.0.1:54331:5432 postgres:16-alpine
node scripts/burnin.ts --db postgres://gc:gctest@localhost:54331/gc_burn --minutes 60 --phones 30 --crash-every 5 --pg-container gc-burn-pg
docker rm -f -v gc-burn-pg
```

Changes under `public/` need a server restart so the service worker picks up the new version.
