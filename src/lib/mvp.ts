// PROMPT 18 — MVP mechanisms: settlement legs, driver evidence, bank evidence pack.

export function syncSettlementManifest(env: any, cycleId: number) {
  const cycle = env.sql.query<any>("SELECT id, label, status, period_start, period_end, approved_at, closed_at FROM settlement_cycles WHERE id = ?", [cycleId])[0];
  if (!cycle) return { error: "cycle_not_found", groups: 0, legs: 0 };
  const entries = env.sql.query<any>(
    "SELECT id, entry_type, party_org_id, direction, amount_net, location_id, event_date, operational_date, booking_date, reversal_of_id, created_at FROM ledger_entries WHERE cycle_id = ? ORDER BY id",
    [cycleId]
  );
  const now = Date.now();
  const groupIds = new Set<string>();
  let inserted = 0;
  for (const e of entries) {
    const loc = e.location_id || "UNSCOPED";
    const groupId = `cycle:${cycleId}:location:${loc}`;
    const businessRef = `${cycle.label}:${loc}`;
    groupIds.add(groupId);
    env.sql.exec(
      "INSERT INTO settlement_groups (id, cycle_id, business_ref, location_id, status, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
      [groupId, cycleId, businessRef, e.location_id, now, now]
    );
    let status = "PENDING";
    if (e.reversal_of_id) status = "REVERSED";
    else if (e.entry_type === "DISPUTE_HOLD") status = "HELD";
    else if (cycle.status === "settled") status = "SETTLED";
    else if (["approved", "invoiced", "closed", "reconciled"].includes(cycle.status)) status = "ELIGIBLE";
    const idem = `settlement-leg:ledger:${e.id}`;
    const result = env.sql.exec(
      "INSERT INTO settlement_legs (group_id, ledger_entry_id, party_org_id, leg_type, direction, amount_net, status, idempotency_key, effective_at, recorded_at, settled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ledger_entry_id) DO UPDATE SET status = excluded.status, settled_at = excluded.settled_at",
      [groupId, e.id, e.party_org_id, e.entry_type, e.direction, e.amount_net, status, idem, e.event_date ?? e.operational_date ?? e.booking_date, e.created_at, status === "SETTLED" ? (cycle.closed_at ?? now) : null, now]
    );
    inserted += Number(result.rowsWritten || 0);
  }
  for (const groupId of groupIds) {
    const states = env.sql.query<{ status: string }>("SELECT status FROM settlement_legs WHERE group_id = ?", [groupId]).map(r => r.status);
    const uniq = new Set(states);
    let groupStatus = "PENDING";
    if (uniq.size === 1 && uniq.has("SETTLED")) groupStatus = "SETTLED";
    else if (uniq.size === 1 && uniq.has("ELIGIBLE")) groupStatus = "ELIGIBLE";
    else if (uniq.size === 1 && uniq.has("REVERSED")) groupStatus = "REVERSED";
    else if (uniq.has("HELD")) groupStatus = "HELD";
    else if (uniq.size > 1) groupStatus = "PARTIALLY_SETTLED";
    env.sql.exec("UPDATE settlement_groups SET status = ?, finalized_at = ?, updated_at = ? WHERE id = ?", [groupStatus, groupStatus === "SETTLED" ? (cycle.closed_at ?? now) : null, now, groupId]);
  }
  return { cycle, groups: groupIds.size, legs: entries.length, inserted };
}

export function getSettlementManifest(env: any, cycleId: number) {
  const sync = syncSettlementManifest(env, cycleId);
  if ((sync as any).error) return sync;
  const groups = env.sql.query<any>(
    "SELECT g.*, COUNT(l.id) AS leg_count, SUM(CASE WHEN l.status='HELD' THEN l.amount_net ELSE 0 END) AS held_net, SUM(CASE WHEN l.status='SETTLED' THEN l.amount_net ELSE 0 END) AS settled_net, SUM(l.amount_net) AS total_net FROM settlement_groups g LEFT JOIN settlement_legs l ON l.group_id=g.id WHERE g.cycle_id=? GROUP BY g.id ORDER BY g.location_id",
    [cycleId]
  );
  const legs = env.sql.query<any>(
    "SELECT l.*, o.name AS party_name FROM settlement_legs l LEFT JOIN organizations o ON o.id=l.party_org_id JOIN settlement_groups g ON g.id=l.group_id WHERE g.cycle_id=? ORDER BY l.group_id,l.id",
    [cycleId]
  );
  return { ...(sync as any), groups, legs };
}

async function sha256(text: string) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function bankDataRoomPackage(env: any) {
  const generatedAt = Date.now();
  const points = env.sql.query<any>("SELECT id,address,district,status,fill_level,last_collection_at,investor_org_id FROM locations WHERE deleted_at IS NULL AND id NOT LIKE 'SYN-%' ORDER BY id");
  const cycles = env.sql.query<any>("SELECT id,label,status,period_start,period_end,approved_at,closed_at FROM settlement_cycles ORDER BY period_end DESC LIMIT 24");
  const ledger = env.sql.query<any>("SELECT COUNT(*) AS entries, COALESCE(SUM(amount_net),0) AS net, SUM(CASE WHEN entry_hash IS NULL THEN 1 ELSE 0 END) AS missing_hashes FROM ledger_entries")[0];
  const disputes = env.sql.query<any>("SELECT state,COUNT(*) AS n,COALESCE(SUM(disputed_amount_grosze),0) AS amount FROM disputes GROUP BY state");
  const telemetry = env.sql.query<any>("SELECT COUNT(*) AS heartbeats, COUNT(DISTINCT device_id) AS devices, MAX(ts) AS last_heartbeat FROM device_heartbeats")[0];
  const reconciliations = env.sql.query<any>("SELECT status,COUNT(*) AS n FROM reconciliations GROUP BY status");
  const pointMonths = points.length * Math.max(1, cycles.length);
  const completeCycles = cycles.filter((c: any) => ["reconciled","approved","settled","closed"].includes(c.status)).length;
  const payload: any = {
    schema: "edrs.bank-data-room.v1", generatedAt, informationalOnly: true, score: null,
    commercialModel: { pointMonthlyNetPln: 500, vehicleMonthlyNetPln: 220 },
    portfolio: { points: points.length, activePoints: points.filter((p: any) => p.status === "online").length, pointMonths },
    evidence: { cycles, ledger, disputes, telemetry, reconciliations, points },
    completeness: { cycleCompletionPct: cycles.length ? Math.round(completeCycles / cycles.length * 10000) / 100 : 0, missingLedgerHashes: Number(ledger?.missing_hashes || 0) },
    disclaimer: "Pakiet informacyjny. Nie stanowi ratingu, rekomendacji kredytowej ani gwarancji wyniku finansowego."
  };
  payload.sha256 = await sha256(JSON.stringify(payload));
  return payload;
}

export function recordDriverJobEvent(env: any, driverId: number, event: any) {
  const allowed = ["ACCEPTED","COMPLETED","FAILED","CORRECTED"];
  const reasons = ["BRAK_DOSTEPU","PUNKT_ZAMKNIETY","BRAK_MIEJSCA_W_POJEZDZIE","AWARIA_POJAZDU","CZAS_PRACY","INNE"];
  if (!allowed.includes(event.action)) return { error: "invalid_action" };
  if (event.action === "FAILED" && !reasons.includes(event.reasonCode)) return { error: "invalid_reason_code" };
  const idem = String(event.clientEventId || "").trim();
  if (!idem) return { error: "missing_client_event_id" };
  const now = Date.now();
  const existing = env.sql.query<{ id: number }>("SELECT id FROM driver_job_events WHERE idempotency_key=?", [idem]);
  if (existing.length) return { ok: true, duplicate: true, id: existing[0].id };
  env.sql.exec(
    "INSERT INTO driver_job_events (point_id,driver_id,action,reason_code,notes,evidence_json,gps_lat,gps_lng,occurred_at,recorded_at,idempotency_key,sync_source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [event.pointId,driverId,event.action,event.reasonCode||null,event.notes||null,event.evidence ? JSON.stringify(event.evidence) : null,event.gpsLat??null,event.gpsLng??null,Number(event.occurredAt||now),now,idem,event.syncSource||"online",now]
  );
  const id = Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
  return { ok: true, id };
}
