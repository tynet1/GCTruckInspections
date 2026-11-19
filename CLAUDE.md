# CLAUDE.md — Grounds Control Vehicle Inspections

Read `SPEC.md` first; it is the source of truth. Then:

- `prototype/index.html` is the approved claude.ai prototype. The production UI in `public/` reuses its look
  (green header, big OK/Repair buttons, tap-to-pin diagram, sticky save bar, finger signature) and behavior.
- `db/migrations/001_init.sql` is the original handoff schema. Change the schema only by adding numbered
  migrations (`003_...sql`); never edit one that has shipped. Migrations run automatically on app start.
- `reference/` holds the original paper forms (layout for the PDF; header data for `seed/vehicles.csv`).
  `seed/DATA-ISSUES.md` lists vehicle data still to confirm.

## Stack and layout

- Node 24 runs the TypeScript in `src/` directly (type stripping), so no build step. Erasable syntax only:
  no enums, namespaces or constructor parameter properties; use `import type` for types; import with `.ts`.
- Fastify API under `/api` (`src/routes/*`); plain SQL via `pg` (`src/db.ts`); no ORM.
- Frontend: plain ES modules in `public/js` (no framework, no bundler). `public/sw.js` lists the app-shell
  files; add new JS/diagram files to `SHELL_FILES` there.
- Photos/signatures go through `src/storage.ts` (local disk at `UPLOAD_DIR`); keep it behind that interface.
- PDF: `src/pdf.ts` builds the paper-form HTML and prints it with Playwright Chromium.

## Commands

```bash
npm run dev          # local server on :3000 using .env.local
npm run typecheck
TEST_DATABASE_URL=postgres://... npm test   # wipes that database
npm run user -- add --name "X" --role crew --pin 1234
```

## Working rules

- **Never lose data.** Tyler's top rule: prevent data loss at all costs. Read SPEC §4a before changing anything that stores,
  moves or deletes data. Writes are atomic, migrations are additive, and the app never hard-deletes except through the
  trash (migration 020, `src/routes/trash.ts`): Delete puts a record in the trash, and only an admin's Delete forever,
  7+ days later, erases it (in one transaction started by `gc_begin_purge`, logged in `purge_log`). A new kind of record
  that should be deletable gets a trash kind, a purger and a live view/filter there; a new guard function must let
  `gc_purging()` through.
- Phone-first. Test every screen at 390×844 (iPhone) and 820×1180 (iPad), in light and dark mode. Touch targets at least
  44px. Numeric keypad for mileage. Colors come from the CSS variables in `public/css/app.css` (dark ones under
  `:root[data-theme="dark"]`, set by `public/js/theme.js`); don't hard-code a background or text color.
- Expect bad cell signal. Drafts live on the device, uploads retry, and submits are idempotent via `client_id`.
- Submitted inspections are read-only (enforced by database triggers); corrections go in the supervisor note.
  Archive/delete lives in `inspection_states` (migration 005). Anything that means "counts for the
  truck" (open repairs, damage on file, last inspection, mileage, lists) reads `live_inspections`, not `inspections`; a
  migration that adds an inspections column must recreate that view if it's needed there. Same for `live_incidents`,
  `live_yard_inspections` and `live_equipment_checks` (020); other records in the trash are filtered by the `trash` table.
- Every state-changing `/api` call needs the `x-gc-app: 1` header (CSRF guard); `public/js/api.js` adds it.
- Everything runs with `docker compose up -d` on Ubuntu. Secrets go in `.env` (never committed); ship a `.env.example`.
  Local dev settings go in `.env.local` (also gitignored), so they never collide with the server's `.env`.
- It runs on a DigitalOcean droplet that Tyler set up and updates himself (since 2026-11-12); Tyler's Windows PC no longer
  hosts it, though an old copy (`gc-inspections`) still starts whenever Docker Desktop starts there. The droplet holds the
  real data: never test against it. Test locally (a throwaway Postgres for `npm test`, or a separate `COMPOSE_PROJECT_NAME`
  such as `gc-test` on port 8080). Claude reaches it from Tyler's PC with its own SSH key (alias `gc-droplet`, app in `/opt/gctruckinspections`); deploy
  with `docs/DEPLOY.md` §6 (labeled backup first, rebuild under `nohup`, then compare the data before and after).
- Phase 1 (MVP) is built, plus trailer types and branding. Phase 2: the maintenance log is built (`src/routes/service.ts`,
  `public/js/svc.js`, `views/service-*.js`), and so is batch PDF export (`views/export.js`, `public/js/zip.js`), and
  everything since (see SPEC §9: repair tickets, checklist editor, yard walks, equipment, fleet status/reminders,
  incident reports: `src/routes/incidents.ts`, `src/incident-pdf.ts`, `public/js/incq.js`, `views/incident*.js`).
  Phase 3 (code review, performance, burn-in, data-loss review) was done 2026-11-18: `docs/PHASE3-REVIEW.md`. Rerun
  `scripts/burnin.ts` after any change to how records, photos or the outboxes are saved.
- Ask Tyler before choosing a remote-access method other than Cloudflare Tunnel, or before adding paid services.
