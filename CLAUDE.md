# CLAUDE.md — Grounds Control Vehicle Inspections

Read `SPEC.md` first; it is the source of truth. Then:

- `prototype/index.html` is a working single-file prototype. Its UI and flow have been approved: reuse the look (green header, big OK/Repair buttons, tap-to-pin diagram, sticky save bar, finger signature) and behavior. Its storage calls (`claude.use("db")`, `claude.use("assets")`) are specific to the claude.ai prototype host. Replace them with the real API; don't try to make them work.
- `db/schema.sql` loads cleanly on PostgreSQL 16 and seeds the checklist plus truck AZ018. Change it through numbered migrations once the project is set up.
- `prototype/diagrams/` holds the truck and trailer diagrams; `reference/` holds the original paper form for the PDF layout.

Working rules:
- Phone-first. Test every screen at 390×844 (iPhone) and 820×1180 (iPad). Touch targets at least 44px. Numeric keypad for mileage.
- Expect bad cell signal. Drafts live on the device, uploads retry, and submits are idempotent via `client_id`.
- Everything runs with `docker compose up -d` on Ubuntu. Secrets go in `.env` (never committed); ship a `.env.example`.
- Build the MVP (SPEC §9 phase 1) first and stop for review before phase 2.
- Ask Tyler before choosing a remote-access method other than Cloudflare Tunnel, or before adding paid services.
