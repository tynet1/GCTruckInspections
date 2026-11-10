// Inspection detail: everything submitted, repairs first, supervisor sign-off and PDF export.
import { api } from "../api.js";
import { setupSig } from "../sig.js";
import { atLeast, errorHtml, setHeader, stale, state } from "../ui.js";
import { $, esc, fmtDate, fmtNum, lightbox, toast, vehicleInfo } from "../util.js";
import { resolveRepair, SECTION_TITLES } from "./common.js";

let sigPad = null;

export function leave() {
  sigPad?.destroy();
  sigPad = null;
  const app = $("#app");
  app.onclick = null;
}

export async function render(app, id) {
  const nav = state.nav;
  setHeader({ title: "Inspection", back: "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let i;
  try {
    i = await api(`/inspections/${id}`);
  } catch (e) {
    if (!stale(nav)) app.innerHTML = errorHtml(e);
    return;
  }
  if (stale(nav)) return;
  const v = i.vehicle;
  const isSup = atLeast("supervisor");
  setHeader({ title: `${v.truck_code} · ${fmtDate(i.inspection_date)}`, sub: vehicleInfo(v), back: `#/truck/${v.id}` });

  const marks = new Map(i.damage.map((m) => [m.id, m]));
  const items = new Map(i.items.map((it) => [it.id, it]));
  const tagOf = (p) => {
    if (p.damage_mark_id && marks.get(p.damage_mark_id)) {
      const m = marks.get(p.damage_mark_id);
      return `${m.diagram === "trailer" ? "Trailer damage" : "Damage"} ${m.seq}`;
    }
    if (p.inspection_item_id && items.get(p.inspection_item_id)) return `Repair: ${items.get(p.inspection_item_id).label}`;
    return "";
  };
  const photoUrl = (p) => `/api/photos/${p.id}`;
  const thumbs = (list) => list.length
    ? `<div class="row" style="margin-top:6px">${list.map((p) => `<img src="${photoUrl(p)}" data-lb="${p.id}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:zoom-in">`).join("")}</div>`
    : "";

  const repairs = i.items.filter((it) => it.result === "repair");
  let h = "";
  if (i.mileage_flagged) {
    h += `<div class="banner info"><b>Mileage check:</b> ${fmtNum(i.mileage)} is lower than the previous ${fmtNum(i.previous_mileage)}.
      Check with the inspector; put any correction in the supervisor note.</div>`;
  }
  h += `<div class="card" style="margin-top:14px"><dl class="kv">
    <dt>Truck</dt><dd><b>${esc(v.truck_code)}</b> ${esc(vehicleInfo(v))}${v.plate ? ` · ${esc(v.plate)}` : ""}</dd>
    <dt>Date</dt><dd>${fmtDate(i.inspection_date)}</dd>
    <dt>Inspector</dt><dd>${esc(i.inspector_name)}</dd>
    <dt>Mileage</dt><dd>${fmtNum(i.mileage)}${i.mileage_flagged ? ' <span class="pill warn">Lower than last</span>' : ""}</dd>
    <dt>Oil change due</dt><dd>${i.oil_change_due ? '<span class="pill warn">Yes</span>' : "No"}</dd>
    ${i.trailer ? `<dt>Trailer</dt><dd>${esc(i.trailer.number || "—")} · plate ${esc(i.trailer.plate || "—")}</dd>` : ""}
    <dt>Status</dt><dd>${i.status === "reviewed" ? '<span class="pill okk">Signed off</span>' : '<span class="pill grey">Awaiting sign-off</span>'}</dd>
  </dl>${isSup ? `<a class="secondary" style="width:100%;margin-top:12px" href="/api/inspections/${esc(i.id)}/pdf" download>Export PDF</a>` : ""}</div>`;

  h += `<h2>Repairs needed (${repairs.length})</h2><div class="card">${repairs.length
    ? `<ul class="repairlist">${repairs.map((r) => `<li><div class="spread" style="align-items:flex-start"><div>
        <b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>
        ${r.note ? `<div>${esc(r.note)}</div>` : ""}
        ${r.resolved_at ? `<div class="small" style="color:var(--ok)">✓ Resolved ${fmtDate(r.resolved_at)}${r.resolved_by_name ? ` by ${esc(r.resolved_by_name)}` : ""}: ${esc(r.resolution_note)}</div>` : ""}
        ${thumbs(i.photos.filter((p) => p.inspection_item_id === r.id))}</div>
        ${isSup && !r.resolved_at ? `<button class="secondary" data-resolve="${r.id}" data-label="${esc(r.label)}">Resolve</button>` : ""}</div></li>`).join("")}</ul>`
    : `<span class="muted">Everything marked OK.</span>`}</div>`;

  const dia = (url, list) => `<div class="diagram ro"><img src="${esc(url)}" alt="">${list.map((m) => `<span class="pin" style="left:${m.x * 100}%;top:${m.y * 100}%">${m.seq}</span>`).join("")}</div>
    <ol class="legend">${list.map((m) => `<li value="${m.seq}">${esc(m.note || "(no description)")}${thumbs(i.photos.filter((p) => p.damage_mark_id === m.id))}</li>`).join("")}</ol>`;
  const truckMarks = i.damage.filter((m) => m.diagram === "truck");
  const trailerMarks = i.damage.filter((m) => m.diagram === "trailer");
  if (truckMarks.length && i.truck_diagram_url) h += `<h2>Truck damage</h2><div class="card">${dia(i.truck_diagram_url, truckMarks)}</div>`;
  if (trailerMarks.length && i.trailer_diagram_url) h += `<h2>Trailer damage</h2><div class="card">${dia(i.trailer_diagram_url, trailerMarks)}</div>`;

  if (i.existing_notes || i.new_observations) {
    h += `<h2>Notes</h2><div class="card">
      ${i.existing_notes ? `<div class="small muted">Existing</div><div style="white-space:pre-wrap;margin-bottom:10px">${esc(i.existing_notes)}</div>` : ""}
      ${i.new_observations ? `<div class="small muted">New observations</div><div style="white-space:pre-wrap">${esc(i.new_observations)}</div>` : ""}</div>`;
  }
  if (i.photos.length) {
    h += `<h2>Photos (${i.photos.length})</h2><div class="card"><div class="photos">${i.photos.map((p) => {
      const tag = tagOf(p);
      return `<div class="ph" data-lb="${p.id}" style="cursor:zoom-in"><img src="${photoUrl(p)}" alt="" loading="lazy">
        ${tag ? `<span class="tag">${esc(tag)}</span>` : ""}${p.caption ? `<div class="cap">${esc(p.caption)}</div>` : ""}</div>`;
    }).join("")}</div></div>`;
  }
  if (i.comments) h += `<h2>Comments</h2><div class="card" style="white-space:pre-wrap">${esc(i.comments)}</div>`;

  const sections = ["exterior", "interior", "trailer"].filter((s) => i.items.some((it) => it.section === s));
  h += `<h2>Full checklist</h2><div class="card small">${sections.map((s) => `<b>${SECTION_TITLES[s]}</b><div style="margin:4px 0 12px">
    ${i.items.filter((it) => it.section === s).map((it) => `<div class="chk"><span>${esc(it.label)}</span>
      <span class="pill ${it.result === "repair" ? "bad" : "okk"}">${it.result === "repair" ? "Repair" : "OK"}</span></div>`).join("")}</div>`).join("")}</div>`;

  h += `<h2>Sign-off</h2><div class="card"><div class="small muted">Employee</div>
    <img class="sigimg" src="${esc(i.employee_signature_url)}" alt="Employee signature">
    <div class="small">${esc(i.inspector_name)} · ${fmtDate(i.inspection_date)}</div>
    <div style="border-top:1px solid var(--line);margin:12px 0"></div><div class="small muted">Supervisor</div>`;
  if (i.supervisor) {
    h += `<img class="sigimg" src="${esc(i.supervisor.signature_url)}" alt="Supervisor signature">
      <div class="small">${esc(i.supervisor.name)} · ${fmtDate(i.supervisor.signed_at)}</div>
      ${i.supervisor.note ? `<div style="margin-top:8px"><b>Supervisor note:</b> <span style="white-space:pre-wrap">${esc(i.supervisor.note)}</span></div>` : ""}`;
  } else if (isSup) {
    h += `<div style="margin-top:6px">
      <label class="f" for="supName">Supervisor name</label><input class="t" id="supName" value="${esc(state.user.name)}">
      <label class="f" for="supNote" style="margin-top:10px">Note (optional; corrections go here)</label><textarea class="t" id="supNote"></textarea>
      <label class="f" style="margin-top:10px">Signature</label><canvas class="sig" id="supsig" aria-label="Supervisor signature pad"></canvas>
      <div id="supErr"></div>
      <div class="spread" style="margin-top:8px"><button class="link" id="supClr">Clear</button><button class="primary" id="supSave">Sign off</button></div></div>`;
  } else {
    h += `<span class="pill grey">Awaiting supervisor review</span>`;
  }
  h += `</div>`;
  app.innerHTML = h;

  app.onclick = async (e) => {
    const lb = e.target.closest("[data-lb]");
    if (lb) {
      const p = i.photos.find((x) => x.id === lb.dataset.lb);
      if (p) lightbox(photoUrl(p), [tagOf(p), p.caption].filter(Boolean).join(" — "));
      return;
    }
    const rs = e.target.closest("[data-resolve]");
    if (rs && (await resolveRepair(rs.dataset.resolve, rs.dataset.label)) && !stale(nav)) render(app, id);
  };

  if ($("#supsig")) {
    let sup = null;
    sigPad = setupSig($("#supsig"), { get: () => sup, set: (val) => { sup = val; } });
    $("#supClr").onclick = () => sigPad.clear();
    $("#supSave").onclick = async () => {
      const name = $("#supName").value.trim();
      if (!sup || !name) {
        $("#supErr").innerHTML = `<div class="banner err">Add your name and signature.</div>`;
        return;
      }
      const b = $("#supSave");
      b.disabled = true;
      b.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;
      try {
        await api(`/inspections/${i.id}/review`, { method: "POST", body: { signature: sup, name, note: $("#supNote").value } });
        toast("Signed off ✓");
        if (!stale(nav)) render(app, id);
      } catch (err) {
        b.disabled = false;
        b.textContent = "Sign off";
        $("#supErr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
      }
    };
  }
}
