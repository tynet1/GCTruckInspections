// Maintenance entry form (shop manager / admin): log new work on a truck, or edit an entry.
// The draft autosaves on the phone; a new entry queues and uploads by itself if there's no signal.
import { api } from "../api.js";
import { deletePhotoBlob, photoBlob, storePhotoBlob } from "../drafts.js";
import {
  deleteSvcDraft, flushSvc, getSvcDraft, saveSvcDraft, sendSvc, setActiveSvc, syncSvcPhotos,
} from "../svc.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, $$, confirmBox, debounce, esc, fmtDate, fmtNum, shrinkImage, toast, today, uuid, vehicleInfo } from "../util.js";
import { SECTION_TITLES } from "./common.js";

let d = null;    // the draft being edited
let ctx = null;  // { app, vehicle, categories, openRepairs, entry, currentMiles }
let saving = false;
const blobUrls = new Map();
const persist = debounce(() => { if (d && d.touched) saveSvcDraft(d); }, 400);

/**
 * mode "new": id is the truck id. mode "edit": id is the entry id.
 * fix: a repair item id from a "Log fix" button; it starts ticked.
 */
export async function render(app, mode, id, fix) {
  const nav = state.nav;
  const isEdit = mode === "edit";
  setHeader({ title: isEdit ? "Edit maintenance" : "Log maintenance", back: isEdit ? `#/service/${id}` : "#/" });
  app.innerHTML = `<div class="empty">Loading…</div>`;
  let entry = null, vehicle, openRepairs, config, history;
  try {
    if (isEdit) entry = await api(`/service-logs/${id}`);
    const vid = isEdit ? entry.vehicle.id : Number(id);
    [{ vehicle, openRepairs }, config, history] = await Promise.all([
      api(`/vehicles/${vid}`), api("/service-config"), api(`/vehicles/${vid}/service`).catch(() => null),
    ]);
  } catch (e) {
    if (stale(nav)) return;
    const msg = e.status === 0 ? "Can't load this without signal. Open the truck once while you have signal; after that this form works offline." : e.message;
    app.innerHTML = errorHtml(new Error(msg)) + `<a class="secondary" href="${isEdit ? `#/service/${id}` : `#/truck/${id}`}">Back</a>`;
    return;
  }
  if (stale(nav)) return;
  if (entry?.voided) return void location.replace(`#/service/${entry.id}`);

  const key = isEdit ? `edit-${entry.id}` : `new-${vehicle.id}`;
  let draft = await getSvcDraft(key);
  if (draft?.status === "queued") return void location.replace(`#/truck/${vehicle.id}`);
  if (!draft) draft = isEdit ? draftFromEntry(key, entry) : newDraft(key, vehicle);
  d = draft;
  setActiveSvc(d);
  ctx = { app, vehicle, categories: config.categories, openRepairs, entry, currentMiles: history?.current_mileage ?? vehicle.last_mileage ?? null };
  if (fix && !isEdit) startFix(Number(fix));
  setHeader({
    title: isEdit ? "Edit maintenance" : d.touched ? "Maintenance draft" : "Log maintenance",
    sub: `${vehicle.truck_code} · ${vehicleInfo(vehicle)}`,
    back: isEdit ? `#/service/${entry.id}` : `#/truck/${vehicle.id}`,
  });
  draw();
  uploadPhotos();
}

export async function leave() {
  persist.flush();
  if (ctx?.app) { ctx.app.onclick = null; ctx.app.oninput = null; ctx.app.onchange = null; }
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  setActiveSvc(null);
  d = null;
  ctx = null;
  saving = false;
}

function newDraft(key, v) {
  return {
    key, vehicleId: v.id, truckCode: v.truck_code, clientId: uuid(), status: "editing", touched: false,
    date: today(), mileage: "", category: "", description: "", parts: "", cost: "",
    performedBy: state.user?.name || "", vendor: "", notes: "", nextMiles: "", nextDate: "",
    repairs: [], photos: [], lastError: null,
  };
}

function draftFromEntry(key, e) {
  return {
    key, vehicleId: e.vehicle.id, truckCode: e.vehicle.truck_code, entryId: e.id, version: e.version,
    status: "editing", touched: false,
    date: e.service_date, mileage: e.mileage ?? "", category: e.category, description: e.description || "",
    parts: e.parts || "", cost: e.cost == null ? "" : Number(e.cost).toFixed(2), performedBy: e.performed_by || "",
    vendor: e.vendor || "", notes: e.notes || "", nextMiles: e.next_due_mileage ?? "", nextDate: e.next_due_date || "",
    repairs: [], photos: [], lastError: null,
  };
}

// ---------- Rendering ----------

const linkedRepairs = () => (ctx.entry?.repairs || []).filter((r) => r.active);
/** Open repairs on this truck that this entry can still fix. */
const openRepairs = () => ctx.openRepairs.filter((r) => !linkedRepairs().some((l) => l.id === r.id));

function repairsHtml() {
  const linked = linkedRepairs();
  const open = openRepairs();
  const auto = d.autoRepairs || [];
  const catLabel = ctx.categories.find((c) => c.id === d.category)?.label || "";
  let h = linked.map((r) => `<div class="pick done"><span class="tick">✓</span><span><b>${esc(r.label)}</b><br>
      <span class="small muted">Fixed by this entry · from ${fmtDate(r.inspection_date)} inspection</span></span></div>`).join("");
  if (!open.length) return h || `<span class="muted">No open repairs on ${esc(ctx.vehicle.truck_code)}.</span>`;
  h += open.map((r) => `<label class="pick"><input type="checkbox" data-rep="${r.id}" ${d.repairs.includes(r.id) ? "checked" : ""}>
      <span><b>${esc(r.label)}</b> <span class="small muted">(${esc(SECTION_TITLES[r.section] || r.section)})</span>
      ${auto.includes(r.id) && d.repairs.includes(r.id) ? `<span class="pill">Matches ${esc(catLabel)}</span>` : ""}<br>
      <span class="small muted">${r.note ? `${esc(r.note)} · ` : ""}from ${fmtDate(r.inspection_date)} inspection</span></span></label>`).join("");
  h += `<p class="small muted" style="margin:8px 0 0">Ticked repairs are marked fixed when you save${
    auto.some((id) => d.repairs.includes(id)) ? ". Repairs that match the type of work are ticked for you; untick any you didn't fix." : "."}</p>`;
  return h;
}

const redrawRepairs = () => {
  const el = $("#s-repairs");
  if (el) el.innerHTML = repairsHtml();
};

/** Open repairs that match a type of work (the rules come from the server with the categories). */
function autoMatches(category) {
  const rule = ctx.categories.find((c) => c.id === category)?.auto;
  if (!rule) return [];
  const re = new RegExp(rule.match, "i");
  const not = rule.not ? new RegExp(rule.not, "i") : null;
  return openRepairs()
    .filter((r) => rule.sections.includes(r.section) && re.test(r.label) && !(not && not.test(r.label)))
    .map((r) => r.id);
}

/** Picking a type of work ticks the matching repairs; ticks the shop made by hand are never removed. */
function applyAuto(category) {
  const prevAuto = d.autoRepairs || [];
  const manual = d.repairs.filter((id) => !prevAuto.includes(id));
  const auto = autoMatches(category).filter((id) => !manual.includes(id));
  d.repairs = [...manual, ...auto];
  d.autoRepairs = auto;
  redrawRepairs();
  if (auto.length) toast(`Ticked ${auto.length} matching repair${auto.length > 1 ? "s" : ""}. Untick any you didn't fix.`, 3500);
}

/** Came from a repair's "Log fix" button: tick it, and pick the type of work if none is chosen yet. */
function startFix(itemId) {
  const item = openRepairs().find((r) => r.id === itemId);
  if (!item) return;
  if (!d.repairs.includes(itemId)) d.repairs.push(itemId);
  d.autoRepairs = (d.autoRepairs || []).filter((id) => id !== itemId); // a deliberate pick, not a suggestion
  if (!d.category) {
    d.category = ctx.categories.find((c) => c.auto && autoMatches(c.id).includes(itemId))?.id || "repair";
  }
  d.touched = true;
  saveSvcDraft(d);
}

function draw() {
  const changedOnServer = d.entryId && ctx.entry && d.version !== ctx.entry.version;
  let h = "";
  if (d.lastError) h += `<div class="banner err">${esc(d.lastError)}</div>`;
  if (changedOnServer) {
    h += `<div class="banner info">Someone changed this entry after you started editing it on this phone. Saving will be refused until you
      <button class="link" id="s-restart">start over from their version</button>.</div>`;
  }
  h += `<div class="card" style="margin-top:14px">
    <div class="fields">
      <div><label class="f" for="s-date">Date</label><input class="t" id="s-date" type="date" value="${esc(d.date)}"></div>
      <div><label class="f" for="s-mi">Mileage</label><input class="t" id="s-mi" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
        value="${esc(d.mileage)}" placeholder="${ctx.currentMiles != null ? `Last: ${fmtNum(ctx.currentMiles)}` : ""}"><div class="hint" id="s-miWarn"></div></div>
    </div>
    <label class="f" style="margin-top:14px">Type of work</label>
    <div class="chips" id="s-cat">${ctx.categories.map((c) => `<button type="button" data-cat="${c.id}" class="${d.category === c.id ? "on" : ""}" aria-pressed="${d.category === c.id}">${esc(c.label)}</button>`).join("")}</div>
    <label class="f" for="s-work" style="margin-top:14px">Work done</label>
    <textarea class="t" id="s-work" placeholder="e.g. Changed oil and filter, topped off coolant">${esc(d.description)}</textarea>
    <label class="f" for="s-parts" style="margin-top:12px">Parts used</label>
    <textarea class="t" id="s-parts" style="min-height:60px" placeholder="Optional">${esc(d.parts)}</textarea>
    <div class="fields" style="margin-top:12px">
      <div><label class="f" for="s-cost">Cost ($)</label><input class="t" id="s-cost" inputmode="decimal" autocomplete="off" value="${esc(d.cost)}" placeholder="0.00"></div>
      <div><label class="f" for="s-by">Done by</label><input class="t" id="s-by" value="${esc(d.performedBy)}"></div>
      <div><label class="f" for="s-vendor">Outside shop (if any)</label><input class="t" id="s-vendor" value="${esc(d.vendor)}" placeholder="e.g. Discount Tire"></div>
    </div>
  </div>`;

  h += `<h2>Repairs this fixed</h2><div class="card" id="s-repairs">${repairsHtml()}</div>`;

  h += `<h2>Next service due</h2><div class="card"><div class="fields">
      <div><label class="f" for="s-nmi">At mileage</label><input class="t" id="s-nmi" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="${esc(d.nextMiles)}" placeholder="Optional"></div>
      <div><label class="f" for="s-ndate">Or by date</label><input class="t" id="s-ndate" type="date" value="${esc(d.nextDate)}"></div>
    </div><p class="small muted" style="margin:8px 0 0">Shows on the truck page, and turns orange when it's close.</p></div>`;

  const oldPhotos = ctx.entry?.photos || [];
  h += `<h2>Photos</h2><div class="card">
    ${oldPhotos.length ? `<div class="photos" style="margin-bottom:10px">${oldPhotos.map((p) => `<div class="ph"><img alt="" src="/api/photos/${esc(p.id)}">
      ${p.caption ? `<span class="cap" style="display:block">${esc(p.caption)}</span>` : ""}</div>`).join("")}</div>` : ""}
    <div class="photos" id="s-photos">${photosHtml()}</div>
    <p class="small muted" style="margin:8px 0 0">Receipts, parts, or the finished work.${oldPhotos.length ? " Photos already saved can't be removed." : ""}</p></div>`;

  h += `<h2>Notes</h2><div class="card"><textarea class="t" id="s-notes" placeholder="Optional">${esc(d.notes)}</textarea></div>
    <div id="s-err"></div>
    <div class="bar"><div class="in"><span class="prog">${d.entryId ? "Editing saved entry" : "Saved on this phone as you type"}</span>
      <button class="primary" id="s-save">${d.entryId ? "Save changes" : "Save entry"}</button></div></div>`;

  ctx.app.innerHTML = h;
  document.body.classList.add("has-bar");
  loadThumbs();
  mileageWarn();
  wire();
}

function photosHtml() {
  return d.photos.map((p) => `<div class="ph"><img alt="" data-pid="${p.id}"${blobUrls.has(p.id) ? ` src="${blobUrls.get(p.id)}"` : ""}>
      ${p.uploaded ? "" : `<div class="state">${navigator.onLine ? `<span class="spinner"></span>` : "Saved on phone"}</div>`}
      <button type="button" class="x" data-phx="${p.id}" aria-label="Remove photo">×</button>
      <input class="cap" data-phc="${p.id}" placeholder="Caption" value="${esc(p.caption || "")}"></div>`).join("")
    + `<label class="addph"><span style="font-size:28px">＋</span><span>Add photos</span><input type="file" accept="image/*" multiple id="s-phIn"></label>`;
}

async function loadThumbs() {
  for (const img of $$("img[data-pid]:not([src])", ctx?.app)) {
    const id = img.dataset.pid;
    const blob = await photoBlob(id).catch(() => null);
    if (!ctx) return;
    if (blob) {
      if (!blobUrls.has(id)) blobUrls.set(id, URL.createObjectURL(blob));
      img.src = blobUrls.get(id);
    } else {
      img.src = `/api/photos/${id}`;
    }
  }
}

const redrawPhotos = () => {
  const el = $("#s-photos");
  if (el) { el.innerHTML = photosHtml(); loadThumbs(); }
};

function mileageWarn() {
  const el = $("#s-miWarn");
  if (!el) return;
  const n = Number(d.mileage);
  const low = d.mileage !== "" && ctx.currentMiles != null && n < ctx.currentMiles;
  el.className = low ? "hint warn" : "hint";
  el.textContent = low ? `Lower than the last recorded ${fmtNum(ctx.currentMiles)}. Double-check the odometer.` : "";
}

// ---------- Events ----------

function changed() {
  d.touched = true;
  persist();
  updateMissing();
}

const FIELD_IDS = {
  "s-date": "date", "s-work": "description", "s-parts": "parts", "s-cost": "cost", "s-by": "performedBy",
  "s-vendor": "vendor", "s-notes": "notes", "s-ndate": "nextDate",
};

function wire() {
  const app = ctx.app;
  app.oninput = (e) => {
    const t = e.target;
    if (t.id === "s-mi" || t.id === "s-nmi") {
      const digits = t.value.replace(/\D/g, "").slice(0, 7);
      if (digits !== t.value) t.value = digits;
      if (t.id === "s-mi") { d.mileage = digits; mileageWarn(); } else d.nextMiles = digits;
      return changed();
    }
    if (FIELD_IDS[t.id]) { d[FIELD_IDS[t.id]] = t.value; return changed(); }
    if (t.dataset.phc) { const p = d.photos.find((x) => x.id === t.dataset.phc); if (p) p.caption = t.value; return changed(); }
  };
  app.onchange = (e) => {
    const t = e.target;
    if (t.dataset.rep) {
      const id = Number(t.dataset.rep);
      d.repairs = t.checked ? [...new Set([...d.repairs, id])] : d.repairs.filter((x) => x !== id);
      d.autoRepairs = (d.autoRepairs || []).filter((x) => x !== id); // the shop decided this one by hand
      redrawRepairs();
      return changed();
    }
    if (t.id === "s-phIn" && t.files?.length) {
      const files = [...t.files];
      t.value = "";
      addPhotos(files);
    }
  };
  app.onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.cat) {
      if (d.category === t.dataset.cat) return;
      d.category = t.dataset.cat;
      $$("#s-cat button").forEach((b) => { b.classList.toggle("on", b === t); b.setAttribute("aria-pressed", String(b === t)); });
      applyAuto(d.category);
      return changed();
    }
    if (t.dataset.phx) {
      const id = t.dataset.phx;
      d.photos = d.photos.filter((p) => p.id !== id);
      deletePhotoBlob(id).catch(() => {});
      redrawPhotos();
      return changed();
    }
    if (t.id === "s-save") return save();
    if (t.id === "s-restart") {
      if (!(await confirmBox("Throw away your changes on this phone and start from the latest saved version?", "Start over", { danger: true }))) return;
      const entryId = d.entryId;
      await deleteSvcDraft(d);
      d = null;
      render(ctx.app, "edit", entryId);
    }
  };
}

async function addPhotos(files) {
  for (const f of files) {
    const id = uuid();
    const blob = await shrinkImage(f);
    if (!d) return;
    await storePhotoBlob(id, blob);
    blobUrls.set(id, URL.createObjectURL(blob));
    d.photos.push({ id, caption: "", uploaded: false });
    d.touched = true;
    await saveSvcDraft(d);
    redrawPhotos();
  }
  toast(files.length > 1 ? `${files.length} photos added` : "Photo added");
  uploadPhotos();
}

let uploadingNow = false;
async function uploadPhotos() {
  if (!d || uploadingNow || !d.photos.some((p) => !p.uploaded)) return;
  uploadingNow = true;
  try {
    await syncSvcPhotos(d.key);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    uploadingNow = false;
  }
  if (d) redrawPhotos();
}

// ---------- Validation and save ----------

function missingList() {
  const miss = [];
  if (!d.date) miss.push({ label: "date", sel: "#s-date" });
  if (d.mileage === "") miss.push({ label: "mileage", sel: "#s-mi" });
  if (!d.category) miss.push({ label: "type of work", sel: "#s-cat" });
  if (!d.description.trim()) miss.push({ label: "work done", sel: "#s-work" });
  if (d.cost.trim() && !/^\$?\s*[\d,]{1,9}(\.\d{1,2})?$/.test(d.cost.trim())) miss.push({ label: "cost as an amount like 125.50", sel: "#s-cost" });
  return miss;
}

function highlight(miss) {
  $$(".missing").forEach((el) => el.classList.remove("missing"));
  for (const m of miss) $$(m.sel).forEach((el) => el.classList.add("missing"));
}

function updateMissing() {
  const err = $("#s-err");
  if (!err?.dataset.missing) return;
  const miss = missingList();
  highlight(miss);
  if (miss.length) err.querySelector("span").textContent = `${miss.map((m) => m.label).join(", ")}.`;
  else { err.innerHTML = ""; delete err.dataset.missing; }
}

function buildPayload() {
  const fields = {
    service_date: d.date,
    mileage: Number(d.mileage),
    category: d.category,
    description: d.description.trim(),
    parts: d.parts,
    cost: d.cost.trim(),
    performed_by: d.performedBy,
    vendor: d.vendor,
    notes: d.notes,
    next_due_mileage: d.nextMiles === "" ? null : Number(d.nextMiles),
    next_due_date: d.nextDate || null,
    repair_item_ids: d.repairs,
    photos: d.photos.map((p) => ({ id: p.id, caption: p.caption || null })),
  };
  return d.entryId ? { version: d.version, ...fields } : { client_id: d.clientId, vehicle_id: d.vehicleId, ...fields };
}

async function save() {
  if (saving || !d) return;
  const err = $("#s-err");
  const miss = missingList();
  highlight(miss);
  if (miss.length) {
    err.innerHTML = `<div class="banner err"><b>Still needed:</b> <span>${esc(miss.map((m) => m.label).join(", "))}.</span></div>`;
    err.dataset.missing = "1";
    ($(miss[0].sel) || err).scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  saving = true;
  err.innerHTML = "";
  delete err.dataset.missing;
  const btn = $("#s-save");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>&nbsp;Saving…`;

  const isEdit = !!d.entryId;
  const vehicleId = d.vehicleId;
  d.payload = buildPayload();
  if (!isEdit) d.status = "queued";
  d.lastError = null;
  d.touched = true;
  persist.flush();
  await saveSvcDraft(d);

  const r = await sendSvc(d.key);
  saving = false;
  if (r.state === "sent") {
    setActiveSvc(null);
    d = null;
    toast(isEdit ? "Changes saved ✓" : "Maintenance saved ✓");
    location.hash = `#/service/${r.res.id}`;
    return;
  }
  if (r.state === "waiting" && !isEdit) {
    toast("Saved on phone, not yet uploaded. It will send by itself when signal returns.", 5000);
    flushSvc();
    location.hash = `#/truck/${vehicleId}`;
    return;
  }
  if (!d) return;
  btn.disabled = false;
  btn.textContent = isEdit ? "Save changes" : "Save entry";
  const msg = r.state === "waiting"
    ? "No connection to the server. Your changes are kept on this phone; try again when you have signal."
    : r.error.message;
  err.innerHTML = `<div class="banner err">${esc(msg)}${r.error?.details?.code === "stale"
    ? ` <button class="link" id="s-restart">Start over from their version</button>` : ""}</div>`;
  err.scrollIntoView({ behavior: "smooth", block: "center" });
}
