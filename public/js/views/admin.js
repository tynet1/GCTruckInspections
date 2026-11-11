// Admin: users & PINs, trucks (with trailer type and diagrams), and branding. Checklist editing comes in phase 2.
import { api } from "../api.js";
import { brandVars, rememberBranding } from "../brand.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, confirmBox, esc, fmtDate, modal, shrinkImage, toast, vehicleInfo } from "../util.js";

const TABS = { users: "Users & PINs", trucks: "Trucks", branding: "Branding" };

export async function render(app, tab = "users", editId = null) {
  const nav = state.nav;
  if (!TABS[tab]) tab = "users";
  setHeader({ title: "Admin", sub: TABS[tab], back: "#/" });
  app.innerHTML = `<div class="tabs">${Object.entries(TABS).map(([k, label]) =>
    `<a href="#/admin/${k}" class="${tab === k ? "on" : ""}">${esc(k === "users" ? "Users" : label)}</a>`).join("")}</div>
    <div id="adm"><div class="empty">Loading…</div></div>`;
  try {
    if (tab === "trucks") await trucksTab(nav, editId);
    else if (tab === "branding") await brandingTab(nav);
    else await usersTab(nav);
  } catch (e) {
    if (!stale(nav)) $("#adm").innerHTML = errorHtml(e);
  }
}

// ---------- Users ----------

async function usersTab(nav) {
  const users = await api("/admin/users");
  if (stale(nav)) return;
  const box = $("#adm");
  box.innerHTML = `<div class="spread" style="margin:16px 4px 8px"><h2 style="margin:0">Users (${users.length})</h2>
      <button class="primary" id="addUser">+ Add user</button></div>
    <div class="card list">${users.map((u) => `<button class="item" data-user="${u.id}">
      <span><b>${esc(u.name)}</b>${u.email ? `<br><span class="small muted">${esc(u.email)}</span>` : ""}</span>
      <span class="row" style="justify-content:flex-end">
        <span class="pill ${u.role === "crew" ? "grey" : ""}">${esc(u.role)}</span>
        ${u.has_pin ? `<span class="pill grey">PIN</span>` : ""}
        ${u.locked ? `<span class="pill bad">Locked</span>` : ""}
        ${u.active ? "" : `<span class="pill bad">Inactive</span>`}
      </span></button>`).join("") || `<div class="empty">No users.</div>`}</div>
    <p class="small muted">Crew sign in by picking their name and entering a 4–6 digit PIN. Supervisors and admins sign in with email and password.
      Too many wrong tries locks an account for 15 minutes; setting a new PIN or password unlocks it.</p>`;
  $("#addUser").onclick = () => userEditor(null, () => usersTab(nav));
  box.querySelectorAll("[data-user]").forEach((b) => (b.onclick = () => userEditor(users.find((u) => u.id === Number(b.dataset.user)), () => usersTab(nav))));
}

function userEditor(u, onSaved) {
  const isNew = !u;
  u = u || { name: "", email: "", role: "crew", active: true };
  const m = modal(`<h3>${isNew ? "Add user" : `Edit ${esc(u.name)}`}</h3>
    <div class="fields">
      <div><label class="f" for="uName">Name (as crew will see it)</label><input class="t" id="uName" value="${esc(u.name)}" autocomplete="off"></div>
      <div><label class="f" for="uRole">Role</label><select class="t" id="uRole">
        ${["crew", "supervisor", "admin"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></div>
      <div><label class="f" for="uPin">${isNew ? "PIN (4–6 digits)" : `New PIN${u.has_pin ? " (blank = keep)" : ""}`}</label>
        <input class="t" id="uPin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"></div>
      <div><label class="f" for="uEmail">Email (supervisor/admin)</label><input class="t" id="uEmail" type="email" value="${esc(u.email || "")}" autocomplete="off" autocapitalize="off"></div>
      <div><label class="f" for="uPw">${isNew ? "Password (10+ characters)" : `New password${u.has_password ? " (blank = keep)" : ""}`}</label>
        <input class="t" id="uPw" type="password" autocomplete="new-password"></div>
    </div>
    ${isNew ? "" : `<div class="toggle" style="margin:14px 0"><div><b>Active</b><div class="small muted">Inactive users can't sign in</div></div>
      <button type="button" class="sw ${u.active ? "on" : ""}" id="uActive" role="switch" aria-label="Active"></button></div>`}
    ${u.locked ? `<div class="banner info">Locked after too many wrong tries. Set a new PIN or password to unlock now.</div>` : ""}
    <div id="uErr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="secondary" id="uCancel">Cancel</button><button class="primary" id="uSave">Save</button></div>`);
  const act = m.querySelector("#uActive");
  if (act) act.onclick = () => act.classList.toggle("on");
  m.querySelector("#uCancel").onclick = () => m.remove();
  m.querySelector("#uSave").onclick = async (e) => {
    const body = {
      name: m.querySelector("#uName").value,
      role: m.querySelector("#uRole").value,
      email: m.querySelector("#uEmail").value,
    };
    const pin = m.querySelector("#uPin").value.trim();
    const pw = m.querySelector("#uPw").value;
    if (pin) body.pin = pin;
    if (pw) body.password = pw;
    if (act) body.active = act.classList.contains("on");
    e.target.disabled = true;
    try {
      if (isNew) await api("/admin/users", { method: "POST", body });
      else await api(`/admin/users/${u.id}`, { method: "PATCH", body });
      m.remove();
      toast(`Saved ${body.name}`);
      onSaved();
    } catch (err) {
      e.target.disabled = false;
      m.querySelector("#uErr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  };
}

// ---------- Trucks ----------

async function trucksTab(nav, editId) {
  const [vehicles, diagrams] = await Promise.all([api("/admin/vehicles"), api("/diagrams")]);
  if (stale(nav)) return;
  const box = $("#adm");
  box.innerHTML = `<div class="spread" style="margin:16px 4px 8px"><h2 style="margin:0">Trucks (${vehicles.filter((v) => v.active).length} active)</h2>
      <button class="primary" id="addTruck">+ Add truck</button></div>
    <p class="small muted" style="margin:0 4px 10px">Tap a truck to change its details, registration, trailer or diagram.</p>
    <div class="card list">${vehicles.map((v) => `<button class="item" data-veh="${v.id}">
      <span><b>${esc(v.truck_code)}</b> ${esc(vehicleInfo(v))}<br><span class="small muted">${esc(v.plate || "no plate")} ·
        ${v.pulls_trailer ? `Trailer: ${esc(v.trailer_type || "yes")}` : "No trailer"}</span></span>
      <span class="row" style="justify-content:flex-end">${v.active ? "" : `<span class="pill bad">Retired</span>`}
        ${v.registration_expires ? `<span class="pill ${v.registration_expires < new Date().toISOString().slice(0, 10) ? "bad" : "grey"}">Reg ${fmtDate(v.registration_expires)}</span>` : ""}</span></button>`).join("")}</div>`;
  const reload = () => trucksTab(nav, null);
  $("#addTruck").onclick = () => truckEditor(null, diagrams, reload);
  box.querySelectorAll("[data-veh]").forEach((b) => (b.onclick = () => truckEditor(vehicles.find((v) => v.id === Number(b.dataset.veh)), diagrams, reload)));
  if (editId) {
    const v = vehicles.find((x) => x.id === Number(editId));
    if (v) truckEditor(v, diagrams, reload);
  }
}

/** "Add a new …" block that uploads a diagram of `kind` and selects it. */
function uploadBlock(kind, label, placeholder) {
  return `<details style="margin-top:8px"><summary class="link" style="display:inline-block">${esc(label)}</summary>
    <div class="fields" style="margin-top:8px">
      <div><label class="f" for="${kind}UpName">Name</label><input class="t" id="${kind}UpName" placeholder="${esc(placeholder)}"></div>
      <div><label class="f" for="${kind}UpFile">Picture (top-down drawing or photo)</label><input class="t" id="${kind}UpFile" type="file" accept="image/*"></div>
    </div>
    <button class="secondary" id="${kind}UpGo" style="margin-top:8px">Upload</button></details>`;
}

function truckEditor(v, diagrams, onSaved) {
  const isNew = !v;
  v = v || { truck_code: "", active: true, pulls_trailer: false, diagram_id: null, trailer_diagram_id: null };
  const byKind = (k) => diagrams.filter((x) => x.kind === k);
  const urlOf = (id) => diagrams.find((x) => x.id === Number(id))?.url || "";
  const truckDefault = byKind("truck")[0];
  const m = modal(`<h3>${isNew ? "Add truck" : `Edit ${esc(v.truck_code)}`}</h3>
    <div class="subhead">Truck</div>
    <div class="fields">
      <div><label class="f" for="tCode">Truck ID</label><input class="t" id="tCode" value="${esc(v.truck_code)}" placeholder="AZ018" autocapitalize="characters"></div>
      <div><label class="f" for="tUnit">Unit</label><input class="t" id="tUnit" value="${esc(v.unit || "")}" autocapitalize="characters"></div>
      <div><label class="f" for="tVin">VIN</label><input class="t" id="tVin" value="${esc(v.vin || "")}" autocapitalize="characters" maxlength="17"></div>
      <div><label class="f" for="tPlate">Plate</label><input class="t" id="tPlate" value="${esc(v.plate || "")}" autocapitalize="characters"></div>
      <div><label class="f" for="tYear">Year</label><input class="t" id="tYear" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${esc(v.year || "")}"></div>
      <div><label class="f" for="tMake">Make</label><input class="t" id="tMake" value="${esc(v.make || "")}"></div>
      <div><label class="f" for="tModel">Model</label><input class="t" id="tModel" value="${esc(v.model || "")}"></div>
      <div><label class="f" for="tExp">Registration expires</label><input class="t" id="tExp" type="date" value="${esc(v.registration_expires || "")}"></div>
    </div>

    <div class="subhead">Trailer</div>
    <label class="f" for="tTrl">Trailer type</label>
    <select class="t" id="tTrl"><option value="">No trailer</option>
      ${byKind("trailer").map((x) => `<option value="${x.id}" ${v.pulls_trailer && x.id === (v.trailer_diagram_id ?? byKind("trailer")[0]?.id) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    <div class="small muted" style="margin-top:6px">Trucks with a trailer start each inspection with the trailer &amp; crew checklist on. The crew can still switch it off.</div>
    <img class="thumb" id="tTrlImg" alt="" style="margin-top:8px">
    ${uploadBlock("trailer", "Add a trailer type", "e.g. 16 ft dump trailer")}

    <div class="subhead">Damage diagram</div>
    <label class="f" for="tDia">Body style</label>
    <select class="t" id="tDia"><option value="">Default (${esc(truckDefault?.name || "none")})</option>
      ${byKind("truck").map((x) => `<option value="${x.id}" ${x.id === v.diagram_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    <img class="thumb" id="tDiaImg" alt="" style="margin-top:8px">
    ${uploadBlock("truck", "Add a truck diagram", "e.g. 2026 Ram 2500 8ft bed")}

    ${isNew ? "" : `<div class="subhead">Status</div>
      <div class="toggle"><div><b>Active</b><div class="small muted">Retired trucks are hidden from crews; their history is kept</div></div>
      <button type="button" class="sw ${v.active ? "on" : ""}" id="tActive" role="switch" aria-label="Active"></button></div>`}
    <div id="tErr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="secondary" id="tCancel">Cancel</button><button class="primary" id="tSave">Save</button></div>`);
  const $m = (s) => m.querySelector(s);
  const showErr = (msg, cls = "err") => { $m("#tErr").innerHTML = msg ? `<div class="banner ${cls}">${esc(msg)}</div>` : ""; };

  const previews = () => {
    const t = $m("#tTrl").value;
    $m("#tTrlImg").hidden = !t;
    if (t) $m("#tTrlImg").src = urlOf(t);
    $m("#tDiaImg").src = urlOf($m("#tDia").value) || truckDefault?.url || "";
  };
  previews();
  $m("#tTrl").onchange = previews;
  $m("#tDia").onchange = previews;

  const act = $m("#tActive");
  if (act) act.onclick = () => act.classList.toggle("on");
  $m("#tCancel").onclick = () => m.remove();

  for (const [kind, sel] of [["trailer", "#tTrl"], ["truck", "#tDia"]]) {
    $m(`#${kind}UpGo`).onclick = async (e) => {
      const f = $m(`#${kind}UpFile`).files[0];
      const name = $m(`#${kind}UpName`).value.trim();
      if (!f || !name) return showErr("Pick a picture and give it a name.");
      e.target.disabled = true;
      try {
        const fd = new FormData();
        fd.append("kind", kind);
        fd.append("name", name);
        fd.append("file", await shrinkImage(f, 2000, 0.85), "diagram.jpg");
        const dnew = await api("/admin/diagrams", { method: "POST", form: fd, timeout: 120000 });
        diagrams.push(dnew);
        $m(sel).insertAdjacentHTML("beforeend", `<option value="${dnew.id}">${esc(dnew.name)}</option>`);
        $m(sel).value = String(dnew.id);
        previews();
        $m(`#${kind}UpName`).value = "";
        $m(`#${kind}UpFile`).value = "";
        e.target.closest("details").open = false;
        showErr(`"${dnew.name}" added. Save the truck to use it.`, "okk");
      } catch (err) {
        showErr(err.message);
      } finally {
        e.target.disabled = false;
      }
    };
  }

  $m("#tSave").onclick = async (e) => {
    const body = {
      truck_code: $m("#tCode").value,
      unit: $m("#tUnit").value,
      vin: $m("#tVin").value,
      plate: $m("#tPlate").value,
      year: $m("#tYear").value,
      make: $m("#tMake").value,
      model: $m("#tModel").value,
      registration_expires: $m("#tExp").value,
      trailer_diagram_id: $m("#tTrl").value,
      diagram_id: $m("#tDia").value,
    };
    if (act) body.active = act.classList.contains("on");
    if (act && !body.active && v.active
      && !(await confirmBox(`Retire ${v.truck_code}? Crews won't see it any more. Its inspection history is kept.`, "Retire"))) return;
    e.target.disabled = true;
    try {
      if (isNew) await api("/admin/vehicles", { method: "POST", body });
      else await api(`/admin/vehicles/${v.id}`, { method: "PATCH", body });
      m.remove();
      toast(`Saved ${body.truck_code.trim().toUpperCase()}`);
      if (location.hash.includes("?edit=")) history.replaceState(null, "", "#/admin/trucks");
      onSaved();
    } catch (err) {
      e.target.disabled = false;
      showErr(err.message);
    }
  };
}

// ---------- Branding ----------

const SWATCHES = ["#2f6b3a", "#1f5f8b", "#1f3a5f", "#0f766e", "#9b2c2c", "#c05621", "#37474f", "#f2c230"];

async function brandingTab(nav) {
  const b = await api("/branding");
  if (stale(nav)) return;
  let color = b.color;
  let logo = b.logo_url;
  const box = $("#adm");
  box.innerHTML = `<div class="card" style="margin-top:14px">
    <div class="subhead">Names</div>
    <div class="fields">
      <div><label class="f" for="bCo">Company name</label><input class="t" id="bCo" maxlength="60" value="${esc(b.company_name)}"></div>
      <div><label class="f" for="bApp">App name</label><input class="t" id="bApp" maxlength="40" value="${esc(b.app_name)}"></div>
    </div>
    <div class="subhead">Header color</div>
    <div class="colorrow"><input type="color" id="bColor" value="${esc(color)}" aria-label="Pick a color">
      <input class="t" id="bHex" value="${esc(color)}" maxlength="7" autocapitalize="off" autocomplete="off" aria-label="Color as hex"></div>
    <div class="swatches">${SWATCHES.map((c) => `<button type="button" data-c="${c}" style="background:${c}" aria-label="Use ${c}"></button>`).join("")}</div>
    <div class="subhead">Logo</div>
    <div class="logobox" id="bLogoBox"></div>
    <div class="row" style="margin-top:10px"><label class="secondary filebtn">Upload logo<input type="file" id="bLogoFile" accept="image/png,image/jpeg"></label>
      <button class="secondary danger" id="bLogoDel">Remove logo</button></div>
    <p class="small muted">PNG or JPEG, under 2 MB. A PNG with a transparent background looks best. The logo saves as soon as you pick it,
      and shows in the header, on the sign-in screen and on the PDF.</p>
    <div class="subhead">Preview</div>
    <div class="preview" id="bPrev"><div class="ph-top"><img class="hdrlogo" id="bPrevLogo" alt=""><div style="min-width:0"><b id="bPrevApp"></b><span id="bPrevCo"></span></div></div>
      <div class="ph-body"><span class="primary">Start inspection</span><span class="pill">2 open repairs</span><span style="color:var(--brand-ink);text-decoration:underline">Link color</span></div></div>
    <div id="bErr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="primary" id="bSave">Save names &amp; color</button></div>
  </div>`;

  const showErr = (msg) => { $("#bErr").innerHTML = msg ? `<div class="banner err">${esc(msg)}</div>` : ""; };
  const drawLogo = () => {
    $("#bLogoBox").innerHTML = logo ? `<img src="${esc(logo)}" alt="Current logo">` : `<span class="muted small">No logo yet</span>`;
    $("#bLogoDel").hidden = !logo;
    $("#bPrevLogo").hidden = !logo;
    if (logo) $("#bPrevLogo").src = logo;
  };
  const preview = () => {
    const prev = $("#bPrev");
    for (const [k, val] of Object.entries(brandVars(color))) prev.style.setProperty(k, val);
    $("#bPrevApp").textContent = $("#bApp").value || "App name";
    $("#bPrevCo").textContent = $("#bCo").value;
    box.querySelectorAll("[data-c]").forEach((s) => s.classList.toggle("on", s.dataset.c === color));
  };
  const setColor = (c, from) => {
    color = c.toLowerCase();
    if (from !== "picker") $("#bColor").value = color;
    if (from !== "hex") $("#bHex").value = color;
    preview();
  };
  drawLogo();
  preview();

  $("#bColor").oninput = (e) => setColor(e.target.value, "picker");
  $("#bHex").oninput = (e) => {
    let v = e.target.value.trim();
    if (v && !v.startsWith("#")) v = "#" + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) setColor(v, "hex");
  };
  box.querySelectorAll("[data-c]").forEach((s) => (s.onclick = () => setColor(s.dataset.c)));
  $("#bApp").oninput = preview;
  $("#bCo").oninput = preview;

  $("#bLogoFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    showErr("");
    if (f.size > 2 * 1024 * 1024) { e.target.value = ""; return showErr("That image is over 2 MB. Use a smaller PNG or JPEG."); }
    $("#bLogoBox").innerHTML = `<span class="spinner"></span>`;
    try {
      const fd = new FormData();
      fd.append("file", f, f.name);
      const res = await api("/admin/branding/logo", { method: "POST", form: fd, timeout: 60000 });
      logo = res.logo_url;
      rememberBranding(res);
      toast("Logo saved");
    } catch (err) {
      showErr(err.message);
    }
    e.target.value = "";
    drawLogo();
  };
  $("#bLogoDel").onclick = async () => {
    if (!(await confirmBox("Remove the logo? You can upload one again any time.", "Remove", { danger: true }))) return;
    try {
      const res = await api("/admin/branding/logo", { method: "DELETE" });
      logo = null;
      rememberBranding(res);
      drawLogo();
      toast("Logo removed");
    } catch (err) {
      showErr(err.message);
    }
  };
  $("#bSave").onclick = async (e) => {
    showErr("");
    e.target.disabled = true;
    try {
      const res = await api("/admin/branding", {
        method: "PUT",
        body: { company_name: $("#bCo").value, app_name: $("#bApp").value, color },
      });
      rememberBranding(res);
      setHeader({ title: "Admin", sub: TABS.branding, back: "#/" });
      toast("Branding saved");
    } catch (err) {
      showErr(err.message);
    } finally {
      e.target.disabled = false;
    }
  };
}
