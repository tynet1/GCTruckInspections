# Deploying

Everything runs from `docker compose`: Postgres 16, the app (API + web app + Chromium for PDFs), Caddy in front,
a nightly backup job, and optionally a Cloudflare Tunnel so phones on cellular can reach it.

**Today it runs on a DigitalOcean droplet** (Ubuntu, set up by Tyler on 2026-11-12), following sections 1–6. Before that it
ran on Tyler's Windows PC under Docker Desktop for a day ([Windows PC notes](#windows-pc-docker-desktop) below). The compose
file is the same for both. On the droplet, use a domain in `SITE_ADDRESS` so Caddy serves HTTPS, and copy `backups/` off
the droplet regularly.

## 1. Prepare the VM

Ubuntu Server 24.04, 2 vCPU / 4 GB RAM / 40 GB disk is plenty for the pilot. Install Docker Engine and the compose plugin
(official instructions: https://docs.docker.com/engine/install/ubuntu/), then let your user run it:

```bash
sudo usermod -aG docker $USER   # log out and back in afterwards
```

## 2. Get the code and configure it

```bash
git clone https://github.com/tynet1/GCTruckInspections.git
cd GCTruckInspections
cp .env.example .env
nano .env
```

In `.env` set at least:

- `POSTGRES_PASSWORD`: long random string (`openssl rand -base64 24`)
- `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (10+ characters): the first admin account, created on first start
- `SITE_ADDRESS`: leave `:80` when using Cloudflare Tunnel or for a quick LAN test
- `BACKUP_DIR`: a folder on a **different disk or a mounted NAS share** (see section 5)

## 3. Start it

```bash
docker compose up -d --build
docker compose ps                 # all services "running", app "healthy" after ~30s
docker compose logs -f app        # migrations, "created admin account", "added 38 truck(s)" (plus AZ018 from the migrations)
```

Open `http://<vm-ip>/` from a browser on the same network and sign in with the admin email and password.
Then go to **Menu → Admin** and:

1. Add crew users (name + 4–6 digit PIN) and supervisors (email + password).
2. Work through [`seed/DATA-ISSUES.md`](../seed/DATA-ISSUES.md) and fix trucks under **Admin → Trucks**.

Users can also be added from the command line:

```bash
docker compose exec app node src/cli/user.ts add --name "Jane Doe" --role crew --pin 4821
docker compose exec app node src/cli/user.ts list
```

## 4. Make it reachable from phones: Cloudflare Tunnel

Phones on cellular can't reach a VM on an office or home network. A Cloudflare Tunnel gives it a real HTTPS
address without opening any ports. You need a domain whose DNS is on Cloudflare (free plan is fine).

1. In the Cloudflare dashboard go to **Zero Trust → Networks → Tunnels → Create a tunnel**, type **Cloudflared**,
   name it `gc-inspections`.
2. On the install screen, copy the token (the long string after `--token`) into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. Add a **public hostname**, e.g. `inspect.yourdomain.com`, service type **HTTP**, URL **`caddy:80`**.
4. Start the tunnel:

   ```bash
   docker compose --profile tunnel up -d
   ```

5. Open `https://inspect.yourdomain.com` on a phone. In Safari use **Share → Add to Home Screen** so crews get an
   app icon. The offline features (service worker) need HTTPS, so test them through the tunnel, not by IP.

Optional later: put **Cloudflare Access** in front of the hostname to require a company email before the sign-in
page even loads.

## 5. Backups

The `backup` service runs every night after `BACKUP_HOUR` (default 2am, local `TZ`) and writes to `BACKUP_DIR`:

- `db_YYYY-MM-DD_HHMMSS.dump`: full database (`pg_dump` custom format)
- `uploads_YYYY-MM-DD_HHMMSS.tar.gz`: all photos, signatures and uploaded diagrams

Files older than `BACKUP_KEEP_DAYS` (default 30) are deleted, but only after a new backup succeeded. That is also how
long a record deleted forever in Admin → Trash can still be found: restoring a backup from before it was deleted brings
it back (with everything else in that backup), and after `BACKUP_KEEP_DAYS` it's gone from the backups too. Point `BACKUP_DIR`
at a second disk or a mounted NAS share; a backup on the same disk as the VM doesn't survive losing that disk.
Each file is written under a temporary name and renamed when complete, an existing backup is never overwritten, and
only one backup runs at a time, so a file with a final name is always a whole backup.

Every run, good or failed, is recorded in the database (`backup_runs`), and **Admin → About** shows the last one and
whether it worked, in red when the last good backup is more than 2 days old. Recording never makes a backup fail; if
the database is down, the run is only in `docker compose logs backup`.

The app also backs up by itself **before it changes the database during an update** (section 6), into the same
folder: `db_<stamp>_before-migrate-NNN.dump` and `uploads_<stamp>_before-migrate-NNN.tar.gz`, pruned with the others.
For that, `BACKUP_DIR` is mounted into the app container too; if the app's user can't write to it, the app container
makes that user (uid 1000) the folder's owner when it starts. The backup container still writes there as before.

Take one right now and check it:

```bash
docker compose exec backup /bin/sh /backup.sh
ls -lh backups/        # or your BACKUP_DIR
```

### Restore

```bash
sh scripts/restore.sh backups/db_2026-11-11_020012.dump backups/uploads_2026-11-11_020012.tar.gz
```

It asks you to type `RESTORE`, then:

1. saves the current data as `db_<now>_before-restore.dump` / `uploads_<now>_before-restore.tar.gz`;
2. stops the app, replaces the database and photos, and starts the app again.

Sign in and open a few inspections and their PDFs to confirm. If it was the wrong backup, restore the two
`_before-restore` files the same way to put things back exactly as they were.

To practice a restore without touching the real data, run a second copy of the stack under another name
(it gets its own database, photos and ports), restore into that, then remove it:

```bash
COMPOSE_PROJECT_NAME=gc-test HTTP_PORT=8080 HTTPS_PORT=8443 BACKUP_DIR=./backups-test docker compose up -d --build
COMPOSE_PROJECT_NAME=gc-test BACKUP_DIR=./backups-test sh scripts/restore.sh backups/db_....dump backups/uploads_....tar.gz
COMPOSE_PROJECT_NAME=gc-test BACKUP_DIR=./backups-test docker compose down -v   # -v deletes only gc-test's volumes
```

## 6. Updating

Take a labeled backup first, then pull and rebuild. On the droplet the app is in `/opt/gctruckinspections`.
(Admin → About shows these same steps; keep the two alike, `UPDATE_STEPS` in `src/routes/about.ts`.)

```bash
docker compose exec -T backup /bin/sh /backup.sh before-update
git pull --ff-only
nohup sh -c 'docker compose up -d --build app > ~/app-update.log 2>&1; echo EXIT=$? >> ~/app-update.log' &
# When ~/app-update.log ends with EXIT=0, restart the backup job so it runs the new backup.sh:
docker compose up -d --no-deps --force-recreate backup
```

The rebuild takes a few minutes. Running it under `nohup` means a dropped SSH connection can't cancel it halfway;
`tail ~/app-update.log` shows `EXIT=0` when it's done, and `docker compose ps` shows the app `healthy` about 30
seconds later. Until the new container starts, the old one keeps serving. Database migrations run automatically when
the app starts (`docker compose logs app | grep migration`). Phones pick up the new version the next time the app is
opened (the service worker refreshes when the files change). The backup job runs `scripts/backup.sh` from the repo
folder, but keeps the version it started with until it's recreated, hence the last line (recreating it mid-backup is
safe: an unfinished backup is never mistaken for a whole one).

**The backup before migrations.** When an update brings database changes, the new app backs up the database and photos
first, as `db_<stamp>_before-migrate-NNN.dump` + `uploads_<stamp>_before-migrate-NNN.tar.gz` in `BACKUP_DIR` (`docker
compose logs app | grep -i backup`). With many photos this takes a few minutes before the app answers. **If that backup
fails, nothing in the database is changed**: the log shows `PRE-MIGRATION BACKUP FAILED` with the reason (usually a full
disk or a backup folder the app can't write to), the app doesn't serve, and it tries again by itself (after 30 seconds,
then less and less often, up to every 15 minutes). Fix the cause and it carries on, or `docker compose restart app` to
try at once. Only in an emergency, to update with no restore point: `PRE_MIGRATE_BACKUP=off` in `.env`, then
`docker compose up -d app`, and remove that line afterwards.

**Going back.** To undo an update that changed the database: check out the previous version (`git checkout <previous
commit>`), rebuild (`docker compose up -d --build app`), then restore that update's `before-migrate` pair with
`scripts/restore.sh` (section 5). Restoring it alone, with the new code still in place, only migrates it again.

**Knowing about updates.** Admin → About shows the running version (`version` in `package.json`). If `UPDATE_CHECK_REPO`
in `.env` names a GitHub repository (`owner/name`) and an admin turns the check on there, the server asks GitHub for
that repository's latest release once a day and About says when a newer version is out, with its release notes. The
request carries nothing about your users or records. The app never installs an update itself, and has no access to
Docker or the host: that's deliberate (SPEC §9 item 8).

The droplet's firewall (UFW) limits SSH: 6 or more new connections from one address within 30 seconds gets that
address refused for a while, so don't script rapid back-to-back `ssh` calls.

## Firewall (DigitalOcean Cloud Firewall)

The site is reached through Cloudflare, but the droplet's own address (143.198.143.2) also answers on 80 and 443 to
anyone, and UFW can't close that: Docker's published ports go around UFW. A DigitalOcean Cloud Firewall (free) sits in
front of the droplet and can. Set it up in the DigitalOcean control panel:

1. **Networking → Firewalls → Create Firewall.** Name it `gc-inspections`.
2. **Inbound rules.** Delete the default rule, then add:
   - **SSH**, TCP 22. Sources: the office's public IP (from the office, search "what is my IP"). Add your home IP too if
     you work from there. This PC's deploys come from the office address.
   - **HTTP**, TCP 80, and **HTTPS**, TCP 443. Sources: Cloudflare's ranges, pasted one per line from
     cloudflare.com/ips (15 IPv4 and 7 IPv6 as of 2026-11-17; the same list is in `src/auth.ts`). Port 80 has to stay
     open to Cloudflare: Caddy renews its certificate through it.
3. **Outbound rules:** leave the defaults (all allowed): the droplet needs them for updates, GitHub and Docker images.
4. **Apply to Droplets:** pick the droplet, then **Create Firewall**.
5. **Check it:** the site still opens at https://app.tylerlongshore.com; `ssh` works from the office; from a phone on
   cell data, `http://143.198.143.2` now times out instead of answering.

If you ever lock yourself out of SSH, the droplet's **Access → Recovery Console** in the control panel still works, or
edit the firewall's SSH rule to add your current address. Cloudflare rarely changes its ranges, but check
cloudflare.com/ips once a year and update both the firewall and `src/auth.ts` if it has.

## Windows PC (Docker Desktop)

No longer the host (the droplet is, since 2026-11-12). The old copy's containers are gone from the PC (checked
2026-11-17), so starting Docker Desktop no longer starts it; its data volumes (`gc-inspections_*`) are still there.
How it was set up on Tyler's PC (2026-11-11):

- Needs WSL 2 (`wsl --install --no-distribution` in an admin PowerShell, then restart) and Docker Desktop.
- The repo is at `C:\Code\GCTruckInspections`; `.env` there holds the database password and the first admin's
  sign-in. Start or update the stack from that folder with `docker compose up -d --build`.
- Phones on the same network open `http://<PC's IP>` (currently `192.168.30.124`; the address can change unless
  IT reserves it). Docker Desktop added an inbound Windows Firewall rule, "Docker Desktop Backend"; if a phone can't
  connect but `http://localhost` works on the PC, check that rule and whether the phone's Wi-Fi can reach the PC's network.
- Plain `http://` by IP works for everything except the offline app shell and "Share as separate PDFs", which need
  HTTPS (the Cloudflare Tunnel). Drafts still save on the phone over plain http.
- It's only reachable while the PC is on and awake, and Docker Desktop is running. **Turn on Docker Desktop → Settings →
  General → "Start Docker Desktop when you sign in to your computer"**, and check it's not switched off under Windows
  Settings → Apps → Startup. (On 2026-11-11 Windows restarted the PC and Docker didn't come back, so the app was down
  until the next morning.) Set Windows not to sleep while plugged in. Once Docker is running, the containers restart
  on their own (`restart: unless-stopped`), and the backup waits for the database before its first try.
- Run the scripts from **Git Bash** (`sh scripts/restore.sh ...`); they handle Git Bash's path rewriting.
- Backups land in `C:\Code\GCTruckInspections\backups` (same disk as the data). Copy that folder somewhere else
  regularly, e.g. a network share, until the app moves to a server with a proper second backup location.

## Troubleshooting

| Problem | Check |
|---|---|
| App container restarting | `docker compose logs app`; usually a wrong `POSTGRES_PASSWORD` after the database was first created with a different one |
| App stays "starting"/"unhealthy" after an update, `PRE-MIGRATION BACKUP FAILED` in the logs | The backup before the database changes failed, so nothing was changed. The log line says why: free disk space (`df -h`), the backup folder (`BACKUP_DIR`) missing or not writable. Fix it and the app carries on by itself, or `docker compose restart app`. See section 6 |
| Admin → About says the last good backup is old | `docker compose logs backup`; take one by hand (section 5). If the backup files are new but About isn't, the backup container may still run an old `backup.sh`: `docker compose up -d --no-deps --force-recreate backup` |
| "No admin account exists" in the logs | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`, then `docker compose up -d` |
| PDF export fails | `docker compose logs app` around the time of the click; Chromium needs ~300 MB RAM free |
| Phone says "Saved on phone, not yet uploaded" for a long time | Is the tunnel up? `docker compose --profile tunnel ps`; can the phone open the site at all? |
| Someone is locked out | Admin → Users → set a new PIN or password (unlocks immediately). Otherwise the lock lasts 15 minutes, doubling each time it happens again that day, up to 4 hours |
| "Too many wrong sign-ins from this network" | 20 wrong tries in an hour from one address (e.g. the yard Wi-Fi). Wait it out, or sign in on cell data; `docker compose logs app | grep sign-in` shows the address |
| Photos stay "waiting on this phone" | The daily photo limit (1 GB a person) or a nearly full disk (`df -h /`; uploads pause under 2 GB free). The phones keep the photos and retry |
