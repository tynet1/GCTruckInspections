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

- Phone-first. Test every screen at 390×844 (iPhone) and 820×1180 (iPad). Touch targets at least 44px. Numeric keypad for mileage.
- Expect bad cell signal. Drafts live on the device, uploads retry, and submits are idempotent via `client_id`.
- Submitted inspections are read-only (enforced by database triggers); corrections go in the supervisor note.
- Every state-changing `/api` call needs the `x-gc-app: 1` header (CSRF guard); `public/js/api.js` adds it.
- Everything runs with `docker compose up -d` on Ubuntu. Secrets go in `.env` (never committed); ship a `.env.example`.
  Local dev settings go in `.env.local` (also gitignored), so they never collide with the server's `.env`.
- Phase 1 (MVP) is built; stop for Tyler's review before starting phase 2.
- Ask Tyler before choosing a remote-access method other than Cloudflare Tunnel, or before adding paid services.
