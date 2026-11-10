// Home: pick a truck, plus recent inspections (and sign-offs waiting, for supervisors).
import { api } from "../api.js";
import { openMenu } from "../app.js";
import { allDrafts } from "../drafts.js";
import { atLeast, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, daysAgo, esc, fmtDate, vehicleInfo } from "../util.js";
import { inspectionRow } from "./common.js";

let query = "";

export async function render(app) {
  const nav = state.nav;
  setHeader({ title: "Vehicle Inspections", sub: `Grounds Control fleet · ${state.user.name}`, actions: [{ label: "Menu", onclick: openMenu }] });
  app.innerHTML = `
    <input class="search" id="q" type="search" placeholder="Search truck, plate, VIN…" value="${esc(query)}" autocomplete="off" aria-label="Search trucks">
    <div id="review"></div>
    <h2>Pick a truck</h2><div id="trucks"><div class="empty">Loading trucks…</div></div>
    <h2>Recent inspections</h2><div class="card list" id="recent"><div class="empty">Loading…</div></div>`;

  const [vehicles, recent, drafts, unreviewed] = await Promise.all([
    api("/vehicles").catch((e) => e),
    api("/inspections?limit=15").catch((e) => e),
    allDrafts().catch(() => []),
    atLeast("supervisor") ? api("/inspections?status=submitted&limit=100").catch((e) => e) : null,
  ]);
  if (stale(nav)) return;

  const draftBy = new Map(drafts.map((d) => [d.vehicleId, d]));

  function drawTrucks() {
    const box = $("#trucks");
    if (vehicles instanceof Error) return void (box.innerHTML = errorHtml(vehicles));
    const ql = query.trim().toLowerCase();
    const list = vehicles.filter((v) => !ql || [v.truck_code, vehicleInfo(v), v.plate, v.vin, v.unit].join(" ").toLowerCase().includes(ql));
    if (!vehicles.length) return void (box.innerHTML = `<div class="card empty">No trucks yet.${atLeast("admin") ? ` Add them under <a href="#/admin/trucks">Admin</a>.` : ""}</div>`);
    if (!list.length) return void (box.innerHTML = `<div class="empty">No trucks match “${esc(query)}”.</div>`);
    box.innerHTML = `<div class="grid">${list.map((v) => {
      const d = v.last_inspection_date ? daysAgo(v.last_inspection_date) : null;
      const dr = draftBy.get(v.id);
      const n = Number(v.open_repairs || 0);
      return `<a class="truck" href="#/truck/${v.id}"><span class="id">${esc(v.truck_code)}</span>
        <span class="info">${esc(vehicleInfo(v))}${v.plate ? ` · ${esc(v.plate)}` : ""}</span>
        <span class="row" style="margin-top:4px">
          ${v.last_inspection_date ? `<span class="pill ${d > 35 ? "warn" : "grey"}">Last: ${fmtDate(v.last_inspection_date)}</span>` : `<span class="pill warn">Never inspected</span>`}
          ${n ? `<span class="pill bad">${n} open repair${n > 1 ? "s" : ""}</span>` : ""}
          ${dr ? `<span class="pill ${dr.status === "queued" ? "warn" : ""}">${dr.status === "queued" ? "Waiting to upload" : "Draft"}</span>` : ""}
          ${v.registration_expired ? `<span class="pill bad">Reg expired</span>` : ""}
        </span></a>`;
    }).join("")}</div>`;
  }
  drawTrucks();
  $("#q").oninput = (e) => { query = e.target.value; drawTrucks(); };

  $("#recent").innerHTML = recent instanceof Error
    ? errorHtml(recent)
    : recent.length ? recent.map((i) => inspectionRow(i)).join("") : `<div class="empty">No inspections submitted yet.</div>`;

  if (unreviewed && !(unreviewed instanceof Error) && unreviewed.length) {
    let showAll = false;
    const drawReview = () => {
      const shown = showAll ? unreviewed : unreviewed.slice(0, 4);
      $("#review").innerHTML = `<h2>Waiting for sign-off (${unreviewed.length})</h2>
        <div class="card list">${shown.map((i) => inspectionRow(i)).join("")}
        ${unreviewed.length > shown.length ? `<button class="link" id="moreRev" style="width:100%">Show all ${unreviewed.length}</button>` : ""}</div>`;
      const mr = $("#moreRev");
      if (mr) mr.onclick = () => { showAll = true; drawReview(); };
    };
    drawReview();
  }
}
