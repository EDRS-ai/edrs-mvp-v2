// Konektor EcoAction: blob → staging rvm_events → collections (źródło A rekoncyliacji).
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { makeMigratedDb, makeSqlEnv } from "./helpers";
import { syncEcoActionBlob, assignMachine, listMachines } from "../lib/ecoaction";

const LISTING_XML = `<?xml version="1.0"?><EnumerationResults><Blobs>
<Blob><Name>M5052588/2026-04-13/M5052588-transaction-t1.json</Name></Blob>
<Blob><Name>M5052588/2026-06-08/M5052588-total-50504.json</Name></Blob>
</Blobs></EnumerationResults>`;

function rvmJson(messageType: string, messageId: string, items: any[], refund: number) {
  return {
    data: {
      header: { schemaVersion: "1.0", messageType, messageId, sentAt: "2026-06-08T11:23:24+02:00" },
      data: {
        machine: { serial: "M5052588" },
        voucher: {
          voucherNumber: "50504", refundAmount: refund,
          transactionEndDate: "2026-06-08T10:58:54+02:00",
          items,
        },
      },
    },
  };
}

function mockBlobFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("comp=list")) return new Response(LISTING_XML, { status: 200 });
    if (u.includes("transaction-t1")) return new Response(JSON.stringify(rvmJson("transaction", "t1", [{ count: "1" }], 50)), { status: 200 });
    if (u.includes("total-50504")) return new Response(JSON.stringify(rvmJson("total", "total-50504", [{ count: "2" }, { count: "3" }], 250)), { status: 200 });
    return new Response("nope", { status: 404 });
  });
}

describe("konektor EcoAction", () => {
  let env: any;

  beforeEach(() => {
    env = makeSqlEnv(makeMigratedDb());
    env.ECOACTION_BLOB_SAS = "sp=rl&sig=test";
    env.sql.exec("INSERT INTO locations (id, address, district, fill_level, status, monthly_packages, created_at, updated_at, version) VALUES ('NET-011', 'Gliwice, ul. Jasna 2-4', 'Gliwice', 0, 'online', 0, 1, 1, 1)", []);
    vi.stubGlobal("fetch", mockBlobFetch());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ingest: transaction i total trafiają do stagingu; total bez mapowania NIE tworzy odbioru", async () => {
    const s = await syncEcoActionBlob(env);
    expect(s.errors).toEqual([]);
    expect(s.staged).toBe(2);
    expect(s.materialized).toBe(0);
    const rows = env.sql.query("SELECT message_type, packages, refund_grosze, collection_id FROM rvm_events ORDER BY id");
    expect(rows.length).toBe(2);
    const total = rows.find((r: any) => r.message_type === "total");
    expect(total.packages).toBe(5);
    expect(total.refund_grosze).toBe(250);
    expect(total.collection_id).toBeNull();
  });

  it("idempotencja: drugi sync niczego nie dubluje", async () => {
    await syncEcoActionBlob(env);
    const s2 = await syncEcoActionBlob(env);
    expect(s2.staged).toBe(0);
    expect(s2.skippedKnown).toBe(2);
    expect(env.sql.query("SELECT id FROM rvm_events").length).toBe(2);
  });

  it("przypisanie maszyny materializuje zaległe totale do collections", async () => {
    await syncEcoActionBlob(env);
    const r = assignMachine(env, "M5052588", "NET-011");
    expect(r.ok).toBe(true);
    expect(r.materialized).toBe(1);
    const col = env.sql.query("SELECT point_id, packages, status FROM collections WHERE point_id = 'NET-011'");
    expect(col.length).toBe(1);
    expect(col[0].packages).toBe(5);
    expect(col[0].status).toBe("completed");
    // maszyna widoczna jako zmapowana, bez zaległości
    const m = listMachines(env).find((x: any) => x.serial === "M5052588");
    expect(m.point_id).toBe("NET-011");
    expect(m.pending_totals).toBe(0);
  });

  it("total z JUŻ zmapowanej maszyny materializuje się od razu przy syncu", async () => {
    assignMachine(env, "M5052588", "NET-011");
    const s = await syncEcoActionBlob(env);
    expect(s.materialized).toBe(1);
    expect(env.sql.query("SELECT id FROM collections WHERE point_id = 'NET-011'").length).toBe(1);
  });

  it("brak sekretu SAS = sync bezpiecznie pominięty", async () => {
    delete env.ECOACTION_BLOB_SAS;
    const s = await syncEcoActionBlob(env);
    expect(s.errors[0]).toContain("ECOACTION_BLOB_SAS");
    expect(s.staged).toBe(0);
  });
});

describe("wskaźnik zapełnienia (estymacja)", () => {
  let env: any;
  beforeEach(() => {
    env = makeSqlEnv(makeMigratedDb());
    env.ECOACTION_BLOB_SAS = "sp=rl&sig=test";
    env.sql.exec("INSERT INTO locations (id, address, district, fill_level, status, monthly_packages, created_at, updated_at, version) VALUES ('NET-011', 'Gliwice, ul. Jasna 2-4', 'Gliwice', 0, 'online', 0, 1, 1, 1)", []);
    vi.stubGlobal("fetch", mockBlobFetch());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("transakcje po ostatnim totalu podnoszą fill_level punktu; total zeruje", async () => {
    assignMachine(env, "M5052588", "NET-011", 10); // pojemność 10 szt.
    await syncEcoActionBlob(env);
    // transaction t1 (1 szt.) jest PO totalu (occurred_at t1 > total)? W mocku total ma
    // transactionEndDate identyczny — ustaw ręcznie chronologię: total wcześniej.
    env.sql.exec("UPDATE rvm_events SET occurred_at = 1000 WHERE message_type = 'total'", []);
    env.sql.exec("UPDATE rvm_events SET occurred_at = 2000 WHERE message_type = 'transaction'", []);
    const { updateEstimatedFill } = await import("../lib/ecoaction");
    const fill = updateEstimatedFill(env, "M5052588");
    expect(fill).toBe(10); // 1 szt. / 10 pojemności = 10%
    const loc = env.sql.query("SELECT fill_level FROM locations WHERE id = 'NET-011'")[0];
    expect(loc.fill_level).toBe(10);
  });
});
