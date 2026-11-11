// Truck page: details, start/resume an inspection, open repairs, history.
import { api } from "../api.js";
import { deleteDraft, flush, getDraft, sendQueued } from "../drafts.js";
import { flushSvc, getSvcDraft, sendSvc } from "../svc.js";
import { atLeast, can, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, confirmBox, esc, fmtDate, fmtNum, toast, vehicleInfo } from "../util.js";
import { inspectionRow, repairButtons, resolveRepair, SECTION_TITLES, serviceRow } from "./common.js";

let showAllService = false;
let lastTruck = null;

export async function render(app, id) {
  const nav = state.nav;
  if (id !== lastTruck) { showAllService = false; lastTruck = id; }
  setHeader({ title: "Truck", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let data, draft, svc, svcDraft;
  try {
    [data, draft, svc, svcDraft] = await Promise.all([
      api(`/vehicles/${id}`),
      getDraft(id),
      can.seeService() ? api(`/vehicles/${id}/service`).catch((e) => e) : null,
      getSvcDraft(`new-${id}`).catch(() => null),
    ]);
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
      <b>Trailer</b><span>${v.pulls_trailer ? esc(v.trailer_type || "Yes") : "None"}</span>
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

  const who = { canLog: can.logService(), canResolve: atLeast("supervisor") };
  h += `<h2>Open repairs (${openRepairs.length})</h2><div class="card">${openRepairs.length
    ? `<ul class="repairlist">${openRepairs.map((r) => `<li><div class="spread"><div><b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>
        ${r.note ? `<div>${esc(r.note)}</div>` : ""}<a class="small" href="#/inspection/${esc(r.inspection_id)}">From ${fmtDate(r.inspection_date)} inspection</a></div>
        ${repairButtons(r, v.id, who)}</div></li>`).join("")}</ul>`
    : `<span class="muted">No open repairs.</span>`}</div>`;
  if (svc) h += serviceSection(v, svc, svcDraft);
  h += `<h2>Inspection history</h2><div class="card list">${history.length
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
  const ma = $("#svcMore");
  if (ma) ma.onclick = () => { showAllService = true; render(app, id); };
  const ss = $("#svcSend");
  if (ss) ss.onclick = async () => {
    ss.disabled = true;
    ss.innerHTML = `<span class="spinner"></span> Sending…`;
    const r = await sendSvc(`new-${v.id}`);
    if (r.state === "sent") { toast("Maintenance uploaded ✓"); location.hash = `#/service/${r.res.id}`; return; }
    if (r.state === "waiting") toast("Still no connection to the server. It will keep trying.");
    flushSvc();
    if (!stale(nav)) render(app, id);
  };
}

function serviceSection(v, svc, svcDraft) {
  let h = `<h2>Maintenance</h2>`;
  if (svcDraft?.status === "queued") {
    h += `<div class="banner info"><b>Maintenance entry saved on phone, not yet uploaded.</b><br>${esc(svcDraft.lastError || "Uploading…")}.
      It will send by itself when signal returns.<div style="margin-top:8px"><button class="secondary" id="svcSend">Try upload now</button></div></div>`;
  } else if (can.logService()) {
    if (svcDraft?.lastError) h += `<div class="banner err"><b>The server didn't accept this entry:</b> ${esc(svcDraft.lastError)} Open the draft to fix it.</div>`;
    h += `<a class="secondary wide" style="margin-bottom:10px" href="#/service/new/${v.id}">${svcDraft ? "Resume maintenance draft" : "+ Log maintenance"}</a>`;
  }
  if (svc instanceof Error) return h + errorHtml(svc);
  if (svc.next_due.length) {
    h += `<div class="card"><div class="small muted" style="font-weight:650;margin-bottom:4px">Next due</div>${svc.next_due.map((nd) => {
      const when = [nd.mileage != null ? `${fmtNum(nd.mileage)} mi` : "", nd.date ? fmtDate(nd.date) : ""].filter(Boolean).join(" or ");
      const cls = nd.state === "due" ? "bad" : nd.state === "soon" ? "warn" : "grey";
      return `<a class="spread" style="padding:8px 0;min-height:44px;text-decoration:none;color:inherit" href="#/service/${nd.entry_id}">
        <span>${esc(nd.category_label)}</span><span class="pill ${cls}">${nd.state === "due" ? "Due now · " : nd.state === "soon" ? "Soon · " : ""}${esc(when)}</span></a>`;
    }).join("")}${svc.current_mileage != null ? `<div class="small muted">Last recorded mileage ${fmtNum(svc.current_mileage)}</div>` : ""}</div>`;
  }
  const list = showAllService ? svc.entries : svc.entries.slice(0, 8);
  h += `<div class="card list">${list.length ? list.map((s) => serviceRow(s)).join("") : `<div class="empty">No maintenance logged yet.</div>`}
    ${svc.entries.length > list.length ? `<button class="link" id="svcMore" style="width:100%">Show all ${svc.entries.length}</button>` : ""}</div>`;
  return h;
}
