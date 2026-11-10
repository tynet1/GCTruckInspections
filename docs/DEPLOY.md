# Deploying on an Ubuntu Server VM

Everything runs from `docker compose`: Postgres 16, the app (API + web app + Chromium for PDFs), Caddy in front,
a nightly backup job, and optionally a Cloudflare Tunnel so phones on cellular can reach it.

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
docker compose logs -f app        # migrations, "created admin account", "added 38 truck(s)"
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

- `db_YYYY-MM-DD_HHMM.dump`: full database (`pg_dump` custom format)
- `uploads_YYYY-MM-DD_HHMM.tar.gz`: all photos, signatures and uploaded diagrams

Files older than `BACKUP_KEEP_DAYS` (default 30) are deleted. Point `BACKUP_DIR` at a second disk or a mounted
NAS share; a backup on the same disk as the VM doesn't survive losing that disk.

Take one right now and check it:

```bash
docker compose exec backup /bin/sh /backup.sh
ls -lh backups/        # or your BACKUP_DIR
```

### Test a restore (do this once before the pilot)

Best done on a second, throwaway VM set up the same way:

```bash
scripts/restore.sh backups/db_2026-11-10_0200.dump backups/uploads_2026-11-10_0200.tar.gz
```

It asks you to type `RESTORE`, stops the app, replaces the database and photos, and starts the app again.
Sign in and open a few inspections and their PDFs to confirm.

## 6. Updating

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically when the app starts. Phones pick up the new version the next time the
app is opened (the service worker refreshes when the files change).

## Troubleshooting

| Problem | Check |
|---|---|
| App container restarting | `docker compose logs app`; usually a wrong `POSTGRES_PASSWORD` after the database was first created with a different one |
| "No admin account exists" in the logs | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`, then `docker compose up -d` |
| PDF export fails | `docker compose logs app` around the time of the click; Chromium needs ~300 MB RAM free |
| Phone says "Saved on phone, not yet uploaded" for a long time | Is the tunnel up? `docker compose --profile tunnel ps`; can the phone open the site at all? |
| Someone is locked out | Admin → Users → set a new PIN (unlocks immediately), or wait 15 minutes |
