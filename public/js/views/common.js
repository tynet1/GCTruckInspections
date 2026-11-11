// Bits of markup shared between screens.
import { api } from "../api.js";
import { esc, fmtDate, fmtMoney, fmtNum, modal, toast } from "../util.js";

/** One row in a maintenance list (truck page, home). */
export function serviceRow(s, { showTruck = false } = {}) {
  return `<a class="item${s.voided ? " voided" : ""}" href="#/service/${esc(s.id)}">
    <span class="grow">${showTruck ? `<b>${esc(s.truck_code)}</b> · ` : ""}${fmtDate(s.service_date)} · ${esc(s.category_label)}
      <span class="small muted clip">${esc(s.description)}${s.mileage != null ? ` · ${fmtNum(s.mileage)} mi` : ""}</span></span>
    <span class="row" style="justify-content:flex-end;flex-wrap:nowrap">
      ${s.voided ? `<span class="pill grey">Voided</span>` : ""}
      ${s.cost != null && !s.voided ? `<span class="small muted">${fmtMoney(s.cost)}</span>` : ""}
      ${s.repair_count ? `<span class="pill okk">${s.repair_count} fixed</span>` : ""}
    </span></a>`;
}

/** Supervisor marks a repair item as fixed. Resolves true when saved. */
export function resolveRepair(itemId, label) {
  return new Promise((resolve) => {
    const m = modal(`<h3>Mark repair resolved</h3>
      <p class="muted" style="margin-top:-6px">${esc(label)}</p>
      <label class="f" for="rn">What was done?</label>
      <textarea class="t" id="rn" placeholder="e.g. Replaced left tail light bulb"></textarea>
      <div id="rerr"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="secondary" data-c>Cancel</button><button class="primary" data-y>Mark resolved</button></div>`);
    const ta = m.querySelector("#rn");
    ta.focus();
    m.querySelector("[data-c]").onclick = () => { m.remove(); resolve(false); };
    m.querySelector("[data-y]").onclick = async (e) => {
      const note = ta.value.trim();
      if (!note) { m.querySelector("#rerr").innerHTML = `<div class="banner err">Add a short note about the fix.</div>`; return; }
      e.target.disabled = true;
      try {
        await api(`/inspection-items/${itemId}/resolve`, { method: "POST", body: { note } });
        m.remove();
        toast("Repair marked resolved ✓");
        resolve(true);
      } catch (err) {
        e.target.disabled = false;
        m.querySelector("#rerr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
      }
    };
  });
}

/** One row in an inspection list (home "recent", truck history, awaiting sign-off). */
export function inspectionRow(i, { showTruck = true } = {}) {
  const n = Number(i.repair_count || 0);
  return `<a class="item" href="#/inspection/${esc(i.id)}">
    <span>${showTruck ? `<b>${esc(i.truck_code)}</b> · ` : ""}${fmtDate(i.inspection_date)}<br>
      <span class="small muted">${esc(i.inspector_name || "")}${i.mileage != null ? ` · ${fmtNum(i.mileage)} mi` : ""}</span></span>
    <span class="row" style="justify-content:flex-end">
      ${n ? `<span class="pill bad">${n} repair${n > 1 ? "s" : ""}</span>` : `<span class="pill okk">All OK</span>`}
      ${i.mileage_flagged ? `<span class="pill warn">Mileage?</span>` : ""}
      ${i.status === "reviewed" ? "" : `<span class="pill grey">Unreviewed</span>`}
    </span></a>`;
}

export const SECTION_TITLES = { exterior: "Exterior", interior: "Interior", trailer: "Trailer & crew" };
