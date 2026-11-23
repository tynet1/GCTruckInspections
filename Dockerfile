# Grounds Control inspections app: Fastify API + static frontend + Chromium for PDFs.
# Node 24 LTS runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/backups \
    PATH=/usr/lib/postgresql/16/bin:$PATH

WORKDIR /app

# pg_dump, for the backup the app takes before it migrates the database (src/backup.ts). It must be version 16 to dump
# the Postgres 16 server, and Debian bookworm only packages 15, so it comes from the PostgreSQL project's own apt
# repository (apt.postgresql.org), checked against the project's signing key. curl is only needed to fetch that key.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps --only-shell chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY public ./public
COPY db/migrations ./db/migrations
COPY seed ./seed
COPY --chmod=755 scripts/app-entrypoint.sh /usr/local/bin/app-entrypoint

RUN mkdir -p /data/uploads /backups && chown -R node:node /data /backups
USER node

EXPOSE 3000
# The start period covers the backup the app takes before migrating, which can take a few minutes with many photos.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/app-entrypoint"]
CMD ["node", "src/server.ts"]
