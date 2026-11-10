# Grounds Control Vehicle Inspections: handoff package

What's here:

| Path | What |
|---|---|
| `SPEC.md` | Full build spec: roles, stack, screens, rules, PDF, API, phases, acceptance tests |
| `CLAUDE.md` | Instructions Claude Code picks up automatically |
| `db/schema.sql` | PostgreSQL 16 schema with seed checklist and AZ018 (tested) |
| `prototype/` | The working claude.ai prototype (single HTML file) and diagram images |
| `reference/` | Original paper Truck Inspection Sheet (AZ018) for the PDF layout |
| `seed/` | Put the master vehicle list here as `vehicles.csv` when you have it |

## Using it with Claude Code

```bash
mkdir gc-inspections && cd gc-inspections
unzip ~/Downloads/gc-inspections-handoff.zip
git init && git add . && git commit -m "Handoff package"
claude
```

First prompt to use:

> Read CLAUDE.md and SPEC.md. Propose the project layout and a short plan for the phase 1 MVP, then build it. Start with docker compose (Postgres + app + Caddy) so I can run it on my Ubuntu VM.

Before the pilot: drop the other 9 paper forms into `reference/`, and the vehicle list into `seed/vehicles.csv` (truck_code, unit, vin, plate, year, make, model, registration_expires, pulls_trailer).
