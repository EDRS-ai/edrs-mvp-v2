import { generateMonthlyCharges } from "./finance";
// PROMPT 8 — Agenci wewnętrzni (automatyzacja czasu rzeczywistego, zero LLM w pętli).
//
// Trzy agenty deterministyczne uruchamiane z onSchedule (cron co godzinę) oraz
// ręcznie przez POST /api/admin/agents/run (master, demo/debug):
//
//   1. health_check   — wykrywa punkty przepełnione i zaniedbane (fill >= 95 i brak
//                       odbioru > 48 h) → status 'alert' + event location.status_changed;
//                       urządzenia bez heartbeat > 24 h → devices.status = 'offline'.
//   2. data_quality   — integralność referencyjna (collections/event_log wskazujące
//                       nieistniejące lokalizacje) + weryfikacja hash chain ledgera
//                       (ISO 27001 A.8.15/A.8.16: integralność i monitoring logów).
//   3. dispute_deadline — spory po terminie due_at bez reakcji → automatyczne
//                       zastrzeżenie (default action, wzorzec Square) + event.
//
// Zasady:
//   - IDEMPOTENCJA: każdy run ma idempotency_key `agent:{name}:{bucket}` w event_log
//     (bucket = godzina). Retry crona / ręczny run w tej samej godzinie = no-op.
//   - Wyniki są AUDYTOWALNE: każdy run zapisuje event `agent.run_completed`
//     z payloadem findings (kto: source='agent:{name}', co, kiedy).
//   - Stan w meta: agent:{name}:last_run + agent:{name}:last_findings.
//   - Agent NIE wysyła nic na zewnątrz (zasada: brak autonomicznych wysyłek).

export type AgentFinding = { kind: string; ref?: string; detail?: string };
export type AgentResult = {
  agent: string;
  ranAt: number;
  skipped?: boolean;
  findings: AgentFinding[];
  actions: number;
};

const STALE_COLLECTION_MS = 48 * 3600 * 1000;
const STALE_HEARTBEAT_MS = 24 * 3600 * 1000;
const HASH_CHAIN_SAMPLE = 200;

function setMeta(env: any, key: string, value: string) {
  env.sql.exec(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

// Zapis wyniku runa do event_log z kluczem idempotencji per godzina.
// Zwraca false gdy run w tym buckecie już był (idempotency hit).
function recordRun(env: any, name: string, result: AgentResult, bucket: string): boolean {
  try {
    env.sql.exec(
      "INSERT INTO event_log (event_type, idempotency_key, payload_json, source, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "agent.run_completed",
        `agent:${name}:${bucket}`,
        JSON.stringify({ agent: name, findings: result.findings.slice(0, 50), findingCount: result.findings.length, actions: result.actions }),
        `agent:${name}`,
        result.ranAt,
        result.ranAt,
      ]
    );
  } catch (e: any) {
    if (String(e?.message ?? e).includes("UNIQUE")) return false;
    throw e;
  }
  setMeta(env, `agent:${name}:last_run`, String(result.ranAt));
  setMeta(env, `agent:${name}:last_findings`, String(result.findings.length));
  return true;
}

// ── Agent 1: health check ────────────────────────────────────────────────────
export function agentHealthCheck(env: any, now = Date.now()): AgentResult {
  const findings: AgentFinding[] = [];
  let actions = 0;

  // Punkty przepełnione i zaniedbane: fill >= 95, brak odbioru > 48 h, status != alert.
  const neglected = env.sql.query<any>(
    `SELECT id, fill_level, last_collection_at FROM locations
      WHERE deleted_at IS NULL AND fill_level >= 95 AND status != 'alert'
        AND (last_collection_at IS NULL OR last_collection_at < ?)
      LIMIT 100`,
    [now - STALE_COLLECTION_MS]
  );
  for (const l of neglected) {
    env.sql.exec("UPDATE locations SET status = 'alert', updated_at = ? WHERE id = ?", [now, l.id]);
    env.sql.exec(
      "INSERT INTO event_log (point_id, event_type, payload_json, source, created_at) VALUES (?, ?, ?, ?, ?)",
      [l.id, "location.status_changed", JSON.stringify({ status: "alert", fillPct: l.fill_level, reason: "agent:health_check przepełnienie bez odbioru > 48h" }), "agent:health_check", now]
    );
    findings.push({ kind: "location_neglected", ref: l.id, detail: `fill=${l.fill_level}%` });
    actions++;
  }

  // Punkty w 'alert', które ktoś już opróżnił (fill < 70) → powrót do 'online'.
  const recovered = env.sql.query<any>(
    "SELECT id, fill_level FROM locations WHERE deleted_at IS NULL AND status = 'alert' AND fill_level < 70 LIMIT 100"
  );
  for (const l of recovered) {
    env.sql.exec("UPDATE locations SET status = 'online', updated_at = ? WHERE id = ?", [now, l.id]);
    env.sql.exec(
      "INSERT INTO event_log (point_id, event_type, payload_json, source, created_at) VALUES (?, ?, ?, ?, ?)",
      [l.id, "location.status_changed", JSON.stringify({ status: "online", fillPct: l.fill_level, reason: "agent:health_check odzyskany po odbiorze" }), "agent:health_check", now]
    );
    findings.push({ kind: "location_recovered", ref: l.id });
    actions++;
  }

  // Urządzenia bez heartbeat > 24 h → offline (tylko te, które kiedykolwiek raportowały).
  const staleDevices = env.sql.query<any>(
    `SELECT d.id, MAX(h.ts) AS last_hb FROM devices d
       JOIN device_heartbeats h ON h.device_id = d.id
      WHERE d.deleted_at IS NULL AND d.status = 'active'
      GROUP BY d.id HAVING last_hb < ? LIMIT 100`,
    [now - STALE_HEARTBEAT_MS]
  );
  for (const d of staleDevices) {
    env.sql.exec("UPDATE devices SET status = 'offline', updated_at = ? WHERE id = ?", [now, d.id]);
    findings.push({ kind: "device_offline", ref: d.id, detail: `last_hb=${d.last_hb}` });
    actions++;
  }

  return { agent: "health_check", ranAt: now, findings, actions };
}

// ── Agent 2: data quality / integralność (ISO-ready) ────────────────────────
export function agentDataQuality(env: any, now = Date.now()): AgentResult {
  const findings: AgentFinding[] = [];

  // Sieroty: collections wskazujące punkt bez wiersza w locations (po unifikacji nie powinno być żadnych).
  const orphanCollections = env.sql.query<{ point_id: string; n: number }>(
    `SELECT c.point_id, COUNT(*) AS n FROM collections c
      LEFT JOIN locations l ON l.id = c.point_id
      WHERE l.id IS NULL GROUP BY c.point_id LIMIT 20`
  );
  for (const o of orphanCollections) findings.push({ kind: "orphan_collection_point", ref: o.point_id, detail: `${o.n} odbiorów` });

  // Sieroty w event_log (point_id bez lokalizacji) — tylko typy mapowe.
  const orphanEvents = env.sql.query<{ point_id: string; n: number }>(
    `SELECT e.point_id, COUNT(*) AS n FROM event_log e
      LEFT JOIN locations l ON l.id = e.point_id
      WHERE e.point_id IS NOT NULL AND l.id IS NULL AND e.event_type LIKE 'location.%'
      GROUP BY e.point_id LIMIT 20`
  );
  for (const o of orphanEvents) findings.push({ kind: "orphan_event_point", ref: o.point_id, detail: `${o.n} eventów` });

  // Weryfikacja hash chain ledgera: ostatnie N wpisów — prev_hash(n) musi być równy
  // entry_hash(n-1) w obrębie cyklu (pomijamy BACKFILL i GENESIS).
  const entries = env.sql.query<any>(
    `SELECT id, cycle_id, prev_hash, entry_hash FROM ledger_entries
      WHERE entry_hash IS NOT NULL AND entry_hash != 'BACKFILL'
      ORDER BY cycle_id, id LIMIT ?`,
    [HASH_CHAIN_SAMPLE]
  );
  let prevByCycle: Record<string, string> = {};
  for (const e of entries) {
    const key = String(e.cycle_id);
    const expected = prevByCycle[key];
    if (expected !== undefined && e.prev_hash !== expected) {
      findings.push({ kind: "ledger_chain_break", ref: `entry:${e.id}`, detail: `cycle=${e.cycle_id}` });
    }
    prevByCycle[key] = e.entry_hash;
  }

  // Ledger: wpisy z ujemnym VAT lub gross != net + vat (sanity arytmetyki).
  const badMath = env.sql.query<{ id: number }>(
    "SELECT id FROM ledger_entries WHERE amount_gross != amount_net + vat_amount LIMIT 20"
  );
  for (const b of badMath) findings.push({ kind: "ledger_math_mismatch", ref: `entry:${b.id}` });

  return { agent: "data_quality", ranAt: now, findings, actions: 0 };
}

// ── Agent 3: dispute deadlines (default action po terminie) ─────────────────
export function agentDisputeDeadline(env: any, now = Date.now()): AgentResult {
  const findings: AgentFinding[] = [];
  let actions = 0;

  const overdue = env.sql.query<any>(
    `SELECT d.id, d.state, d.due_at, r.scope_ref FROM disputes d
      JOIN reconciliations r ON r.id = d.reconciliation_id
      WHERE d.due_at < ? AND d.default_action_taken = 0
        AND d.state NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')
      LIMIT 50`,
    [now]
  );
  for (const d of overdue) {
    const nextState = d.state.startsWith("INQUIRY") ? "EVIDENCE_REQUIRED" : "PROCESSING";
    env.sql.exec(
      "UPDATE disputes SET state = ?, default_action_taken = 1, updated_at = ? WHERE id = ?",
      [nextState, now, d.id]
    );
    env.sql.exec(
      "INSERT INTO event_log (point_id, event_type, payload_json, source, created_at) VALUES (?, ?, ?, ?, ?)",
      [d.scope_ref ?? null, "dispute_default_action", JSON.stringify({ disputeId: d.id, from: d.state, to: nextState, reason: "agent:dispute_deadline termin minął bez reakcji" }), "agent:dispute_deadline", now]
    );
    findings.push({ kind: "dispute_defaulted", ref: `dispute:${d.id}`, detail: `${d.state} → ${nextState}` });
    actions++;
  }

  return { agent: "dispute_deadline", ranAt: now, findings, actions };
}

// ── Agent 4: naliczenia miesięczne (PROMPT 9) ────────────────────────────
async function agentMonthlyCharges(env: any, now = Date.now()): Promise<AgentResult> {
  const findings: AgentFinding[] = [];
  const r = await generateMonthlyCharges(env);
  if (r.created > 0) findings.push({ kind: "charges_generated", detail: `${r.created} naliczen, cykl ${r.cycleId}` });
  return { agent: "monthly_charges", ranAt: now, findings, actions: r.created };
}

// ── Orkiestracja ───────────────────────────────────────────────────────
export async function runAllAgents(env: any, opts?: { force?: boolean }): Promise<{ results: AgentResult[]; bucket: string }> {
  const now = Date.now();
  // Bucket godzinowy dla idempotencji crona; force (ręczny run) używa unikalnego bucketa.
  const bucket = opts?.force ? `manual:${now}` : new Date(now).toISOString().slice(0, 13);
  const results: AgentResult[] = [];
  const agents: Array<(e: any, n: number) => AgentResult | Promise<AgentResult>> = [
    agentHealthCheck,
    agentDataQuality,
    agentDisputeDeadline,
    agentMonthlyCharges,
  ];
  for (const fn of agents) {
    try {
      const r = await fn(env, now);
      const recorded = recordRun(env, r.agent, r, bucket);
      if (!recorded) r.skipped = true;
      results.push(r);
    } catch (e: any) {
      console.error(`[agent] ${fn.name} failed:`, e?.message ?? String(e));
      results.push({ agent: fn.name, ranAt: now, findings: [{ kind: "agent_error", detail: String(e?.message ?? e) }], actions: 0 });
    }
  }
  console.log(
    `AGENTS_DONE bucket=${bucket} ` +
      results.map((r) => `${r.agent}:${r.skipped ? "skip" : `${r.findings.length}f/${r.actions}a`}`).join(" ")
  );
  return { results, bucket };
}
