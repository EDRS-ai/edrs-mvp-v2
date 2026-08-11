// PROMPT 7 (Realtime) — Server-Sent Events tail over `event_log`.
//
// Design: micro-burst SSE. Each connection does ONE query of `event_log` since
// the cursor, emits the rows as SSE frames, emits `: hb` heartbeat, then closes.
// The browser's EventSource reconnect (driven by the `retry:` directive) carries
// `Last-Event-ID` from the previous burst and we resume from there. This pattern
// is mandatory here because the runtime bans `setTimeout` / `setInterval`
// (see `references/handler-runtime.md` in the Sauna apps skill).
//
// Cursor transport: the SSE `id:` field carries `event_log.id` (PK), not
// `created_at`. Batch INSERTs (e.g. `insertLedgerEntriesBatch`, `logEvent`
// loops in handler.ts) share a millisecond, so a `since=<ts>` cursor would
// either drop or duplicate rows. We keep `?since=<ms>` for the bootstrap/curl
// path (resolved once server-side to a PK) and accept `Last-Event-ID` and
// `?sinceId=<id>` as authoritative.
//
// Uses `env.sql` (synchronous) for the same reason every other route in
// handler.ts does: a mixed SQLite/Postgres tail would stream an empty table
// the moment Neon is wired in. Unifying this is a PROMPT 8-sized task.

export type Category = "location" | "cycle" | "dispute";

// Map event_type → strumieniowana kategoria. Nieznane typy pomijamy
// (trafiają do logu ale nie na mapę).
const CATEGORY: Record<string, Category> = {
  // location
  "location.fill_changed": "location",
  "location.status_changed": "location",
  "location.collected": "location",
  "pickup.completed": "location",
  "session.closed": "location",
  // cycle
  "cycle.credit_posted": "cycle",
  "operator.receipt": "cycle",
  "settlement_engine_run": "cycle",
  "cycle_created": "cycle",
  "cycle_closed": "cycle",
  "cycle_approved": "cycle",
  // dispute
  "dispute_created": "dispute",
  "dispute_state_transition": "dispute",
  "dispute_default_action": "dispute",
  "dispute_hold_executed": "dispute",
  "ticket_opened": "dispute",
  "ticket_resolved": "dispute",
};
export const KNOWN_TYPES = Object.keys(CATEGORY);
export function categoryOf(t: string): Category | null {
  return CATEGORY[t] ?? null;
}

// INSERT do event_log — pełny shim logEvent() z handlera tak, że endpointy
// emitujące nowe typy nie muszą importować wewnętrznego helpera.
export function emitEvent(env: any, ev: {
  eventType: string;
  pointId?: string | null;
  cycleId?: number | null;
  payload?: any;
  actorId?: number | null;
}) {
  env.sql.exec(
    "INSERT INTO event_log (cycle_id, point_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      ev.cycleId ?? null,
      ev.pointId ?? null,
      ev.eventType,
      ev.payload ? JSON.stringify(ev.payload) : null,
      ev.actorId ?? null,
      Date.now(),
    ]
  );
}

// Emisja pełnego snapshota punktu — klient nie musi dociągać nic po REST.
export function emitLocationUpdate(env: any, locationId: string, extra?: any) {
  const rows = env.sql.query<any>(
    "SELECT id, fill_level, status, last_collection_at FROM locations WHERE id = ? LIMIT 1",
    [locationId]
  );
  if (!rows[0]) {
    // C3: points.id (NET-xxx) ≠ locations.id (SL-xxx/SYN-xxx). Bez warn ta ścieżka
    // padała cicho — teraz widoczna w app_logs.
    console.warn("[emitLocationUpdate] no location row for id:", locationId);
    return;
  }
  const r = rows[0];
  emitEvent(env, {
    eventType: "location.fill_changed",
    pointId: r.id,
    payload: {
      fillPct: r.fill_level,
      status: r.status,
      lastCollectionAt: r.last_collection_at,
      ...(extra ?? {}),
    },
  });
}

// Rozwiązanie cursora z 4 źródeł. Precedence:
//   Last-Event-ID > ?sinceId > ?since (z timestamp lookup) > MAX(id)
export function resolveCursor(
  env: any,
  opts: { lastEventId?: string | null; sinceId?: string | null; since?: string | null }
): number {
  const fromHeader =
    opts.lastEventId && /^\d+$/.test(opts.lastEventId) ? Number(opts.lastEventId) : null;
  if (fromHeader !== null) return fromHeader;

  if (opts.sinceId && /^\d+$/.test(opts.sinceId)) return Number(opts.sinceId);

  if (opts.since && /^\d+$/.test(opts.since)) {
    const r = env.sql.query<{ id: number | null }>(
      "SELECT MIN(id) AS id FROM event_log WHERE created_at >= ?",
      [Number(opts.since)]
    );
    const id = r[0]?.id;
    // M1: brak dopasowania (future/empty since) → fall through do MAX(id),
    // nie 0 (0 = replay najstarszych 500 eventów).
    if (id !== null && id !== undefined) return Number(id) - 1;
  }

  const max = env.sql.query<{ id: number | null }>(
    "SELECT MAX(id) AS id FROM event_log"
  )[0]?.id;
  return max === null || max === undefined ? 0 : Number(max);
}

// Tailing query: WHERE id > ? AND event_type IN (...) ORDER BY id ASC LIMIT 500.
// PK range scan, O(result), niezależne od rozmiaru tabeli (indeks event_log_pk).
export function queryEvents(env: any, cursor: number, cats: Category[], limit: number) {
  const types = KNOWN_TYPES.filter((t) => cats.includes(CATEGORY[t]));
  if (types.length === 0) return [] as any[];
  const ph = types.map(() => "?").join(",");
  return env.sql.query<any>(
    `SELECT id, cycle_id, point_id, event_type, payload_json, created_at
       FROM event_log WHERE id > ? AND event_type IN (${ph})
       ORDER BY id ASC LIMIT ?`,
    [cursor, ...types, Math.min(Math.max(limit, 1), 500)]
  );
}

// Replay ostatnich N zdarzeń (DESC + reverse) — tryb dev / demo.
export function queryReplay(env: any, cats: Category[], n: number) {
  const types = KNOWN_TYPES.filter((t) => cats.includes(CATEGORY[t]));
  if (types.length === 0) return [] as any[];
  const ph = types.map(() => "?").join(",");
  const rows = env.sql.query<any>(
    `SELECT id, cycle_id, point_id, event_type, payload_json, created_at
       FROM event_log WHERE event_type IN (${ph})
       ORDER BY id DESC LIMIT ?`,
    [...types, Math.min(Math.max(n, 1), 500)]
  );
  return rows.reverse();
}

function toClient(row: any) {
  let payload: any = null;
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : null;
  } catch {
    payload = { raw: row.payload_json };
  }
  return {
    id: Number(row.id),
    cat: categoryOf(row.event_type),
    type: row.event_type,
    pointId: row.point_id ?? null,
    cycleId: row.cycle_id ?? null,
    ts: Number(row.created_at),
    payload,
  };
}

export function parseCats(typeParam: string | null | undefined): Category[] {
  const raw = (typeParam ?? "all").toLowerCase();
  if (raw === "all" || raw === "all_events") return ["location", "cycle", "dispute"];
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Category => s === "location" || s === "cycle" || s === "dispute");
  return out.length ? out : ["location", "cycle", "dispute"];
}

// Retry directive mówi EventSource ile ms czekać przed reconnectem.
// MAX_TICKS * TICK_MS = ~30 s — po tym stream się zamyka, browser sam się reconnectuje.
const RETRY_MS = 3000;
const TICK_MS = 1500;
const MAX_TICKS = 20;

export function buildEventStream(
  env: any,
  opts: { cursor: number; cats: Category[]; replay: number }
): Response {
  const enc = new TextEncoder();
  // H4: `closed` hoisted poza start() żeby cancel() (client disconnect) mógł
  // przerwać tail loop — bez tego abandoned tab odpytywał event_log do MAX_TICKS.
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      let cursor = opts.cursor;

      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const frame = (row: any) => {
        const c = toClient(row);
        write(`id: ${c.id}\nevent: ${c.cat}\ndata: ${JSON.stringify(c)}\n\n`);
        cursor = c.id;
      };

      try {
        write(`retry: ${RETRY_MS}\n\n`);

        // Replay burst (dev mode).
        if (opts.replay > 0) {
          const replayRows = queryReplay(env, opts.cats, opts.replay);
          for (const r of replayRows) frame(r);
          write(`event: replay_done\ndata: {"count":${replayRows.length}}\n\n`);
        }

        // Tail pętla. Feature-detected: jeśli `scheduler.wait` jest dostępny
        // (Cloudflare Workers sanctioned awaitable), trzymamy stream otwarty
        // do MAX_TICKS; bez niego robimy jeden burst i kończymy (browser i tak
        // reconnectuje po RETRY_MS, więc poprawność nie zależy od scheduler).
        let ticks = 0;
        const canWait =
          typeof (globalThis as any).scheduler?.wait === "function";
        do {
          const rows = queryEvents(env, cursor, opts.cats, 500);
          for (const r of rows) frame(r);
          write(`: hb ${Date.now()} cursor=${cursor}\n\n`);
          if (!canWait || closed) break;
          await (globalThis as any).scheduler.wait(TICK_MS);
          ticks++;
        } while (ticks < MAX_TICKS && !closed);
      } catch (e: any) {
        console.error("[sse] stream error", e?.message ?? String(e));
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      // Anti-buffering proxy header — bez tego CF/Cloudflare CDN buforuje cały response.
      "x-accel-buffering": "no",
    },
  });
}

// Snapshot mapy — kompaktowe tablice (2000 pkt ≈ 120 KB zamiast ~600 KB obiektów).
// Zwracamy też aktualny event_log.id jako cursor, żeby klient po pierwszej
// dacie SSE zaczął od tego samego momentu bez luki.
export function mapSnapshot(env: any) {
  const rows = env.sql.query<any>(
    "SELECT id, address, district, lat, lng, fill_level, status, last_collection_at " +
      "FROM locations WHERE deleted_at IS NULL AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY id"
  );
  const cursor = Number(
    env.sql.query<{ id: number | null }>("SELECT MAX(id) AS id FROM event_log")[0]?.id ?? 0
  );
  return {
    cursor,
    cols: ["id", "lat", "lng", "fill", "status", "lastCollectionAt", "address", "district"],
    points: rows.map((r: any) => [
      r.id,
      r.lat,
      r.lng,
      r.fill_level,
      r.status,
      r.last_collection_at,
      r.address,
      r.district ?? "",
    ]),
  };
}
