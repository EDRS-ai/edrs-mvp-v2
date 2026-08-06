import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";
export * from "./schema";

export function makeDb(env: any) {
  return drizzle(async (sql: string, params: any[], method: string) => {
    if (method === "run") {
      env.sql.exec(sql, params);
      return { rows: [] };
    }
    const { rows } = env.sql.raw(sql, params);
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }, { schema });
}
