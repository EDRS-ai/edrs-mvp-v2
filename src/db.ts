// PROMPT 6 — Scale-Ready: dual-driver DB adapter.
// Decision: if env.DATABASE_URL is present, use Neon Postgres (production, scales to 4000+ pkt).
// Otherwise fall back to Cloudflare DO SQLite (development / pilot <250 pkt).
//
// Why dual:
// - Cloudflare Workers have 128MB RAM and IOPS throttling on DO SQLite. At 4000 pkt the
//   settlement burst (16k ledger writes in <30s) overwhelms SQLite's single-writer model.
// - Neon serverless is HTTP-based (no TCP, no cold start issues with Workers) and is
//   Postgres-native — supports batching, indexes, mature tooling.
// - SQLite stays as a development fallback: zero-config, works locally without any cloud
//   account. Code that runs against SQLite also runs against Neon (both go through Drizzle).
//
// To enable Neon in production:
// 1. Create a Neon project: https://console.neon.tech (free tier covers pilot).
// 2. Get the connection string (postgres://...?sslmode=require).
// 3. Add as a Sauna connection env var named DATABASE_URL.
// 4. Redeploy. The next request will auto-route to Neon.

import { drizzle as drizzleSqlite } from "drizzle-orm/sqlite-proxy";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";
export * from "./schema";

export function makeDb(env: any) {
  // PRODUCTION path — Neon Postgres (HTTP driver, works with Cloudflare Workers)
  if (env.DATABASE_URL) {
    const sql = neon(env.DATABASE_URL);
    return drizzleNeon(sql, { schema });
  }
  // DEVELOPMENT path — Cloudflare DO SQLite (pilot <250 pkt, no setup)
  return drizzleSqlite(async (sql: string, params: any[], method: string) => {
    if (method === "run") {
      env.sql.exec(sql, params);
      return { rows: [] };
    }
    const { rows } = env.sql.raw(sql, params);
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }, { schema });
}
