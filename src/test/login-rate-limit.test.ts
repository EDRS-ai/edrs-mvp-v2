// Rate-limit logowania: 5 nieudanych prób / 10 min per e-mail → 429.
import { describe, it, expect, beforeEach } from "vitest";
import { makeMigratedDb, makeSqlEnv } from "./helpers";
import { hashPassword } from "../lib/auth";

describe("login rate-limit", () => {
  let env: any, app: any;

  beforeEach(async () => {
    env = makeSqlEnv(makeMigratedDb());
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', 'test')", []);
    const pwd = await hashPassword("dobre-haslo");
    env.sql.exec(
      "INSERT INTO users (email, name, role, password_hash, salt, status, created_at) VALUES ('rl@example.com', 'RL', 'master', ?, ?, 'active', ?)",
      [pwd.hash, pwd.salt, Date.now()]
    );
    app = (await import("../handler")).createApp();
  });

  const login = (password: string) =>
    app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "rl@example.com", password }) }, env);

  it("po 5 nieudanych próbach blokuje nawet poprawne hasło; sukces czyści licznik", async () => {
    for (let i = 0; i < 5; i++) expect((await login("zle-haslo")).status).toBe(401);
    expect((await login("dobre-haslo")).status).toBe(429);
    // po oknie: symulujemy upływ czasu cofając znaczniki prób
    env.sql.exec("UPDATE login_attempts SET at = at - 11 * 60000", []);
    expect((await login("dobre-haslo")).status).toBe(200);
    // licznik wyczyszczony — nowa zła próba nie blokuje od razu
    expect((await login("zle-haslo")).status).toBe(401);
    expect((await login("dobre-haslo")).status).toBe(200);
  });

  it("limit jest per e-mail — inne konto loguje się mimo blokady pierwszego", async () => {
    for (let i = 0; i < 6; i++) await login("zle-haslo");
    const pwd = await hashPassword("inne-haslo");
    env.sql.exec(
      "INSERT INTO users (email, name, role, password_hash, salt, status, created_at) VALUES ('inny@example.com', 'X', 'master', ?, ?, 'active', ?)",
      [pwd.hash, pwd.salt, Date.now()]
    );
    const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "inny@example.com", password: "inne-haslo" }) }, env);
    expect(res.status).toBe(200);
  });
});
