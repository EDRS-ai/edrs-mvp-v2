// Sprint 2 PROMPT 0 — auth module.
// Rules (non-negotiable):
//   - Token delivered via httpOnly + Secure + SameSite=Lax cookie ONLY.
//   - Server reads cookie + Authorization Bearer header. NO query param fallback.
//   - 12-hour idle timeout enforced via `last_activity_at` column on sessions.
//   - 30-day absolute timeout via `expires_at` (existing column).
//   - Each login generates a fresh token (rotation).
//   - resolveSession() updates `last_activity_at = now` on each successful auth
//     so any request resets the 12h idle clock.

import { setCookie, getCookie } from "hono/cookie";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map(h => parseInt(h, 16)));

export async function hashPassword(password: string, saltHex?: string) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return { salt: hex(salt), hash: hex(new Uint8Array(bits)) };
}

export async function verifyPassword(password: string, saltHex: string, expectedHash: string): Promise<boolean> {
  const { hash } = await hashPassword(password, saltHex);
  return hash === expectedHash;
}

export const newToken = (bytes = 32) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

export const SESSION_COOKIE = "edrs_session";
// Absolute max session lifetime. Independent of idle.
export const SESSION_DAYS = 30;
// Idle timeout: any session whose last_activity_at is older than this is invalid.
export const IDLE_TIMEOUT_MS = 12 * 3600 * 1000;

export const APP_USER_KEY = "appUser";
export type AppUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  investorId: number | null;
  driverId: number | null;
};

export function requireRole(...roles: string[]) {
  return async (c: any, next: any) => {
    const user = c.get(APP_USER_KEY) as AppUser | undefined;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!roles.includes(user.role)) return c.json({ error: "forbidden" }, 403);
    return next();
  };
}

// Cookie attributes required by PROMPT 0.
// httpOnly: not readable from JS (no XSS exfiltration).
// secure: HTTPS-only.
// sameSite=Lax: sent on top-level navigation, blocked on cross-site POST.
// path=/: sent on every path.
export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
  path: "/",
} as const;

export function setSessionCookie(c: any, token: string) {
  setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_DAYS * 86400 });
}

export function clearSessionCookie(c: any) {
  setCookie(c, SESSION_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
}

// resolveSession — sole auth path. Reads from cookie, falls back to Authorization
// header if Workers strips Cookie. NEVER reads query param (PROMPT 0: no fallback).
// On success: resets last_activity_at so 12h idle clock starts now.
export async function resolveSession(c: any): Promise<AppUser | null> {
  let token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    const auth = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) token = m[1];
  }
  if (!token) return null;

  const rows = c.env.sql.query<{
    id: number; email: string; name: string; role: string;
    investor_id: number | null; driver_id: number | null;
    expires_at: number; last_activity_at: number;
  }>(
    "SELECT u.id, u.email, u.name, u.role, u.investor_id, u.driver_id, " +
    "s.expires_at, s.last_activity_at " +
    "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
    [token]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const now = Date.now();
  // Either absolute max (30d) or idle (12h) — whichever expires first.
  if (r.expires_at < now || r.last_activity_at + IDLE_TIMEOUT_MS < now) {
    c.env.sql.exec("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  // Reset idle clock on every authenticated request.
  c.env.sql.exec("UPDATE sessions SET last_activity_at = ? WHERE token = ?", [now, token]);
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    investorId: r.investor_id,
    driverId: r.driver_id,
  };
}
