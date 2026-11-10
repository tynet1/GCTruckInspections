// Truck page: details, start/resume an inspection, open repairs, history.
import { api } from "../api.js";
import { deleteDraft, flush, getDraft, sendQueued } from "../drafts.js";
import { atLeast, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, confirmBox, esc, fmtDate, fmtNum, toast, vehicleInfo } from "../util.js";
import { inspectionRow, resolveRepair, SECTION_TITLES } from "./common.js";

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Truck", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data, draft;
  try {
    [data, draft] = await Promise.all([api(`/vehicles/${id}`), getDraft(id)]);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const { vehicle: v, openRepairs, history } = data;
  setHeader({
    title: v.truck_code, sub: vehicleInfo(v), back: "#/",
    actions: atLeast("admin") ? [{ label: "Edit", href: `#/admin/trucks?edit=${v.id}` }] : [],
  });

  let h = `<div class="card" style="margin-top:14px"><div class="hdr">
      <b>Truck ID</b><span>${esc(v.truck_code)}</span><b>Unit</b><span>${esc(v.unit || "—")}</span>
      <b>VIN</b><span style="word-break:break-all">${esc(v.vin || "—")}</span><b>Plate</b><span>${esc(v.plate || "—")}</span>
      <b>Info</b><span>${esc(vehicleInfo(v) || "—")}</span>
      <b>Reg exp.</b><span>${v.registration_expires ? fmtDate(v.registration_expires) : "—"} ${v.registration_expired ? '<span class="pill bad">Expired</span>' : ""}</span>
      <b>Last miles</b><span>${v.last_mileage != null ? fmtNum(v.last_mileage) : "—"}</span>
      <b>Trailer</b><span>${v.pulls_trailer ? "Usually pulls one" : "Usually none"}</span>
    </div></div>`;

  if (draft?.status === "queued") {
    h += `<div class="banner info"><b>Saved on phone, not yet uploaded.</b><br>${esc(draft.lastError || "Uploading…")}.
      It will send by itself when signal returns.<div style="margin-top:8px"><button class="secondary" id="sendNow">Try upload now</button></div></div>`;
  } else if (draft) {
    if (draft.lastError) h += `<div class="banner err"><b>The server didn't accept this inspection:</b> ${esc(draft.lastError)} Open the draft to fix it.</div>`;
    h += `<a class="primary wide" style="margin:6px 0 4px" href="#/inspect/${v.id}">Resume draft inspection</a>
      <button class="link danger" id="discard" style="width:100%">Discard draft</button>`;
  } else {
    h += `<a class="primary wide" style="margin:6px 0 4px" href="#/inspect/${v.id}">Start inspection</a>`;
  }

  const canResolve = atLeast("supervisor");
  h += `<h2>Open repairs (${openRepairs.length})</h2><div class="card">${openRepairs.length
    ? `<ul class="repairlist">${openRepairs.map((r) => `<li><div class="spread"><div><b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>
        ${r.note ? `<div>${esc(r.note)}</div>` : ""}<a class="small" href="#/inspection/${esc(r.inspection_id)}">From ${fmtDate(r.inspection_date)} inspection</a></div>
        ${canResolve ? `<button class="secondary" data-resolve="${r.id}" data-label="${esc(r.label)}">Resolve</button>` : ""}</div></li>`).join("")}</ul>`
    : `<span class="muted">No open repairs.</span>`}</div>`;
  h += `<h2>History</h2><div class="card list">${history.length
    ? history.map((i) => inspectionRow(i, { showTruck: false })).join("")
    : `<div class="empty">No inspections yet.</div>`}</div>`;
  app.innerHTML = h;

  const sn = $("#sendNow");
  if (sn) sn.onclick = async () => {
    sn.disabled = true;
    sn.innerHTML = `<span class="spinner"></span> Sending…`;
    const r = await sendQueued(v.id);
    if (r.state === "sent") { toast("Inspection uploaded ✓"); location.hash = `#/inspection/${r.res.id}`; return; }
    if (r.state === "waiting") toast("Still no connection to the server. It will keep trying.");
    flush();
    if (!stale(nav)) render(app, id);
  };
  const dc = $("#discard");
  if (dc) dc.onclick = async () => {
    if (!(await confirmBox(`Discard the draft inspection for ${v.truck_code}? This can't be undone.`, "Discard", { danger: true }))) return;
    await deleteDraft(draft);
    toast("Draft discarded");
    render(app, id);
  };
  app.querySelectorAll("[data-resolve]").forEach((b) => (b.onclick = async () => {
    if (await resolveRepair(b.dataset.resolve, b.dataset.label)) render(app, id);
  }));
}
