// Deploy/cloudflare-prod — checklist C2: "manipulacja wpisem wykrywana przez weryfikację".
// Dowód: agent data_quality (lib/agents.ts) flaguje przerwanie hash chain po manipulacji
// (usunięcie wpisu ze środka łańcucha / podmiana entry_hash). Uwaga: agent sprawdza
// SPÓJNOŚĆ OGNIW (prev_hash(n) == entry_hash(n-1)), nie re-hashuje treści wpisu —
// cicha podmiana samej kwoty jest łapana wyłącznie przez sanity gross = net + vat.
import { describe, it, expect, beforeEach } from "vitest";
import { makeMigratedDb, makeSqlEnv } from "./helpers";
import { insertLedgerEntry } from "../lib/settlement";
import { agentDataQuality } from "../lib/agents";

function chainBreaks(env: any) {
  return agentDataQuality(env).findings.filter((f: any) => f.kind === "ledger_chain_break");
}

describe("hash chain (PROMPT 5) — detekcja manipulacji", () => {
  let env: any;

  beforeEach(async () => {
    env = makeSqlEnv(makeMigratedDb());
    const now = Date.now();
    env.sql.exec(
      "INSERT INTO settlement_cycles (id, label, period_start, period_end, status, created_at) VALUES (1, 'T-1', ?, ?, 'draft', ?)",
      [now - 86400000, now, now]
    );
    for (let i = 0; i < 4; i++) {
      await insertLedgerEntry(env, {
        cycleId: 1, entryType: "DRIVER_FEE", partyOrgId: null, direction: "credit",
        amountNet: 1000 + i, vatRate: 23, vatAmount: 230, amountGross: 1230 + i,
        author: "test", source: "test",
      });
    }
  });

  it("nienaruszony łańcuch: zero findingów", () => {
    expect(chainBreaks(env)).toHaveLength(0);
  });

  it("usunięcie wpisu ze środka łańcucha jest wykrywane", () => {
    const ids = env.sql.query<{ id: number }>("SELECT id FROM ledger_entries ORDER BY id");
    env.sql.exec("DELETE FROM ledger_entries WHERE id = ?", [ids[1].id]);
    expect(chainBreaks(env).length).toBeGreaterThan(0);
  });

  it("podmiana entry_hash (próba przepisania historii) jest wykrywana", () => {
    const ids = env.sql.query<{ id: number }>("SELECT id FROM ledger_entries ORDER BY id");
    env.sql.exec("UPDATE ledger_entries SET entry_hash = 'deadbeef' WHERE id = ?", [ids[1].id]);
    expect(chainBreaks(env).length).toBeGreaterThan(0);
  });

  it("manipulacja kwotą łamiąca gross=net+vat jest wykrywana przez sanity check", () => {
    const ids = env.sql.query<{ id: number }>("SELECT id FROM ledger_entries ORDER BY id");
    env.sql.exec("UPDATE ledger_entries SET amount_net = 999999 WHERE id = ?", [ids[2].id]);
    const math = agentDataQuality(env).findings.filter((f: any) => f.kind === "ledger_math_mismatch");
    expect(math.length).toBeGreaterThan(0);
  });
});
