// Konektor EcoAction 3.0 → edrs.io (Azure Blob Storage, kontener net4zero-reports).
//
// Kontrakt danych (ustalony w wątku z Grzegorzem Kąkozwą / Danielem Galwasem, 08.2026):
//   {maszyna}/{YYYY-MM-DD}/{plik}.json
//   - messageType "transaction": jedna transakcja klienta (voucher + items z EAN)
//   - messageType "total":       opróżnienie maszyny (suma opakowań, kwota kaucji, bagId/sealNumber)
//   Pliki nadpisywalne, retencja ~7 dni, brak notyfikacji → cykliczny polling (nasz cron).
//
// Architektura ingestu:
//   1. syncEcoActionBlob: listing kontenera (SAS read+list z env.ECOACTION_BLOB_SAS,
//      sekret wranglera — NIGDY w repo) → pobranie plików nieznanych → staging rvm_events
//      (idempotencja po UNIQUE message_id: ponowny odczyt tego samego pliku = no-op).
//   2. Materializacja: "total" z maszyny ZMAPOWANEJ na punkt (machine_map) staje się
//      wierszem collections (źródło A rekoncyliacji trzech źródeł). Maszyny bez
//      mapowania czekają w stagingu — przypisanie w panelu (zakładka Maszyny)
//      materializuje zaległe totale wstecznie.
//
// Skala: pełny listing z paginacją NextMarker; limit plików na jeden przebieg
// ogranicza czas crona. Przy 250+ maszynach przejść na listing per prefix dnia.

const BLOB_BASE = "https://ecoactionstorage.blob.core.windows.net/net4zero-reports";
const SYSTEM_DRIVER_NAME = "EcoAction RVM (auto)";

export function ensureEcoActionTables(env: any) {
  env.sql.exec(`CREATE TABLE IF NOT EXISTS rvm_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    machine_serial TEXT NOT NULL,
    message_type TEXT NOT NULL,
    blob_path TEXT NOT NULL,
    occurred_at INTEGER,
    packages INTEGER,
    refund_grosze INTEGER,
    payload_json TEXT NOT NULL,
    point_id TEXT,
    collection_id INTEGER,
    ingested_at INTEGER NOT NULL
  )`, []);
  env.sql.exec("CREATE INDEX IF NOT EXISTS rvm_events_serial_idx ON rvm_events(machine_serial)", []);
  env.sql.exec("CREATE INDEX IF NOT EXISTS rvm_events_type_idx ON rvm_events(message_type)", []);
  env.sql.exec(`CREATE TABLE IF NOT EXISTS machine_map (
    serial TEXT PRIMARY KEY,
    point_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`, []);
}

// Listing kontenera z paginacją. Zwraca ścieżki blobów (nazwy plików .json).
async function listBlobs(sas: string, maxPages = 10): Promise<string[]> {
  const names: string[] = [];
  let marker = "";
  for (let page = 0; page < maxPages; page++) {
    const url = `${BLOB_BASE}?restype=container&comp=list&${sas}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`blob listing HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) names.push(m[1]);
    const nm = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml);
    if (!nm) break;
    marker = nm[1];
  }
  return names;
}

function parseRvmJson(raw: any, blobPath: string) {
  const header = raw?.data?.header ?? {};
  const d = raw?.data?.data ?? {};
  const voucher = d?.voucher ?? {};
  const items: any[] = Array.isArray(voucher.items) ? voucher.items : [];
  let packages = 0;
  for (const it of items) packages += Number(it.count ?? 0) || 0;
  const occurred = voucher.transactionEndDate ?? header.sentAt ?? null;
  return {
    messageId: String(header.messageId ?? blobPath),
    messageType: String(header.messageType ?? "unknown"),
    serial: String(d?.machine?.serial ?? blobPath.split("/")[0] ?? "?"),
    occurredAt: occurred ? Date.parse(occurred) : null,
    packages,
    refundGrosze: Number(voucher.refundAmount ?? 0) || 0,
  };
}

function systemDriverId(env: any): number {
  const r = env.sql.query<{ id: number }>("SELECT id FROM drivers WHERE name = ? LIMIT 1", [SYSTEM_DRIVER_NAME]);
  if (r.length > 0) return r[0].id;
  env.sql.exec(
    "INSERT INTO drivers (name, type, company, status, created_at) VALUES (?, 'firma', 'EcoAction', 'active', ?)",
    [SYSTEM_DRIVER_NAME, Date.now()]
  );
  return Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}

// "total" → collections (źródło A). Zwraca id collection.
function materializeTotal(env: any, ev: { id: number; packages: number; occurred_at: number | null; ingested_at: number }, pointId: string): number {
  const driverId = systemDriverId(env);
  const when = ev.occurred_at ?? ev.ingested_at;
  env.sql.exec(
    "INSERT INTO collections (point_id, driver_id, status, packages, collected_at, created_at) VALUES (?, ?, 'completed', ?, ?, ?)",
    [pointId, driverId, ev.packages, when, Date.now()]
  );
  const cid = Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
  env.sql.exec("UPDATE rvm_events SET point_id = ?, collection_id = ? WHERE id = ?", [pointId, cid, ev.id]);
  env.sql.exec("UPDATE locations SET last_collection_at = ?, fill_level = 0, updated_at = ? WHERE id = ?", [when, Date.now(), pointId]);
  return cid;
}

// Główny sync — wołany z crona (scheduled) i ręcznie z panelu.
export async function syncEcoActionBlob(env: any, opts?: { maxFiles?: number }): Promise<{
  listed: number; fetched: number; staged: number; materialized: number; skippedKnown: number; errors: string[];
}> {
  const sas = env.ECOACTION_BLOB_SAS;
  const stats = { listed: 0, fetched: 0, staged: 0, materialized: 0, skippedKnown: 0, errors: [] as string[] };
  if (!sas) { stats.errors.push("Brak sekretu ECOACTION_BLOB_SAS — sync pominięty"); return stats; }
  ensureEcoActionTables(env);
  const maxFiles = opts?.maxFiles ?? 200;

  const names = (await listBlobs(sas)).filter((n) => n.endsWith(".json"));
  stats.listed = names.length;

  // Znane blob_path → pomiń bez pobierania (pliki są nadpisywalne, ale messageId
  // jest stały per plik, więc ponowny upload tej samej nazwy niczego nie zmienia).
  const known = new Set(env.sql.query<{ blob_path: string }>("SELECT blob_path FROM rvm_events").map((r: any) => r.blob_path));
  const mapRows = env.sql.query<{ serial: string; point_id: string }>("SELECT serial, point_id FROM machine_map");
  const mapping = new Map(mapRows.map((r: any) => [r.serial, r.point_id]));

  for (const path of names) {
    if (known.has(path)) { stats.skippedKnown++; continue; }
    if (stats.fetched >= maxFiles) break;
    try {
      const res = await fetch(`${BLOB_BASE}/${path.split("/").map(encodeURIComponent).join("/")}?${sas}`);
      if (!res.ok) { stats.errors.push(`${path}: HTTP ${res.status}`); continue; }
      const raw = await res.json();
      stats.fetched++;
      const p = parseRvmJson(raw, path);
      const now = Date.now();
      const dup = env.sql.query<{ id: number }>("SELECT id FROM rvm_events WHERE message_id = ? LIMIT 1", [p.messageId]);
      if (dup.length > 0) { stats.skippedKnown++; continue; }
      env.sql.exec(
        "INSERT INTO rvm_events (message_id, machine_serial, message_type, blob_path, occurred_at, packages, refund_grosze, payload_json, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [p.messageId, p.serial, p.messageType, path, p.occurredAt, p.packages, p.refundGrosze, JSON.stringify(raw).slice(0, 100000), now]
      );
      stats.staged++;
      const evId = Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
      const pointId = mapping.get(p.serial);
      if (p.messageType === "total" && pointId) {
        materializeTotal(env, { id: evId, packages: p.packages, occurred_at: p.occurredAt, ingested_at: now }, pointId);
        stats.materialized++;
      }
    } catch (e: any) {
      stats.errors.push(`${path}: ${e?.message ?? String(e)}`);
    }
  }

  env.sql.exec(
    "INSERT INTO event_log (event_type, payload_json, source, created_at) VALUES ('ecoaction.sync_completed', ?, 'ecoaction_sync', ?)",
    [JSON.stringify(stats).slice(0, 4000), Date.now()]
  );
  return stats;
}

// Przypisanie maszyny do punktu + wsteczna materializacja zaległych totali.
export function assignMachine(env: any, serial: string, pointId: string): { ok: boolean; error?: string; materialized?: number } {
  ensureEcoActionTables(env);
  const loc = env.sql.query<{ id: string }>("SELECT id FROM locations WHERE id = ? AND deleted_at IS NULL", [pointId]);
  if (loc.length === 0) return { ok: false, error: "Punkt nie istnieje" };
  env.sql.exec(
    "INSERT INTO machine_map (serial, point_id, created_at) VALUES (?, ?, ?) ON CONFLICT(serial) DO UPDATE SET point_id = excluded.point_id",
    [serial, pointId, Date.now()]
  );
  const pending = env.sql.query<any>(
    "SELECT id, packages, occurred_at, ingested_at FROM rvm_events WHERE machine_serial = ? AND message_type = 'total' AND collection_id IS NULL",
    [serial]
  );
  let materialized = 0;
  for (const ev of pending) { materializeTotal(env, ev, pointId); materialized++; }
  env.sql.exec(
    "INSERT INTO event_log (point_id, event_type, payload_json, source, created_at) VALUES (?, 'machine.assigned', ?, 'admin_ui', ?)",
    [pointId, JSON.stringify({ serial, pointId, materialized }), Date.now()]
  );
  return { ok: true, materialized };
}

// Widok dla panelu: maszyny widziane w stagingu + stan mapowania.
export function listMachines(env: any) {
  ensureEcoActionTables(env);
  return env.sql.query<any>(
    `SELECT e.machine_serial AS serial,
            COUNT(*) AS events,
            SUM(CASE WHEN e.message_type = 'total' THEN 1 ELSE 0 END) AS totals,
            SUM(CASE WHEN e.message_type = 'total' AND e.collection_id IS NULL THEN 1 ELSE 0 END) AS pending_totals,
            MAX(e.occurred_at) AS last_event_at,
            m.point_id
       FROM rvm_events e LEFT JOIN machine_map m ON m.serial = e.machine_serial
      GROUP BY e.machine_serial ORDER BY e.machine_serial`
  );
}
