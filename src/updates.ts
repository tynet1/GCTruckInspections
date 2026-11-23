// Optional update check for Admin → About. Off unless UPDATE_CHECK_REPO names a GitHub repository AND an admin turns
// it on. Then the server asks GitHub for that repository's latest release at most once a day (the answer is kept in
// `settings`), with a plain GET that carries nothing about this server's users or data, and compares its version
// with the running one. Installing an update stays a job for whoever runs the server (docs/DEPLOY.md §6): the app
// has no access to Docker or the host, by design (SPEC §9 item 8).
import { config } from "./config.ts";
import { one } from "./db.ts";

export const CHECK_EVERY_MS = 24 * 3600_000;
const NOTES_MAX = 20_000;

/** Swapped out by the tests, so they never reach the network. */
export const updateDeps = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  now: (): number => Date.now(),
};

// ---------- Versions ----------

export interface Version { major: number; minor: number; patch: number; pre: string[] }

/** "1.2.3", "v1.2.3", "1.2.3-beta.1" (build metadata after "+" is ignored). Null for anything else. */
export function parseVersion(v: unknown): Version | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver order: negative if a < b, 0 if equal, positive if a > b. A pre-release comes before its release. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------- Stored state ----------

interface Release { tag: string; name: string | null; notes: string; published_at: string | null }
interface CheckResult {
  repo: string;
  checked_at: string;          // when GitHub was last asked (good answer or not)
  ok: boolean;
  release?: Release;           // the latest release, when ok
  message?: string;            // why it couldn't check, when not ok
}

async function readSetting<T>(key: string): Promise<T | null> {
  const r = await one<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return r?.value ?? null;
}

async function writeSetting(key: string, value: unknown, userId: number | null = null) {
  await one(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId],
  );
}

export async function updateCheckEnabled(): Promise<boolean> {
  return (await readSetting<{ enabled?: boolean }>("update_check"))?.enabled === true;
}

export async function setUpdateCheck(enabled: boolean, userId: number) {
  await writeSetting("update_check", { enabled }, userId);
}

// ---------- Asking GitHub ----------

/** One GET to GitHub's "latest release" API. Never throws: a failure is a result with ok false and a reason. */
export async function fetchLatestRelease(repo: string): Promise<CheckResult> {
  const checked_at = new Date(updateDeps.now()).toISOString();
  const failed = (message: string): CheckResult => ({ repo, checked_at, ok: false, message });
  let res: Response;
  try {
    res = await updateDeps.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      method: "GET",
      // Only what GitHub's API asks for. No version, no address, no account: nothing about this server's users.
      headers: { accept: "application/vnd.github+json", "user-agent": "self-hosted-update-check", "x-github-api-version": "2022-11-28" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    const name = (e as Error).name;
    return failed(name === "TimeoutError" || name === "AbortError" ? "GitHub didn't answer in time." : "Couldn't reach GitHub (no network?).");
  }
  if (res.status === 403 || res.status === 429) return failed("GitHub's limit on checks was reached; it will try again later.");
  if (res.status === 404) return failed(`No published release was found for ${repo}.`);
  if (!res.ok) return failed(`GitHub answered ${res.status}.`);
  let body: Record<string, unknown>;
  try {
    const text = await res.text();
    if (text.length > 2_000_000) return failed("GitHub's answer was too large.");
    body = JSON.parse(text);
  } catch {
    return failed("GitHub's answer couldn't be read.");
  }
  const tag = typeof body.tag_name === "string" ? body.tag_name.trim().slice(0, 100) : "";
  if (!tag) return failed("The latest release has no version tag.");
  return {
    repo, checked_at, ok: true,
    release: {
      tag,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : null,
      notes: typeof body.body === "string" ? body.body.slice(0, NOTES_MAX) : "",
      published_at: typeof body.published_at === "string" && !Number.isNaN(Date.parse(body.published_at)) ? body.published_at : null,
    },
  };
}

let inFlight: Promise<CheckResult> | null = null;

/** The stored result, refreshed from GitHub when it's a day old (or for another repository). */
async function currentResult(repo: string): Promise<CheckResult> {
  const kept = await readSetting<CheckResult>("update_check_result");
  const age = kept ? updateDeps.now() - Date.parse(kept.checked_at) : Infinity;
  if (kept && kept.repo === repo && age >= 0 && age < CHECK_EVERY_MS) return kept;
  // Two admins opening About at once still ask GitHub once.
  inFlight ??= (async () => {
    try {
      const r = await fetchLatestRelease(repo);
      await writeSetting("update_check_result", r);
      return r;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export interface UpdateStatus {
  repo: string;
  enabled: boolean;
  // off: not turned on · current: running the latest · available: a newer release · failed: couldn't check ·
  // unknown: the latest release's tag isn't a version number this can compare
  state: "off" | "current" | "available" | "failed" | "unknown";
  current: string;
  checked_at: string | null;
  next_check_at: string | null;
  message: string | null;
  latest: (Release & { version: string | null; url: string }) | null;
}

/** For Admin → About. Null when no repository is configured (the feature is hidden). */
export async function updateStatus(): Promise<UpdateStatus | null> {
  const repo = config.updateCheckRepo;
  if (!repo) return null;
  const base: UpdateStatus = {
    repo, enabled: false, state: "off", current: config.version, checked_at: null, next_check_at: null, message: null, latest: null,
  };
  if (!(await updateCheckEnabled())) return base;
  const r = await currentResult(repo);
  const out: UpdateStatus = {
    ...base,
    enabled: true,
    checked_at: r.checked_at,
    next_check_at: new Date(Date.parse(r.checked_at) + CHECK_EVERY_MS).toISOString(),
  };
  if (!r.ok || !r.release) return { ...out, state: "failed", message: r.message ?? "Couldn't check for updates." };
  const latest = parseVersion(r.release.tag);
  const running = parseVersion(config.version);
  out.latest = {
    ...r.release,
    version: latest ? `${latest.major}.${latest.minor}.${latest.patch}${latest.pre.length ? `-${latest.pre.join(".")}` : ""}` : null,
    // Built here, not taken from the answer, so it can only ever be this repository's release page.
    url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.release.tag)}`,
  };
  if (!latest || !running) {
    return { ...out, state: "unknown", message: `The latest release (${r.release.tag}) can't be compared with version ${config.version}.` };
  }
  return { ...out, state: compareVersions(latest, running) > 0 ? "available" : "current" };
}
