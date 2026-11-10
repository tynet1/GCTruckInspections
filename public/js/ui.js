// Shared app state and the header bar.
import { $, esc } from "./util.js";

export const state = {
  user: null,   // { id, name, email, role }
  nav: 0,       // bumps on every route change; async renders check it before touching the DOM
};

const RANK = { crew: 1, supervisor: 2, admin: 3 };
export const atLeast = (role) => !!state.user && RANK[state.user.role] >= RANK[role];

/** True if the user has navigated away since `nav` was captured. */
export const stale = (nav) => nav !== state.nav;

/**
 * @param {{title: string, sub?: string, back?: string|null, actions?: {label: string, href?: string, onclick?: () => void}[]}} h
 */
export function setHeader({ title, sub = "", back = null, actions = [] }) {
  $("#title").innerHTML = `${esc(title)}${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  const b = $("#backBtn");
  b.hidden = !back;
  if (back) b.href = back;
  const box = $("#headActions");
  box.innerHTML = "";
  for (const a of actions) {
    const el = document.createElement(a.href ? "a" : "button");
    el.className = "iconbtn";
    el.textContent = a.label;
    if (a.href) el.href = a.href;
    if (a.onclick) el.onclick = a.onclick;
    box.appendChild(el);
  }
  document.title = `${title} · GC Inspections`;
}

export function errorHtml(e) {
  return `<div class="banner err">${esc(e?.message || String(e))}</div>`;
}
