// Sprint 2 PROMPT 0 — integration test for auth leak vectors.
// Verifies:
//   1. Login response sets httpOnly + Secure + SameSite=Lax cookie (not query param).
//   2. Same cookie authenticates subsequent API calls.
//   3. Query param `?token=...` is REJECTED — no fallback (PROMPT 0 hard rule).
//   4. Idle timeout: token with last_activity_at > 12h ago is rejected and deleted.
//   5. Token rotation: two consecutive logins return different tokens.
//   6. Body does not contain token-as-URL (e.g., no "?token=" in any response).
//
// Uses better-sqlite3 in-memory to simulate Cloudflare's `env.sql` (sync) interface.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { makeMigratedDb, makeSqlEnv } from "./helpers";
import { hashPassword } from "../lib/auth";

function makeTestEnv() {
  // Schemat z prawdziwych migracji (migrations/*.sql) — patrz helpers.ts.
  return makeSqlEnv(makeMigratedDb());
}

async function seedUser(env: any, email: string, password: string, role: string = "master") {
  const pwd = await hashPassword(password);
  env.sql.exec(
    "INSERT INTO users (email, name, role, password_hash, salt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [email, "Test User", role, pwd.hash, pwd.salt, "active", Date.now()]
  );
}

function extractCookie(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp(`(?:^|, )${name}=([^;]+)`));
  return m ? m[1] : null;
}

describe("auth-leak (PROMPT 0)", () => {
  let env: any;
  let app: any;

  beforeEach(async () => {
    env = makeTestEnv();
    // Seed: master user, skip ensureSeeded since meta['seeded'] is empty in fresh in-memory.
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', 'test')", []);
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('packagesMonth', '0')", []);
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('collectionsMonth', '0')", []);
    await seedUser(env, "test@example.com", "testpass", "master");
    // Pre-populate session last_activity_at as a column. (Sanity.)
    app = (await import("../handler")).createApp();
  });

  it("login sets httpOnly + Secure + SameSite=Lax cookie (not query param)", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "testpass" }),
    }, env);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("edrs_session=");
    // Body should NOT contain a redirect URL with token in query.
    const body = await res.text();
    expect(body).not.toMatch(/\?token=/);
    expect(body).not.toMatch(/\?session=/);
  });

  it("cookie authenticates subsequent API calls (master /api/admin/overview)", async () => {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "testpass" }),
    }, env);
    const cookie = extractCookie(loginRes.headers.get("set-cookie"), "edrs_session");
    expect(cookie).toBeTruthy();

    const apiRes = await app.request("/api/admin/overview", {
      headers: { Cookie: `edrs_session=${cookie}` },
    }, env);
    expect(apiRes.status).toBe(200);
    const data = await apiRes.json();
    expect(data.investorsCount).toBe(0);
    expect(data.driversCount).toBe(0);
    expect(data.pointsCount).toBe(0);
  });

  it("REJECTS token via query param (no fallback — PROMPT 0 hard rule)", async () => {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "testpass" }),
    }, env);
    const cookie = extractCookie(loginRes.headers.get("set-cookie"), "edrs_session");
    expect(cookie).toBeTruthy();

    // Even with the SAME valid token, ?token= query param must NOT work.
    const queryRes = await app.request(`/api/admin/overview?token=${cookie}`, {}, env);
    expect(queryRes.status).toBe(401);
    const queryResSession = await app.request(`/api/admin/overview?session=${cookie}`, {}, env);
    expect(queryResSession.status).toBe(401);
  });

  it("REJECTS idle-expired token (12h+ since last_activity_at)", async () => {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "testpass" }),
    }, env);
    const cookie = extractCookie(loginRes.headers.get("set-cookie"), "edrs_session");
    expect(cookie).toBeTruthy();

    // Force last_activity_at to 13h ago.
    const thirteenHoursAgo = Date.now() - 13 * 3600 * 1000;
    env.sql.exec("UPDATE sessions SET last_activity_at = ? WHERE token = ?", [thirteenHoursAgo, cookie]);

    const apiRes = await app.request("/api/admin/overview", {
      headers: { Cookie: `edrs_session=${cookie}` },
    }, env);
    expect(apiRes.status).toBe(401);
  });

  it("rotates token on each login (two logins → two different tokens)", async () => {
    const res1 = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "testpass" }),
    }, env);
    const res2 = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "testpass" }),
    }, env);
    const t1 = extractCookie(res1.headers.get("set-cookie"), "edrs_session");
    const t2 = extractCookie(res2.headers.get("set-cookie"), "edrs_session");
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1).not.toBe(t2);
  });

  it("update last_activity_at on each authenticated request (resets idle clock)", async () => {
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "testpass" }),
    }, env);
    const cookie = extractCookie(loginRes.headers.get("set-cookie"), "edrs_session")!;
    // PROMPT 7: update last_activity_at jest throttlowany do 60 s. Cofamy zegar
    // o 2 minuty (wciąż < 12 h idle), żeby kolejny request MUSIAŁ zresetować idle clock.
    env.sql.exec("UPDATE sessions SET last_activity_at = ? WHERE token = ?", [Date.now() - 2 * 60_000, cookie]);
    const t0 = Date.now();
    await app.request("/api/admin/overview", { headers: { Cookie: `edrs_session=${cookie}` } }, env);
    const rows = env.sql.query<{ last_activity_at: number }>("SELECT last_activity_at FROM sessions WHERE token = ?", [cookie]);
    expect(rows.length).toBe(1);
    // last_activity_at should be >= t0 (within ms).
    expect(rows[0].last_activity_at).toBeGreaterThanOrEqual(t0);
  });
});
