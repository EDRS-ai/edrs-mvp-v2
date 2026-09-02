// Entrypoint produkcyjny — Cloudflare Workers (deploy/cloudflare-prod).
// Zastępuje runtime Sauny: cała aplikacja (Hono createApp) działa WEWNĄTRZ
// Durable Object "EdrsDatabase", bo kontrakt env.sql jest synchroniczny —
// jedyny synchroniczny storage na Workers to DO SQLite (ctx.storage.sql).
//
// - env.sql        → adapter na ctx.storage.sql (te same .exec/.query/.raw co u Sauny)
// - env.websocket  → no-op z logiem (broadcast live nie jest wymogiem pilotażu;
//                    UI działa przez SSE micro-burst + odświeżenie po akcji)
// - onSchedule     → standardowy handler scheduled() (cron z wrangler.jsonc)
// - migracje       → migrations/*.sql aplikowane przy pierwszym starcie DO
// - jurysdykcja    → DO tworzony w jurysdykcji EU (RODO): dane nie opuszczają UE
//
// handler.ts zachowuje default export dla Sauny (środowisko dev/preview).

import { DurableObject } from "cloudflare:workers";
import { createApp } from "./handler";
import { ensureSeeded } from "./lib/seed";
import { runAllAgents } from "./lib/agents";
import { syncEcoActionBlob } from "./lib/ecoaction";
import migrationsBundle from "../migrations/migrations.js";

type WorkerEnv = {
  EDRS_DB: DurableObjectNamespace<EdrsDatabase>;
  ASSETS: Fetcher;
  DATABASE_URL?: string;
  ECOACTION_BLOB_SAS?: string; // sekret wranglera (read+list SAS do bloba EcoAction)
};

export class EdrsDatabase extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.applyMigrations());
  }

  // Aplikuje migrations/*.sql w kolejności journala; śledzi zaaplikowane tagi
  // w _migrations, więc kolejne wdrożenia dokładają tylko nowe pliki.
  private applyMigrations() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS _migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = new Set([...sql.exec("SELECT tag FROM _migrations")].map((r: any) => r.tag));
    const { journal, migrations } = migrationsBundle as any;
    for (const entry of journal.entries) {
      if (applied.has(entry.tag)) continue;
      const key = "m" + String(entry.idx).padStart(4, "0");
      const file: string = migrations[key];
      if (!file) throw new Error(`Brak pliku migracji dla tagu ${entry.tag} (klucz ${key})`);
      for (const stmt of file.split("--> statement-breakpoint")) {
        const s = stmt.trim();
        if (s) sql.exec(s);
      }
      sql.exec("INSERT INTO _migrations (tag, applied_at) VALUES (?, ?)", entry.tag, Date.now());
    }
  }

  // Ten sam kształt env, który dawała Sauna (patrz handler.ts type Bindings).
  private makeAppEnv() {
    const sql = this.ctx.storage.sql;
    return {
      sql: {
        // Kontrakt Sauny: exec zwraca obiekt z rowsWritten (używane w lib/mvp.ts).
        exec: (q: string, params: any[] = []) => {
          const cursor = sql.exec(q, ...params);
          return { rowsWritten: cursor.rowsWritten };
        },
        query: <T = any>(q: string, params: any[] = []): T[] => [...sql.exec(q, ...params)] as T[],
        raw: (q: string, params: any[] = []) => ({ rows: [...sql.exec(q, ...params).raw()] }),
      },
      websocket: {
        broadcast: (..._args: any[]) => { console.log("[edrs] websocket.broadcast: no-op (pilot bez live broadcast)"); },
      },
      ctx: { session: { isOwner: false } },
      DATABASE_URL: this.env.DATABASE_URL,
      ECOACTION_BLOB_SAS: this.env.ECOACTION_BLOB_SAS,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const app = createApp();
    return app.fetch(request, this.makeAppEnv() as any);
  }

  // Cron (worker scheduled() → RPC tutaj): seed-guard + agenci + sync bloba EcoAction.
  async runScheduled(): Promise<void> {
    const env = this.makeAppEnv();
    await ensureSeeded(env);
    await runAllAgents(env);
    try {
      await syncEcoActionBlob(env);
    } catch (e: any) {
      console.error("[edrs] ecoaction sync error:", e?.message ?? String(e));
    }
  }
}

// DO w jurysdykcji EU; fallback na zwykły namespace w lokalnym dev,
// gdyby emulator nie wspierał jurisdiction().
function dbStub(env: WorkerEnv) {
  let ns: DurableObjectNamespace<EdrsDatabase> = env.EDRS_DB;
  try {
    ns = (env.EDRS_DB as any).jurisdiction("eu");
  } catch {
    console.log("[edrs] jurisdiction('eu') niedostępna (lokalny dev?) — używam domyślnego namespace");
  }
  return ns.get(ns.idFromName("main"));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Statyczne assety obsłużył już routing assets (wrangler.jsonc) — tu trafia reszta.
    return dbStub(env).fetch(request);
  },
  async scheduled(_event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dbStub(env).runScheduled());
  },
} satisfies ExportedHandler<WorkerEnv>;
