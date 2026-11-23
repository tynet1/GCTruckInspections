// Admin → About & updates: the running version, the database's migration level, the last backup, and the optional
// check for a newer release. Nothing here installs anything: updates are done on the server (docs/DEPLOY.md §6).
import { api } from "../api.js";
import { stale } from "../ui.js";
import { $, esc, fmtDate, toast } from "../util.js";

const KIND = { nightly: "Nightly", manual: "By hand", "pre-migrate": "Before a database update" };

function when(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `${fmtDate(ts)} ${time} (${ago})`;
}

function bytes(n) {
  if (n == null) return "";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[i]}`;
}

const runLabel = (r) => [KIND[r.kind] || r.kind, r.label].filter(Boolean).join(" · ");

function backupCard(b) {
  const last = b.last;
  let warn = "";
  if (!b.last_good_at) {
    warn = `<div class="banner err"><b>No backup is on record yet.</b> The nightly backup records each run here; if the server
      was just set up or updated, check again tomorrow. Until then, check the backup folder on the server.</div>`;
  } else if (b.stale) {
    warn = `<div class="banner err"><b>The last good backup is more than ${b.stale_days} days old</b> (${esc(when(b.last_good_at))}).
      Check the backup job on the server: <code>docker compose logs backup</code>.</div>`;
  }
  if (last && !last.ok) {
    warn += `<div class="banner err"><b>The last backup failed</b>, ${esc(when(last.finished_at))}.${last.error
      ? `<div class="small" style="margin-top:4px;overflow-wrap:anywhere">${esc(last.error.trim())}</div>` : ""}</div>`;
  }
  const lastOk = b.last_ok;
  const files = (r) => [r.db_file && `${r.db_file} (${bytes(r.db_bytes)})`, r.uploads_file && `${r.uploads_file} (${bytes(r.uploads_bytes)})`]
    .filter(Boolean).map(esc).join("<br>");
  return `<h2>Backups</h2><div class="card">
    ${warn}
    <dl class="kv">
      <dt>Last backup</dt><dd>${last ? `${esc(when(last.finished_at))}<br>${last.ok ? `<span class="pill okk">Worked</span>` : `<span class="pill bad">Failed</span>`}
        <span class="small muted">${esc(runLabel(last))}</span>` : `<span class="muted">None recorded</span>`}</dd>
      ${lastOk && lastOk.id !== last?.id ? `<dt>Last good one</dt><dd>${esc(when(lastOk.finished_at))}<br><span class="small muted">${esc(runLabel(lastOk))}</span></dd>` : ""}
      ${lastOk ? `<dt>Files</dt><dd class="small">${files(lastOk)}</dd>` : ""}
      ${b.folder ? `<dt>Backup folder</dt><dd>${b.folder.pairs} complete backup${b.folder.pairs === 1 ? "" : "s"}${b.folder.newest
        ? `<br><span class="small muted">Newest: ${esc(when(b.folder.newest.at))}</span>` : ""}</dd>` : ""}
      <dt>Before updates</dt><dd>${b.pre_migrate ? "The app backs up the database and photos by itself before it changes the database."
        : `<span class="pill warn">Off</span> <span class="small">PRE_MIGRATE_BACKUP=off: database updates run with no backup first.</span>`}</dd>
    </dl>
    ${b.recent.length > 1 ? `<details class="onfile"><summary>Recent runs (${b.recent.length})</summary><ul class="repairlist small">${b.recent.map((r) =>
      `<li>${r.ok ? `<span class="pill okk">Worked</span>` : `<span class="pill bad">Failed</span>`} ${esc(when(r.finished_at))}
        <div class="muted">${esc(runLabel(r))}${r.ok ? ` · ${esc(bytes((r.db_bytes || 0) + (r.uploads_bytes || 0)))}` : ""}</div>
        ${!r.ok && r.error ? `<div style="overflow-wrap:anywhere">${esc(r.error.trim())}</div>` : ""}</li>`).join("")}</ul></details>` : ""}
  </div>`;
}

function stepsHtml(steps) {
  return `<pre class="cmd">${esc((steps || []).join("\n"))}</pre>`;
}

function updatesCard(u, steps) {
  const howTo = `<p class="small muted">Updates are installed on the server by whoever runs it, never from this screen: by design
    the app has no control over the server or Docker. The app backs up the database by itself before it changes it.</p>`;
  if (!u) {
    return `<h2>Updates</h2><div class="card">${howTo}
      <details class="onfile"><summary>How to update</summary>${stepsHtml(steps)}</details></div>`;
  }
  let status = "";
  if (u.state === "available") {
    const l = u.latest;
    status = `<div class="banner okk"><b>Version ${esc(l.version)} is available.</b> This server runs ${esc(u.current)}.</div>
      <div class="row" style="justify-content:space-between;margin:6px 0">
        <span>${[l.name && l.name !== l.tag ? `<b>${esc(l.name)}</b>` : "", l.published_at ? `released ${esc(fmtDate(l.published_at))}` : ""].filter(Boolean).join(" · ")}</span>
        <a class="secondary" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Release page</a></div>
      ${l.notes ? `<details class="onfile" open><summary>Release notes</summary><div class="relnotes">${esc(l.notes)}</div></details>` : ""}
      <div class="subhead">How to update</div>${stepsHtml(steps)}`;
  } else if (u.state === "current") {
    status = `<div class="banner okk">You're up to date: ${esc(u.current)} is the latest release.</div>`;
  } else if (u.state === "failed" || u.state === "unknown") {
    status = `<div class="banner info">Couldn't check for updates. ${esc(u.message || "")}</div>`;
  }
  const checked = u.enabled && u.checked_at ? `<p class="small muted" style="margin:8px 0 0">Last checked ${esc(when(u.checked_at))}; next check after
    ${esc(fmtDate(u.next_check_at))} ${esc(new Date(u.next_check_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}.</p>` : "";
  return `<h2>Updates</h2><div class="card">
    <div class="toggle"><div><b>Check for updates</b><div class="small muted">Once a day the server asks GitHub for the latest release of
      ${esc(u.repo)}. Nothing about you, your users or your records is sent.</div></div>
      <button type="button" class="sw ${u.enabled ? "on" : ""}" id="upd-sw" role="switch" aria-checked="${u.enabled}" aria-label="Check for updates"></button></div>
    ${u.enabled ? `<div style="margin-top:12px">${status}</div>${checked}` : ""}
    ${howTo}
    ${u.state !== "available" ? `<details class="onfile"><summary>How to update</summary>${stepsHtml(steps)}</details>` : ""}
  </div>`;
}

export async function aboutTab(nav) {
  const box = $("#adm");
  const draw = (d) => {
    const db = d.database;
    box.innerHTML = `<h2>This app</h2><div class="card"><dl class="kv">
        <dt>Version</dt><dd><b>${esc(d.version)}</b></dd>
        <dt>Database</dt><dd>${db.latest ? `${esc(db.latest.replace(/\.sql$/, ""))}<br><span class="small muted">${db.count} update${db.count === 1 ? "" : "s"} applied, the last on
          ${esc(fmtDate(db.latest_applied_at))}</span>` : `<span class="muted">No updates applied</span>`}</dd>
      </dl>
      ${db.pending.length ? `<div class="banner err">Database updates not applied yet: ${esc(db.pending.join(", "))}. Restart the app on the server.</div>` : ""}
      ${db.unknown.length ? `<div class="banner info">The database has updates from a newer version of the app (${esc(db.unknown.join(", "))}).
        This version may not run correctly against it.</div>` : ""}
    </div>
    ${backupCard(d.backups)}
    ${updatesCard(d.updates, d.update_steps)}`;

    const sw = $("#upd-sw");
    if (sw) sw.onclick = async () => {
      sw.disabled = true;
      try {
        const next = await api("/admin/update-check", { method: "PUT", body: { enabled: !d.updates.enabled }, timeout: 20000 });
        if (stale(nav)) return;
        toast(next.updates?.enabled ? "Update check on" : "Update check off");
        draw(next);
      } catch (e) {
        sw.disabled = false;
        toast(e.status === 0 ? "No signal, so nothing changed." : e.message, 4000);
      }
    };
  };
  const d = await api("/admin/about", { timeout: 20000 });
  if (stale(nav)) return;
  draw(d);
}
