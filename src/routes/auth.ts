import type { FastifyInstance } from "fastify";
import { assertNotLocked, endSession, PIN_RE, recordFailure, requireUser, startSession, verifySecret } from "../auth.ts";
import type { Role } from "../auth.ts";
import { one, q } from "../db.ts";
import { bad, HttpError, obj } from "../http.ts";

interface LoginRow {
  id: number;
  name: string;
  email: string | null;
  role: Role;
  pin_hash: string | null;
  password_hash: string | null;
  locked_until: Date | null;
}

const authLimit = { rateLimit: { max: 15, timeWindow: "1 minute" } };

export default async function authRoutes(app: FastifyInstance) {
  // Names for the crew sign-in picker (anyone with a PIN).
  app.get("/auth/crew", async () =>
    q(`SELECT id, name FROM users WHERE active AND pin_hash IS NOT NULL ORDER BY lower(name)`));

  app.post("/auth/pin", { config: authLimit }, async (req, reply) => {
    const b = obj(req.body);
    const userId = Number(b.user_id);
    const pin = b.pin;
    if (!Number.isInteger(userId) || typeof pin !== "string" || !PIN_RE.test(pin)) {
      throw bad("Pick your name and enter your 4–6 digit PIN.");
    }
    const u = await one<LoginRow>(`SELECT * FROM users WHERE id = $1 AND active`, [userId]);
    if (u) await assertNotLocked(u);
    const ok = await verifySecret(pin, u?.pin_hash ?? null);
    if (!u || !ok) {
      if (u) await recordFailure(u.id);
      throw new HttpError(401, "That PIN didn't match. Try again.");
    }
    await startSession(req, reply, u);
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  });

  app.post("/auth/login", { config: authLimit }, async (req, reply) => {
    const b = obj(req.body);
    const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
    const password = typeof b.password === "string" ? b.password : "";
    if (!email || !password) throw bad("Enter your email and password.");
    const u = await one<LoginRow>(`SELECT * FROM users WHERE lower(email) = $1 AND active`, [email]);
    if (u) await assertNotLocked(u);
    const ok = await verifySecret(password, u?.password_hash ?? null);
    if (!u || !ok) {
      if (u) await recordFailure(u.id);
      throw new HttpError(401, "Email or password is wrong.");
    }
    await startSession(req, reply, u);
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  });

  app.post("/auth/logout", async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  app.get("/me", async (req) => requireUser(req));
}
