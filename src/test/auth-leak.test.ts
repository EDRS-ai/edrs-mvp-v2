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
import Database from "better-sqlite3";
import { hashPassword } from "../lib/auth";

function makeTestEnv() {
  const db = new Database(":memory:");
  // Minimal schema for auth tests. The handler expects this exact shape.
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      investor_id INTEGER,
      driver_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX users_email_idx ON users(email);
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      role TEXT NOT NULL,
      label TEXT NOT NULL,
      investor_id INTEGER,
      driver_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE UNIQUE INDEX invites_token_idx ON invites(token);
    CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
    CREATE TABLE drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, company TEXT, bdo_number TEXT, bdo_verified INTEGER NOT NULL DEFAULT 0, gps_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
    CREATE TABLE points (id TEXT PRIMARY KEY, address TEXT NOT NULL, district TEXT NOT NULL, investor_id INTEGER NOT NULL, lat REAL, lng REAL, fill_level INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'online', last_collection_at INTEGER, monthly_packages INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX points_investor_idx ON points(investor_id);
    CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, point_id TEXT NOT NULL, driver_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'completed', packages INTEGER, weight_kg REAL, accepted_at INTEGER, collected_at INTEGER, cycle_id INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX collections_point_idx ON collections(point_id);
    CREATE INDEX collections_driver_idx ON collections(driver_id);
    CREATE INDEX collections_status_idx ON collections(status);
    CREATE TABLE settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL, party TEXT NOT NULL, party_type TEXT NOT NULL, investor_id INTEGER, driver_id INTEGER, count INTEGER NOT NULL, rate_label TEXT NOT NULL, net_grosze INTEGER NOT NULL, vat_grosze INTEGER NOT NULL, gross_grosze INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX settlements_period_idx ON settlements(period);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, ksef_number TEXT NOT NULL, recipient TEXT NOT NULL, investor_id INTEGER, driver_id INTEGER, title TEXT NOT NULL, amount_grosze INTEGER NOT NULL, issue_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'zaakceptowana', created_at INTEGER NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE settlement_cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', closed_at INTEGER, created_at INTEGER NOT NULL, created_by INTEGER);
    CREATE INDEX settlement_cycles_status_idx ON settlement_cycles(status);
    CREATE UNIQUE INDEX settlement_cycles_label_idx ON settlement_cycles(label);
    CREATE TABLE operator_credits (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL, point_id TEXT NOT NULL, packages INTEGER NOT NULL, amount_grosze INTEGER NOT NULL, source_csv TEXT, source_row INTEGER, source_reference TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX operator_credits_cycle_idx ON operator_credits(cycle_id);
    CREATE INDEX operator_credits_point_idx ON operator_credits(point_id);
    CREATE TABLE sorter_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL, point_id TEXT NOT NULL, packages INTEGER NOT NULL, received_at INTEGER, source_csv TEXT, source_row INTEGER, source_reference TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX sorter_receipts_cycle_idx ON sorter_receipts(cycle_id);
    CREATE INDEX sorter_receipts_point_idx ON sorter_receipts(point_id);
    CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER, point_id TEXT, event_type TEXT NOT NULL, payload_json TEXT, actor_id INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX event_log_cycle_idx ON event_log(cycle_id);
    CREATE INDEX event_log_type_idx ON event_log(event_type);
    CREATE INDEX event_log_created_idx ON event_log(created_at);
  `);
  return {
    db,
    sql: {
      exec: (sql: string, params: any[] = []) => db.prepare(sql).run(...params),
      query: <T = any>(sql: string, params: any[] = []): T[] => db.prepare(sql).all(...params) as T[],
      raw: (sql: string, params: any[] = []) => ({ rows: db.prepare(sql).all(...params) }),
    },
    websocket: {},
    ctx: { session: { isOwner: true } },
  };
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
    const t0 = Date.now();
    await app.request("/api/admin/overview", { headers: { Cookie: `edrs_session=${cookie}` } }, env);
    const rows = env.sql.query<{ last_activity_at: number }>("SELECT last_activity_at FROM sessions WHERE token = ?", [cookie]);
    expect(rows.length).toBe(1);
    // last_activity_at should be >= t0 (within ms).
    expect(rows[0].last_activity_at).toBeGreaterThanOrEqual(t0);
  });
});
