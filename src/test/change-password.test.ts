// Zmiana hasła — /api/auth/change-password.
// Weryfikuje:
//   1. Poprawna zmiana: stare hasło przestaje działać, nowe działa.
//   2. Błędne obecne hasło → 401 invalid_current_password, hash nietknięty.
//   3. Za krótkie nowe hasło → 400 password_too_short.
//   4. Bez sesji → 401.
//   5. Po zmianie inne sesje użytkownika są unieważnione, bieżąca zostaje.

import { describe, it, expect, beforeEach } from "vitest";
import { makeMigratedDb, makeSqlEnv } from "./helpers";
import { hashPassword } from "../lib/auth";

function makeTestEnv() {
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

async function login(app: any, env: any, email: string, password: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }, env);
  expect(res.status).toBe(200);
  const cookie = extractCookie(res.headers.get("set-cookie"), "edrs_session");
  expect(cookie).toBeTruthy();
  return cookie as string;
}

describe("change-password", () => {
  let env: any;
  let app: any;

  beforeEach(async () => {
    env = makeTestEnv();
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', 'test')", []);
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('packagesMonth', '0')", []);
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('collectionsMonth', '0')", []);
    await seedUser(env, "test@example.com", "starehaslo", "master");
    app = (await import("../handler")).createApp();
  });

  it("zmienia hasło: stare przestaje działać, nowe działa", async () => {
    const cookie = await login(app, env, "test@example.com", "starehaslo");
    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: `edrs_session=${cookie}` },
      body: JSON.stringify({ currentPassword: "starehaslo", newPassword: "nowehaslo123" }),
    }, env);
    expect(res.status).toBe(200);

    const oldLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "starehaslo" }),
    }, env);
    expect(oldLogin.status).toBe(401);

    await login(app, env, "test@example.com", "nowehaslo123");
  });

  it("odrzuca błędne obecne hasło (401), hash zostaje", async () => {
    const before = env.sql.query("SELECT password_hash, salt FROM users WHERE email = ?", ["test@example.com"])[0];
    const cookie = await login(app, env, "test@example.com", "starehaslo");
    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: `edrs_session=${cookie}` },
      body: JSON.stringify({ currentPassword: "zlehaslo", newPassword: "nowehaslo123" }),
    }, env);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("invalid_current_password");
    const after = env.sql.query("SELECT password_hash, salt FROM users WHERE email = ?", ["test@example.com"])[0];
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.salt).toBe(before.salt);
  });

  it("odrzuca za krótkie nowe hasło (400)", async () => {
    const cookie = await login(app, env, "test@example.com", "starehaslo");
    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: `edrs_session=${cookie}` },
      body: JSON.stringify({ currentPassword: "starehaslo", newPassword: "abc" }),
    }, env);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("password_too_short");
  });

  it("wymaga sesji (401 bez cookie)", async () => {
    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "starehaslo", newPassword: "nowehaslo123" }),
    }, env);
    expect(res.status).toBe(401);
  });

  it("unieważnia inne sesje, bieżąca zostaje", async () => {
    const cookieA = await login(app, env, "test@example.com", "starehaslo");
    const cookieB = await login(app, env, "test@example.com", "starehaslo");
    expect(cookieA).not.toBe(cookieB);

    const res = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: `edrs_session=${cookieA}` },
      body: JSON.stringify({ currentPassword: "starehaslo", newPassword: "nowehaslo123" }),
    }, env);
    expect(res.status).toBe(200);

    // Bieżąca sesja (A) nadal działa.
    const resA = await app.request("/api/admin/overview", { headers: { Cookie: `edrs_session=${cookieA}` } }, env);
    expect(resA.status).toBe(200);
    // Druga sesja (B) unieważniona.
    const resB = await app.request("/api/admin/overview", { headers: { Cookie: `edrs_session=${cookieB}` } }, env);
    expect(resB.status).toBe(401);
  });
});
