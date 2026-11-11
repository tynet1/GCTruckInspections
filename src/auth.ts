import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { one, q } from "./db.ts";
import { HttpError } from "./http.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export type Role = "crew" | "shop" | "supervisor" | "admin";
export interface SessionUser {
  id: number;
  name: string;
  email: string | null;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
  }
}

export const COOKIE = "gc_session";
// The shop manager ranks with crew; the extra things a shop user can do are granted per route (requireRole's `also`).
const RANK: Record<Role, number> = { crew: 1, shop: 1, supervisor: 2, admin: 3 };
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ---------- Secrets (PINs and passwords) ----------

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    // Burn similar time so a missing account isn't distinguishable by timing.
    await scrypt(secret, randomBytes(16), 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
    return false;
  }
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(secret, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

export const PIN_RE = /^\d{4,6}$/;
export function checkPassword(pw: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters.";
  if (pw.length > 200) return "Password is too long.";
  return null;
}

// ---------- Lockout ----------

export async function assertNotLocked(user: { id: number; locked_until: Date | null }): Promise<void> {
  if (user.locked_until && user.locked_until > new Date()) {
    const mins = Math.ceil((user.locked_until.getTime() - Date.now()) / 60000);
    throw new HttpError(429, `Too many wrong tries. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or ask a supervisor.`);
  }
}

export async function recordFailure(userId: number): Promise<void> {
  await q(
    `UPDATE users SET
       failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
       locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
     WHERE id = $1`,
    [userId, config.lockout.maxFailures, config.lockout.minutes],
  );
}

// ---------- Sessions ----------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function cookieSecure(req: FastifyRequest): boolean {
  if (config.cookieSecure === "true") return true;
  if (config.cookieSecure === "false") return false;
  return req.protocol === "https";
}

export async function startSession(req: FastifyRequest, reply: FastifyReply, user: { id: number; role: Role }): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const days = user.role === "crew" ? config.session.crewDays : config.session.staffDays;
  await q(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [sha256(token), user.id, days, String(req.headers["user-agent"] ?? "").slice(0, 300)],
  );
  await q(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    maxAge: days * 86400,
  });
}

export async function endSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.sessionId) await q(`DELETE FROM sessions WHERE id = $1`, [req.sessionId]);
  reply.clearCookie(COOKIE, { path: "/" });
}

/** onRequest hook: attach req.user from the session cookie. Sliding expiry, refreshed at most hourly. */
export async function loadSession(req: FastifyRequest): Promise<void> {
  req.user = null;
  req.sessionId = null;
  const token = req.cookies?.[COOKIE];
  if (!token || token.length > 100) return;
  const id = sha256(token);
  const row = await one<SessionUser & { refresh: boolean }>(
    `SELECT u.id, u.name, u.email, u.role, (s.last_seen_at < now() - interval '1 hour') AS refresh
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.active`,
    [id],
  );
  if (!row) return;
  if (row.refresh) {
    const days = row.role === "crew" ? config.session.crewDays : config.session.staffDays;
    await q(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1`, [id, days]);
  }
  req.user = { id: row.id, name: row.name, email: row.email, role: row.role };
  req.sessionId = id;
}

// ---------- Guards ----------

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, "Please sign in.");
  return req.user;
}

/** `role` or higher may pass, plus any role listed in `also` (e.g. requireRole("supervisor", "shop")). */
export function requireRole(role: Role, ...also: Role[]) {
  return async (req: FastifyRequest) => {
    const u = requireUser(req);
    if (RANK[u.role] < RANK[role] && !also.includes(u.role)) {
      throw new HttpError(403, `Only a ${[role, ...also].join(" or ")} can do that.`);
    }
  };
}

export const atLeast = (u: SessionUser | null, role: Role) => !!u && RANK[u.role] >= RANK[role];
