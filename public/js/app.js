// Boot, routing and the "saved on phone" status bar.
import { api, onSignedOut } from "./api.js";
import { allDrafts, flush, onDraftsChange, onSent } from "./drafts.js";
import { loadBranding } from "./brand.js";
import { atLeast, homeHeader, state } from "./ui.js";
import { $, esc, modal, toast } from "./util.js";
import * as admin from "./views/admin.js";
import * as detail from "./views/detail.js";
import * as form from "./views/form.js";
import * as home from "./views/home.js";
import * as signin from "./views/signin.js";
import * as truck from "./views/truck.js";

const routes = [
  { re: /^#?\/?$/, view: home },
  { re: /^#\/truck\/(\d+)$/, view: truck },
  { re: /^#\/inspect\/(\d+)$/, view: form },
  { re: /^#\/inspection\/([0-9a-f-]{36})$/i, view: detail },
  { re: /^#\/admin(?:\/(users|trucks|branding))?(?:\?edit=(\d+))?$/, view: admin, role: "admin" },
];

let current = null;

async function route() {
  const nav = ++state.nav;
  if (current?.leave) {
    try { await current.leave(); } catch (e) { console.error(e); }
  }
  current = null;
  document.body.classList.remove("has-bar");
  window.scrollTo(0, 0);
  const app = $("#app");
  if (!state.user) {
    current = signin;
    return signin.render(app, { onSignedIn });
  }
  const hash = location.hash || "#/";
  for (const r of routes) {
    const m = hash.match(r.re);
    if (!m) continue;
    if (r.role && !atLeast(r.role)) break;
    current = r.view;
    try {
      await r.view.render(app, ...m.slice(1));
    } catch (e) {
      console.error(e);
      if (nav === state.nav) app.innerHTML = `<div class="banner err">${esc(e.message || e)}</div>`;
    }
    return;
  }
  location.replace("#/");
}

function onSignedIn(user) {
  state.user = user;
  try { localStorage.setItem("gc-user", JSON.stringify(user)); } catch { /* private mode */ }
  flush();
  route();
}

export async function signOut() {
  const queued = (await allDrafts()).filter((d) => d.status === "queued");
  if (queued.length) {
    toast("Wait until your saved inspections finish uploading before signing out.", 4000);
    return;
  }
  try { await api("/auth/logout", { method: "POST" }); } catch { /* offline: still clear locally */ }
  try { await caches.delete("gc-runtime"); } catch { /* no cache API */ }
  try { localStorage.removeItem("gc-user"); } catch { /* ignore */ }
  state.user = null;
  location.hash = "#/";
  route();
}

export function openMenu() {
  const u = state.user;
  const m = modal(`<h3>${esc(u.name)}</h3><p class="muted small" style="margin-top:-8px">Signed in as ${esc(u.role)}</p>
    <div style="display:grid;gap:10px">
      ${atLeast("admin") ? `<a class="secondary" href="#/admin/users" data-close>Admin: users, trucks &amp; branding</a>` : ""}
      <button class="secondary danger" id="mSignOut">Sign out</button>
      <button class="secondary" data-close>Close</button>
    </div>`);
  m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => m.remove()));
  m.querySelector("#mSignOut").onclick = () => { m.remove(); signOut(); };
}

async function updateNetbar() {
  const bar = $("#netbar");
  const queued = (await allDrafts().catch(() => [])).filter((d) => d.status === "queued");
  if (queued.length && state.user) {
    const n = queued.length === 1 ? "1 inspection" : `${queued.length} inspections`;
    bar.innerHTML = `<div class="in"><span>${n} saved on phone, not yet uploaded</span><button id="retryNow">Retry now</button></div>`;
    bar.hidden = false;
    $("#retryNow").onclick = async () => {
      $("#retryNow").innerHTML = `<span class="spinner"></span>`;
      await flush();
      updateNetbar();
    };
  } else if (!navigator.onLine) {
    bar.innerHTML = `<div class="in"><span>No signal. Your work is saved on this phone.</span></div>`;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
}

async function boot() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker", e));
  }
  const branding = loadBranding();
  homeHeader();
  try {
    [state.user] = await Promise.all([api("/me"), branding]);
    localStorage.setItem("gc-user", JSON.stringify(state.user));
  } catch (e) {
    await branding;
    if (e.status === 401) {
      state.user = null;
      try { localStorage.removeItem("gc-user"); } catch { /* ignore */ }
    } else {
      // No signal: trust the last known sign-in so drafts can still be worked on.
      try { state.user = JSON.parse(localStorage.getItem("gc-user") || "null"); } catch { state.user = null; }
    }
  }

  onSignedOut(() => {
    if (!state.user) return;
    state.user = null;
    try { localStorage.removeItem("gc-user"); } catch { /* ignore */ }
    toast("Please sign in again.");
    route();
  });
  onDraftsChange(updateNetbar);
  onSent((d, res) => {
    if (!res.duplicate) toast(`${d.truckCode} inspection uploaded ✓`);
    // Lists drawn before the upload finished are now out of date.
    if (current === home || current === truck) route();
  });
  window.addEventListener("online", updateNetbar);
  window.addEventListener("offline", updateNetbar);
  window.addEventListener("hashchange", route);

  await route();
  updateNetbar();
  if (state.user) flush();
}

boot();
