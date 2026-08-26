// Wspólny harness testowy: buduje in-memory SQLite z PRAWDZIWYCH migracji
// (migrations/*.sql — te same pliki, które platforma aplikuje na deployu),
// zamiast ręcznie przepisywanego DDL, który dryfował od schematu produkcyjnego.
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export function makeMigratedDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) db.exec(s);
    }
  }
  return db;
}

// Ten sam kształt env.sql co binding platformy (sync .exec/.query/.raw).
export function makeSqlEnv(db: InstanceType<typeof Database>) {
  return {
    db,
    sql: {
      // rowsWritten — kontrakt env.sql.exec (Sauna/worker.ts); mvp.ts na tym polega.
      exec: (sql: string, params: any[] = []) => {
        const info = db.prepare(sql).run(...params);
        return { ...info, rowsWritten: info.changes };
      },
      query: <T = any>(sql: string, params: any[] = []): T[] => db.prepare(sql).all(...params) as T[],
      raw: (sql: string, params: any[] = []) => ({ rows: db.prepare(sql).all(...params) }),
    },
    websocket: {},
    ctx: { session: { isOwner: true } },
  };
}
