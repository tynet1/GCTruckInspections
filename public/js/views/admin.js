// Admin (MVP): users & PINs, trucks and their diagrams. Checklist editing comes in phase 2.
import { api } from "../api.js";
import { errorHtml, setHeader, stale, state } from "../ui.js";
import { $, esc, fmtDate, modal, shrinkImage, toast, vehicleInfo } from "../util.js";

export async function render(app, tab = "users", editId = null) {
  const nav = state.nav;
  setHeader({ title: "Admin", sub: tab === "trucks" ? "Trucks" : "Users & PINs", back: "#/" });
  app.innerHTML = `<div class="tabs"><a href="#/admin/users" class="${tab === "users" ? "on" : ""}">Users &amp; PINs</a>
    <a href="#/admin/trucks" class="${tab === "trucks" ? "on" : ""}">Trucks</a></div><div id="adm"><div class="empty">Loading…</div></div>`;
  try {
    if (tab === "trucks") await trucksTab(nav, editId);
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
    <div class="card list">${vehicles.map((v) => `<button class="item" data-veh="${v.id}">
      <span><b>${esc(v.truck_code)}</b> ${esc(vehicleInfo(v))}<br><span class="small muted">${esc(v.plate || "no plate")} · ${esc(v.diagram_name || "default diagram")}</span></span>
      <span class="row" style="justify-content:flex-end">${v.active ? "" : `<span class="pill bad">Retired</span>`}
        ${v.registration_expires ? `<span class="pill grey">Reg ${fmtDate(v.registration_expires)}</span>` : ""}</span></button>`).join("")}</div>`;
  const reload = () => trucksTab(nav, null);
  $("#addTruck").onclick = () => truckEditor(null, diagrams, reload);
  box.querySelectorAll("[data-veh]").forEach((b) => (b.onclick = () => truckEditor(vehicles.find((v) => v.id === Number(b.dataset.veh)), diagrams, reload)));
  if (editId) {
    const v = vehicles.find((x) => x.id === Number(editId));
    if (v) truckEditor(v, diagrams, reload);
  }
}

function truckEditor(v, diagrams, onSaved) {
  const isNew = !v;
  v = v || { truck_code: "", active: true, pulls_trailer: false, diagram_id: null };
  const truckDias = diagrams.filter((x) => x.kind === "truck");
  const preview = (id) => truckDias.find((x) => x.id === Number(id))?.url || truckDias[0]?.url || "";
  const m = modal(`<h3>${isNew ? "Add truck" : `Edit ${esc(v.truck_code)}`}</h3>
    <div class="fields">
      <div><label class="f" for="tCode">Truck ID</label><input class="t" id="tCode" value="${esc(v.truck_code)}" placeholder="AZ018" autocapitalize="characters"></div>
      <div><label class="f" for="tUnit">Unit</label><input class="t" id="tUnit" value="${esc(v.unit || "")}"></div>
      <div><label class="f" for="tVin">VIN</label><input class="t" id="tVin" value="${esc(v.vin || "")}" autocapitalize="characters" maxlength="17"></div>
      <div><label class="f" for="tPlate">Plate</label><input class="t" id="tPlate" value="${esc(v.plate || "")}" autocapitalize="characters"></div>
      <div><label class="f" for="tYear">Year</label><input class="t" id="tYear" inputmode="numeric" value="${esc(v.year || "")}"></div>
      <div><label class="f" for="tMake">Make</label><input class="t" id="tMake" value="${esc(v.make || "")}"></div>
      <div><label class="f" for="tModel">Model</label><input class="t" id="tModel" value="${esc(v.model || "")}"></div>
      <div><label class="f" for="tExp">Registration expires</label><input class="t" id="tExp" type="date" value="${esc(v.registration_expires || "")}"></div>
    </div>
    <div class="toggle" style="margin:14px 0"><div><b>Usually pulls a trailer</b><div class="small muted">Turns the trailer checklist on by default</div></div>
      <button type="button" class="sw ${v.pulls_trailer ? "on" : ""}" id="tTrl" role="switch" aria-label="Usually pulls a trailer"></button></div>
    <label class="f" for="tDia">Damage diagram</label>
    <select class="t" id="tDia"><option value="">Default (${esc(truckDias[0]?.name || "none")})</option>
      ${truckDias.map((x) => `<option value="${x.id}" ${x.id === v.diagram_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
    <img class="thumb" id="tDiaImg" src="${esc(preview(v.diagram_id))}" alt="" style="margin-top:8px">
    <details style="margin-top:8px"><summary class="link" style="display:inline-block">Upload a new diagram</summary>
      <div class="fields" style="margin-top:8px"><div><label class="f" for="nDiaName">Diagram name</label><input class="t" id="nDiaName" placeholder="e.g. 2026 Ram 2500"></div>
      <div><label class="f" for="nDiaFile">Image</label><input class="t" id="nDiaFile" type="file" accept="image/*"></div></div>
      <button class="secondary" id="nDiaGo" style="margin-top:8px">Upload diagram</button></details>
    ${isNew ? "" : `<div class="toggle" style="margin:14px 0"><div><b>Active</b><div class="small muted">Retired trucks are hidden from crews; their history is kept</div></div>
      <button type="button" class="sw ${v.active ? "on" : ""}" id="tActive" role="switch" aria-label="Active"></button></div>`}
    <div id="tErr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="secondary" id="tCancel">Cancel</button><button class="primary" id="tSave">Save</button></div>`);
  const $m = (s) => m.querySelector(s);
  ["#tTrl", "#tActive"].forEach((s) => { const el = $m(s); if (el) el.onclick = () => el.classList.toggle("on"); });
  $m("#tDia").onchange = () => { $m("#tDiaImg").src = preview($m("#tDia").value); };
  $m("#tCancel").onclick = () => m.remove();
  $m("#nDiaGo").onclick = async (e) => {
    const f = $m("#nDiaFile").files[0];
    const name = $m("#nDiaName").value.trim();
    if (!f || !name) { $m("#tErr").innerHTML = `<div class="banner err">Pick an image and give the diagram a name.</div>`; return; }
    e.target.disabled = true;
    try {
      const fd = new FormData();
      fd.append("kind", "truck");
      fd.append("name", name);
      fd.append("file", await shrinkImage(f, 2000, 0.85), "diagram.jpg");
      const dnew = await api("/admin/diagrams", { method: "POST", form: fd, timeout: 120000 });
      truckDias.push(dnew);
      diagrams.push(dnew);
      $m("#tDia").insertAdjacentHTML("beforeend", `<option value="${dnew.id}">${esc(dnew.name)}</option>`);
      $m("#tDia").value = String(dnew.id);
      $m("#tDiaImg").src = dnew.url;
      $m("#tErr").innerHTML = `<div class="banner okk">Diagram uploaded. Save the truck to use it.</div>`;
    } catch (err) {
      $m("#tErr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    } finally {
      e.target.disabled = false;
    }
  };
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
      pulls_trailer: $m("#tTrl").classList.contains("on"),
      diagram_id: $m("#tDia").value,
    };
    const act = $m("#tActive");
    if (act) body.active = act.classList.contains("on");
    e.target.disabled = true;
    try {
      if (isNew) await api("/admin/vehicles", { method: "POST", body });
      else await api(`/admin/vehicles/${v.id}`, { method: "PATCH", body });
      m.remove();
      toast(`Saved ${body.truck_code.toUpperCase()}`);
      if (location.hash.includes("?edit=")) history.replaceState(null, "", "#/admin/trucks");
      onSaved();
    } catch (err) {
      e.target.disabled = false;
      $m("#tErr").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  };
}
