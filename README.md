# Grounds Control Vehicle Inspections

Phone-first web app that replaces the paper Truck Inspection Sheet: crews sign in with a PIN, fill the same
checklist on their phone, drop numbered damage pins on the truck diagram, add photos and sign with a finger.
Supervisors sign off and export a PDF that looks like the paper form. Works with weak or no signal: drafts stay
on the phone and upload when signal returns.

- **Spec:** [SPEC.md](SPEC.md) (source of truth) · **Deploy:** [docs/DEPLOY.md](docs/DEPLOY.md)
- **Vehicle data questions:** [seed/DATA-ISSUES.md](seed/DATA-ISSUES.md)

## What's in phase 1 (MVP)

| Area | Status |
|---|---|
| Sign in: crew name + PIN (30-day session), supervisor/admin email + password, lockout after 5 wrong tries (longer if it keeps happening that day), wrong tries capped per network | done |
| Home: search trucks; badges for last inspection (amber over 35 days), open repairs, draft, registration expired | done |
| Truck page: start/resume, open repairs from all inspections, history | done |
| Inspection form: same order as paper; damage pins, with all damage already on file shown as grey dots and listed; photos on pins and repairs; trailer section; finger signature; save bar lists what's missing | done |
| Offline: draft autosaves to the phone (IndexedDB); uploads retry with backoff; "Saved on phone, not yet uploaded"; duplicate-proof submit (`client_id`) | done |
| Inspection detail: repairs first, pins, photo gallery, full checklist, supervisor sign-off, resolve repairs | done |
| PDF export matching the paper form (page 1 sheet, page 2 trailer + signatures, photo pages) | done |
| Admin: users and PINs, trucks (every header field, trailer type, diagram), branding (name, color, logo) | done |
| Docker Compose: Postgres 16, app, Caddy, nightly backups, optional Cloudflare Tunnel | running on a DigitalOcean droplet since 2026-11-12 (Tyler's PC before that); backup and restore tested |

## Phase 2 (in progress)

| Area | Status |
|---|---|
| Maintenance log for the shop manager (`shop` role): log work per truck with mileage, parts, cost, photos; close inspection repairs; next-due mileage/date; edit history; void instead of delete; works offline | done |
| Fleet management (lease details, statuses, lease-return prep, trailers as assets) | waiting on scope answers (SPEC §9) |
| Batch PDF export: tick inspections, get one PDF each (zip, or share as separate files) | done |
| Maintenance log: several types of work on one entry (multi-select, next-due per type) | done |
| Mark damage repaired (photo of the fix required; Log fix or supervisor; drops off the form's grey dots, kept on the truck page) | done |
| Archive or delete inspections (delete = recoverable forever, admin only, reason required); database refuses to erase inspections | done |
| Repairs board: every open repair across the fleet, by truck or oldest first, with Log fix / Resolve | done |
| Registration expiration: supervisors update it from the form, sign-off or truck page; full history; PDFs keep the date on file | done |
| CSV export: inspections, repairs, maintenance log, trucks, with truck/date filters | done |
| Checklist editor | not started |

## Layout

```
src/                 Fastify API (TypeScript, run directly by Node 24, no build step)
  routes/            auth, vehicles, photos, inspections, admin
  pdf.ts             paper-form HTML template -> PDF via headless Chromium
  storage.ts         photo/signature storage (local disk today; S3/Azure later behind the same interface)
public/              the web app (plain HTML/CSS/JS modules, no framework), service worker, diagrams
db/migrations/       numbered SQL migrations, applied automatically on start
seed/vehicles.csv    trucks added on start if missing (never overwrites edits made in Admin)
scripts/             backup.sh (nightly, run by the backup container), restore.sh
test/                API tests against a real Postgres
prototype/, reference/   the approved claude.ai prototype and the original paper forms
```

## Run it on the server

See [docs/DEPLOY.md](docs/DEPLOY.md). Short version:

```bash
cp .env.example .env    # then edit passwords, admin email, site address
docker compose up -d --build
```

## Develop locally (no Docker)

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
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gc_test npm test   # wipes that database
```

Changes under `public/` need a server restart so the service worker picks up the new version.
