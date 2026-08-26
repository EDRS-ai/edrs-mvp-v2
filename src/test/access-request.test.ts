// Formularz "Zapytaj o dostęp" (landing) — publiczny POST /api/public/access-request.
import { describe, it, expect, beforeEach } from "vitest";
import { makeMigratedDb, makeSqlEnv } from "./helpers";

function makeTestEnv() {
  const env = makeSqlEnv(makeMigratedDb());
  env.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', 'test')", []);
  return env;
}

const VALID = { name: "Jan Testowy", company: "SM Testowa", email: "jan@example.com", phone: "600100200", message: "Chcemy 5 punktów w Gliwicach", website: "" };

describe("access-request (landing → panel mastera)", () => {
  let env: any;
  let app: any;

  beforeEach(async () => {
    env = makeTestEnv();
    app = (await import("../handler")).createApp();
  });

  const post = (body: any) =>
    app.request("/api/public/access-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);

  it("przyjmuje zgłoszenie bez logowania i zapisuje wiersz", async () => {
    const res = await post(VALID);
    expect(res.status).toBe(200);
    const rows = env.sql.query("SELECT * FROM access_requests");
    expect(rows.length).toBe(1);
    expect(rows[0].email).toBe("jan@example.com");
    expect(rows[0].handled_at).toBeNull();
  });

  it("odrzuca brakujące pola i zły e-mail", async () => {
    expect((await post({ ...VALID, name: "" })).status).toBe(400);
    expect((await post({ ...VALID, message: "  " })).status).toBe(400);
    expect((await post({ ...VALID, email: "nie-email" })).status).toBe(400);
    expect(env.sql.query("SELECT * FROM access_requests").length).toBe(0);
  });

  it("honeypot: wypełnione pole website = pozorny sukces bez zapisu", async () => {
    const res = await post({ ...VALID, website: "http://spam.example" });
    expect(res.status).toBe(200);
    expect(env.sql.query("SELECT * FROM access_requests").length).toBe(0);
  });

  it("rate limit: 6. zgłoszenie z tego samego e-maila w dobie → 429", async () => {
    for (let i = 0; i < 5; i++) expect((await post(VALID)).status).toBe(200);
    expect((await post(VALID)).status).toBe(429);
    expect(env.sql.query("SELECT * FROM access_requests").length).toBe(5);
  });

  it("lista zgłoszeń wymaga mastera (401 bez sesji)", async () => {
    const res = await app.request("/api/admin/access-requests", {}, env);
    expect(res.status).toBe(401);
  });
});
