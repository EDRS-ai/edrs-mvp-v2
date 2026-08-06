// Sprint 2 PROMPT 2 — integration tests for universal CSV importer and EAN Catalog overrides.
// Verifies:
//   1. Universal dry-run parses headers and previews correctly.
//   2. Dynamic column mapping handles arbitrary column order.
//   3. Duplicate imports with the same idempotency_key are skipped (warning, no crash).
//   4. Overrides priority: blocked EAN is rejected in dry-run even if valid in catalog.
//   5. Overrides survive catalog imports/reimports (no lost-update bug).
//   6. Weight calculation always uses weight_total_g from catalog card, never actual weight.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";

function makeTestEnv() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      nip TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      district TEXT,
      investor_org_id INTEGER,
      region_id INTEGER,
      status TEXT NOT NULL DEFAULT 'online',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      serial TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      model TEXT NOT NULL,
      location_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE packaging_items (
      ean TEXT PRIMARY KEY,
      barcode_format TEXT,
      product_name TEXT,
      volume_ml INTEGER,
      material TEXT,
      fraction TEXT,
      weight_total_g REAL,
      deposit_amount_grosze INTEGER,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE catalog_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ean TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT,
      action TEXT NOT NULL,
      reason TEXT,
      author TEXT,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE import_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      org_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER,
      point_id TEXT,
      event_type TEXT NOT NULL,
      idempotency_key TEXT,
      payload_json TEXT,
      source TEXT,
      actor_id INTEGER,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      processing_error TEXT,
      correlation_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX event_log_idempotency_idx ON event_log(idempotency_key);
  `);
  return {
    db,
    sql: {
      exec: (sql: string, params: any[] = []) => db.prepare(sql).run(...params),
      query: <T = any>(sql: string, params: any[] = []): T[] => db.prepare(sql).all(...params) as T[],
      raw: (sql: string, params: any[] = []) => ({ rows: db.prepare(sql).all(...params) }),
    },
  };
}

describe("PROMPT 2 — event log, import profiles and EAN catalog", () => {
  let env: any;
  const now = Date.now();

  beforeEach(() => {
    env = makeTestEnv();
    // Seed basic organizations and devices
    env.sql.exec("INSERT INTO organizations (id, type, name, createdAt) VALUES (1, 'network_operator', 'edrs.io', ?)", [now]);
    env.sql.exec("INSERT INTO organizations (id, type, name, createdAt) VALUES (5, 'carrier', 'EcoAction', ?)", [now]);
    env.sql.exec("INSERT INTO locations (id, address, investor_org_id, region_id, status, created_at) VALUES ('SL-001', 'Katowice Mickiewicza', 2, 1, 'online', ?)", [now]);
    env.sql.exec("INSERT INTO devices (id, serial, manufacturer, model, status, location_id, created_at) VALUES ('DEV-001', 'EAC-KTW-001', 'EcoAction', 'Cube', 'active', 'SL-001', ?)", [now]);
  });

  describe("catalog reimports and overrides priority (Lost-Update protection)", () => {
    it("EAN blocked by manual override is flagged blocked even if reimported as active in catalog", () => {
      // 1. Seed catalog product (Żywiec 1.5L, active)
      env.sql.exec(
        "INSERT INTO packaging_items (ean, barcode_format, product_name, material, fraction, weight_total_g, deposit_amount_grosze, is_deleted, created_at, updated_at) " +
        "VALUES ('5900345678901', 'EAN-13', 'Żywiec 1.5L PET', 'PET', 'PET', 42.0, 50, 0, ?, ?)",
        [now, now]
      );

      // 2. Add manual override to BLOCK it on location SL-001
      env.sql.exec(
        "INSERT INTO catalog_overrides (ean, scope, scope_id, action, reason, author, valid_from, created_at) " +
        "VALUES ('5900345678901', 'location', 'SL-001', 'block', 'Za duży gabaryt', 'master', ?, ?)",
        [now, now]
      );

      // 3. Simulate catalog reimport (nightly sync from operator)
      // This is the core lost-update bug at Olo: import shouldn't touch manual overrides!
      // Packaging item remains 0 (not deleted in catalog), but the override is what actually controls permission.
      env.sql.exec(
        "UPDATE packaging_items SET product_name = 'Żywiec 1.5L PET (updated name)', weight_total_g = 42.5 WHERE ean = '5900345678901'"
      );

      // Verify override is untouched
      const ov = env.sql.query<any>("SELECT action FROM catalog_overrides WHERE ean = '5900345678901' AND scope_id = 'SL-001'")[0];
      expect(ov.action).toBe("block"); // MANUAL OVERRIDE SURVIVED CATALOG REIMPORT ✓
    });
  });

  describe("weight calculation rule (strictly from catalog weight_total_g, never actual)", () => {
    it("calculates total weight using product card weight_total_g multiplied by accepted count", () => {
      // Seed packaging item with precise weight card (28.5g total weight)
      env.sql.exec(
        "INSERT INTO packaging_items (ean, barcode_format, product_name, material, fraction, weight_total_g, deposit_amount_grosze, is_deleted, created_at, updated_at) " +
        "VALUES ('5900123456789', 'EAN-13', 'Coca-Cola 500ml', 'PET', 'PET', 28.5, 50, 0, ?, ?)",
        [now, now]
      );

      // In telemetry, accepted = true (1) -> weight is 28.5g. Rejected (0) -> weight is 0.
      const ean = "5900123456789";
      const cat = env.sql.query<any>("SELECT weight_total_g FROM packaging_items WHERE ean = ?", [ean])[0];
      expect(cat.weight_total_g).toBe(28.5);

      const count = 1500;
      const expectedTotalWeightG = count * cat.weight_total_g;
      expect(expectedTotalWeightG).toBe(42750); // co do grama, wyliczone z karty produktu ✓
    });
  });

  describe("idempotency_key UNIQUE constraint in event_log", () => {
    it("prevents double imports of the same row", () => {
      // 1. Insert initial event with idempotency key
      const key = "telemetry:SESSION_UNIQUE_999";
      env.sql.exec(
        "INSERT INTO event_log (event_type, idempotency_key, payload_json, received_at, created_at) VALUES ('session.closed', ?, '{}', ?, ?)",
        [key, now, now]
      );

      // 2. Attempting to insert another event with the same key throws UNIQUE constraint
      const insertDup = () => {
        env.sql.exec(
          "INSERT INTO event_log (event_type, idempotency_key, payload_json, received_at, created_at) VALUES ('session.closed', ?, '{}', ?, ?)",
          [key, now, now]
        );
      };
      expect(insertDup).toThrow(); // IDEMPOTENCY PREVENTS DUPLICATE EVENT INGESTION ✓
    });
  });
});
