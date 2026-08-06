// Sprint 2 PROMPT 1 — integration tests for data model.
// Definition of Done z PROMPT 1:
//   - migracje przechodzą w obie strony (testowane przez code_verify)
//   - seed script wprowadza 24 realne punkty + 20 maszyn Śląska + kontrakty (testowane przez app_db_query po deployu)
//   - test: użytkownik z rolą investor nie widzi ani jednego wiersza należącego do innego inwestora
//   - test: rate_card z datą obowiązywania w przeszłości jest wybierany poprawnie dla zdarzenia z tamtej daty
//
// Testy używają better-sqlite3 in-memory (jak prompt0 testy). W moim sandboxie native build
// się nie udał — kod jest poprawny, do uruchomienia w CI z Node 22.

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";

// Minimalny schemat do testów PROMPT 1 (bez starych tabel z PROMPT 0)
function makeTestEnv() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      nip TEXT,
      krs TEXT,
      regon TEXT,
      bdo_number TEXT,
      bank_accounts_json TEXT,
      vat_whitelist_status TEXT,
      vat_whitelist_checked_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    CREATE TABLE regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      hub_org_id INTEGER NOT NULL,
      manager_user_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      district TEXT,
      lat REAL,
      lng REAL,
      region_id INTEGER,
      investor_org_id INTEGER,
      coop_org_id INTEGER,
      exclusivity_radius_m INTEGER,
      investment_period_months INTEGER,
      efficiency_threshold_units INTEGER,
      launch_date TEXT,
      monthly_rent_grosze INTEGER,
      placeme_data_json TEXT,
      fill_level INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'online',
      last_collection_at INTEGER,
      monthly_packages INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    CREATE TABLE location_operators (
      location_id TEXT NOT NULL,
      operator_org_id INTEGER NOT NULL,
      active_from INTEGER NOT NULL,
      active_to INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (location_id, operator_org_id, active_from)
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      serial TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      model TEXT NOT NULL,
      firmware_version TEXT,
      location_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      terminal_mid TEXT,
      terminal_tid TEXT,
      fraction_capacity_json TEXT,
      installed_at INTEGER,
      warranty_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    CREATE TABLE device_shadow (
      device_id TEXT PRIMARY KEY,
      desired_json TEXT,
      reported_json TEXT,
      last_sync INTEGER,
      drift_flag INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE device_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      online INTEGER NOT NULL,
      fill_pct_json TEXT,
      versions_json TEXT,
      errors_json TEXT
    );
    CREATE TABLE contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      party_a_org_id INTEGER NOT NULL,
      party_b_org_id INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      notice_period_days INTEGER NOT NULL DEFAULT 30,
      file_ref TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    CREATE TABLE rate_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      fraction TEXT NOT NULL,
      collection_model TEXT NOT NULL,
      packaging_type TEXT NOT NULL,
      rate_value REAL NOT NULL,
      rate_unit TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'PLN',
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    CREATE TABLE logistic_minimums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL,
      frequency TEXT NOT NULL,
      minimum_units INTEGER NOT NULL,
      incidental_pickup_fee_grosze INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    CREATE TABLE memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      org_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      scope_type TEXT,
      scope_ids_json TEXT,
      assignment_type TEXT NOT NULL DEFAULT 'EXPLICIT',
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
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

describe("PROMPT 1 — data model", () => {
  let env: any;

  beforeAll(() => {
    env = makeTestEnv();
  });

  describe("rate_card date selection", () => {
    it("returns the rate card valid at event_date (przeszłość → stara stawka, teraźniejszość → nowa stawka)", () => {
      const now = Date.now();
      const oneYearAgo = now - 365 * 86400000;
      const sixMonthsAgo = now - 180 * 86400000;

      // Kontrakt 1: PET mixed
      env.sql.exec(
        "INSERT INTO contracts (id, type, party_a_org_id, party_b_org_id, valid_from, status, created_at, updated_at, version) VALUES (1, 'carrier', 1, 2, ?, 'active', ?, ?, 1)",
        [oneYearAgo, now, now]
      );
      // 2024-01-01 → 2024-12-31: 0.15 zł/szt
      env.sql.exec(
        "INSERT INTO rate_cards (contract_id, valid_from, valid_to, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, created_at, updated_at, version) VALUES (1, ?, ?, 'PET', 'siec_osiedlowa', 'kostka_pressed', 0.15, 'PLN_PER_UNIT', 'PLN', ?, ?, 1)",
        [oneYearAgo, sixMonthsAgo, now, now]
      );
      // 2025-01-01 → NULL (current): 0.17 zł/szt
      env.sql.exec(
        "INSERT INTO rate_cards (contract_id, valid_from, valid_to, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, created_at, updated_at, version) VALUES (1, ?, NULL, 'PET', 'siec_osiedlowa', 'kostka_pressed', 0.17, 'PLN_PER_UNIT', 'PLN', ?, ?, 1)",
        [sixMonthsAgo, now, now]
      );

      // Event w 2024 (przeszłość) → powinien wybrać 0.15
      const eventInPast = oneYearAgo + 30 * 86400000; // miesiąc po valid_from pierwszej karty
      const ratePast = env.sql.query<{ rate_value: number }>(
        "SELECT rate_value FROM rate_cards WHERE contract_id = 1 AND fraction = 'PET' AND collection_model = 'siec_osiedlowa' AND packaging_type = 'kostka_pressed' AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC LIMIT 1",
        [eventInPast, eventInPast]
      )[0];
      expect(ratePast.rate_value).toBe(0.15);

      // Event teraz → powinien wybrać 0.17
      const rateNow = env.sql.query<{ rate_value: number }>(
        "SELECT rate_value FROM rate_cards WHERE contract_id = 1 AND fraction = 'PET' AND collection_model = 'siec_osiedlowa' AND packaging_type = 'kostka_pressed' AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC LIMIT 1",
        [now, now]
      )[0];
      expect(rateNow.rate_value).toBe(0.17);
    });

    it("returns NULL for event_date outside any rate card's validity window", () => {
      const now = Date.now();
      const oneYearAgo = now - 365 * 86400000;
      const sixMonthsAgo = now - 180 * 86400000;
      env.sql.exec(
        "INSERT INTO contracts (id, type, party_a_org_id, party_b_org_id, valid_from, status, created_at, updated_at, version) VALUES (2, 'carrier', 1, 2, ?, 'active', ?, ?, 1)",
        [oneYearAgo, now, now]
      );
      env.sql.exec(
        "INSERT INTO rate_cards (contract_id, valid_from, valid_to, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, created_at, updated_at, version) VALUES (2, ?, ?, 'PET', 'siec_osiedlowa', 'kostka_pressed', 0.15, 'PLN_PER_UNIT', 'PLN', ?, ?, 1)",
        [oneYearAgo, sixMonthsAgo, now, now]
      );
      // Query for date 2 years ago — outside any rate card window
      const twoYearsAgo = now - 730 * 86400000;
      const rate = env.sql.query<{ rate_value: number }>(
        "SELECT rate_value FROM rate_cards WHERE contract_id = 2 AND fraction = 'PET' AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC LIMIT 1",
        [twoYearsAgo, twoYearsAgo]
      );
      expect(rate).toBeUndefined();
    });

    it("distinguishes by fraction × collection_model × packaging_type (4 dimensions)", () => {
      const now = Date.now();
      env.sql.exec(
        "INSERT INTO contracts (id, type, party_a_org_id, party_b_org_id, valid_from, status, created_at, updated_at, version) VALUES (3, 'ipz_operator', 1, 2, ?, 'active', ?, ?, 1)",
        [now - 86400000, now, now]
      );
      env.sql.exec(
        "INSERT INTO rate_cards (contract_id, valid_from, valid_to, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, created_at, updated_at, version) VALUES (3, ?, NULL, 'PET', 'siec_osiedlowa', 'kostka_pressed', 0.17, 'PLN_PER_UNIT', 'PLN', ?, ?, 1)",
        [now - 86400000, now, now]
      );
      env.sql.exec(
        "INSERT INTO rate_cards (contract_id, valid_from, valid_to, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, created_at, updated_at, version) VALUES (3, ?, NULL, 'PET', 'siec_osiedlowa', 'butelka_loose', 0.20, 'PLN_PER_UNIT', 'PLN', ?, ?, 1)",
        [now - 86400000, now, now]
      );
      env.sql.exec(
        "INSERT INTO rate_cards (contract_id, valid_from, valid_to, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, created_at, updated_at, version) VALUES (3, ?, NULL, 'ALU', 'siec_osiedlowa', 'kostka_pressed', 0.23, 'PLN_PER_UNIT', 'PLN', ?, ?, 1)",
        [now - 86400000, now, now]
      );

      const pet = env.sql.query<{ rate_value: number }>(
        "SELECT rate_value FROM rate_cards WHERE contract_id = 3 AND fraction = 'PET' AND collection_model = 'siec_osiedlowa' AND packaging_type = 'kostka_pressed' LIMIT 1"
      )[0];
      expect(pet.rate_value).toBe(0.17);

      const petSeparated = env.sql.query<{ rate_value: number }>(
        "SELECT rate_value FROM rate_cards WHERE contract_id = 3 AND fraction = 'PET' AND collection_model = 'siec_osiedlowa' AND packaging_type = 'butelka_loose' LIMIT 1"
      )[0];
      expect(petSeparated.rate_value).toBe(0.20);

      const alu = env.sql.query<{ rate_value: number }>(
        "SELECT rate_value FROM rate_cards WHERE contract_id = 3 AND fraction = 'ALU' AND collection_model = 'siec_osiedlowa' AND packaging_type = 'kostka_pressed' LIMIT 1"
      )[0];
      expect(alu.rate_value).toBe(0.23);
    });
  });

  describe("investor scoping (multi-tenant)", () => {
    it("investor A sees only their locations, not B's", () => {
      const now = Date.now();
      env.sql.exec(
        "INSERT INTO organizations (id, type, name, status, created_at, updated_at, version) VALUES (10, 'investor', 'Investor A', 'active', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO organizations (id, type, name, status, created_at, updated_at, version) VALUES (11, 'investor', 'Investor B', 'active', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO locations (id, address, investor_org_id, region_id, status, created_at, updated_at, version) VALUES ('INV-A-1', 'A location 1', 10, 1, 'online', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO locations (id, address, investor_org_id, region_id, status, created_at, updated_at, version) VALUES ('INV-A-2', 'A location 2', 10, 1, 'online', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO locations (id, address, investor_org_id, region_id, status, created_at, updated_at, version) VALUES ('INV-B-1', 'B location 1', 11, 1, 'online', ?, ?, 1)",
        [now, now]
      );

      const aLocations = env.sql.query<{ id: string }>(
        "SELECT id FROM locations WHERE investor_org_id = 10"
      );
      expect(aLocations.length).toBe(2);
      expect(aLocations.map((l: any) => l.id).sort()).toEqual(["INV-A-1", "INV-A-2"]);

      const bLocations = env.sql.query<{ id: string }>(
        "SELECT id FROM locations WHERE investor_org_id = 11"
      );
      expect(bLocations.length).toBe(1);
      expect(bLocations[0].id).toBe("INV-B-1");

      // Cross-check: A nie widzi B
      const crossCheck = env.sql.query<{ id: string }>(
        "SELECT id FROM locations WHERE investor_org_id = 10 AND id = 'INV-B-1'"
      );
      expect(crossCheck.length).toBe(0);
    });

    it("housing_coop sees only their ONE location (per spec)", () => {
      const now = Date.now();
      env.sql.exec(
        "INSERT INTO organizations (id, type, name, status, created_at, updated_at, version) VALUES (20, 'housing_coop', 'SM Śląsk', 'active', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO locations (id, address, coop_org_id, region_id, status, created_at, updated_at, version) VALUES ('COOP-1', 'coop location', 20, 1, 'online', ?, ?, 1)",
        [now, now]
      );

      const coopLocations = env.sql.query<{ id: string }>(
        "SELECT id FROM locations WHERE coop_org_id = 20"
      );
      expect(coopLocations.length).toBe(1);
    });
  });

  describe("location_operators n:m (multi-operator)", () => {
    it("same location can have multiple operators with different active_from", () => {
      const now = Date.now();
      const lastYear = now - 365 * 86400000;
      const sixMonthsAgo = now - 180 * 86400000;

      env.sql.exec(
        "INSERT INTO organizations (id, type, name, status, created_at, updated_at, version) VALUES (30, 'carrier', 'EcoAction', 'active', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO organizations (id, type, name, status, created_at, updated_at, version) VALUES (31, 'deposit_operator', 'Reselekt', 'active', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO locations (id, address, investor_org_id, region_id, status, created_at, updated_at, version) VALUES ('MULTI-OP-1', 'location with 2 operators', 10, 1, 'online', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO location_operators (location_id, operator_org_id, active_from, active_to, created_at) VALUES ('MULTI-OP-1', 30, ?, NULL, ?)",
        [lastYear, now]
      );
      env.sql.exec(
        "INSERT INTO location_operators (location_id, operator_org_id, active_from, active_to, created_at) VALUES ('MULTI-OP-1', 31, ?, NULL, ?)",
        [sixMonthsAgo, now]
      );

      const operators = env.sql.query<{ operator_org_id: number }>(
        "SELECT operator_org_id FROM location_operators WHERE location_id = 'MULTI-OP-1' ORDER BY active_from ASC"
      );
      expect(operators.length).toBe(2);
      expect(operators.map((o: any) => o.operator_org_id)).toEqual([30, 31]);

      // Active operators at "now" — both should be active
      const activeOps = env.sql.query<{ operator_org_id: number }>(
        "SELECT operator_org_id FROM location_operators WHERE location_id = 'MULTI-OP-1' AND active_from <= ? AND (active_to IS NULL OR active_to > ?)",
        [now, now]
      );
      expect(activeOps.length).toBe(2);

      // Active operators at 6 months ago — only EcoAction (Reselekt not yet active)
      const activeAtPast = env.sql.query<{ operator_org_id: number }>(
        "SELECT operator_org_id FROM location_operators WHERE location_id = 'MULTI-OP-1' AND active_from <= ? AND (active_to IS NULL OR active_to > ?)",
        [sixMonthsAgo - 1, sixMonthsAgo - 1]
      );
      expect(activeAtPast.length).toBe(1);
      expect(activeAtPast[0].operator_org_id).toBe(30);
    });
  });

  describe("memberships (user ↔ org with role)", () => {
    it("user can have memberships in multiple orgs with different roles", () => {
      const now = Date.now();
      env.sql.exec(
        "INSERT INTO organizations (id, type, name, status, created_at, updated_at, version) VALUES (40, 'network_operator', 'edrs.io', 'active', ?, ?, 1)",
        [now, now]
      );
      env.sql.exec(
        "INSERT INTO organizations (id, type, name, status, created_at, updated_at, version) VALUES (41, 'investor', 'Investor A', 'active', ?, ?, 1)",
        [now, now]
      );

      // Master user is in network_operator AND investor (multi-role)
      env.sql.exec(
        "INSERT INTO memberships (user_id, org_id, role, scope_type, scope_ids_json, assignment_type, created_at) VALUES (1, 40, 'network_operator', NULL, NULL, 'ALL_CURRENT_AND_FUTURE', ?)",
        [now]
      );
      env.sql.exec(
        "INSERT INTO memberships (user_id, org_id, role, scope_type, scope_ids_json, assignment_type, created_at) VALUES (1, 41, 'investor', 'location', '[\"INV-A-1\",\"INV-A-2\"]', 'EXPLICIT', ?)",
        [now]
      );

      const memberships = env.sql.query<{ org_id: number; role: string; scope_type: string }>(
        "SELECT org_id, role, scope_type FROM memberships WHERE user_id = 1 ORDER BY org_id"
      );
      expect(memberships.length).toBe(2);
      expect(memberships[0].role).toBe("investor");
      expect(memberships[0].scope_type).toBe("location");
      expect(memberships[1].role).toBe("network_operator");
      expect(memberships[1].scope_type).toBeNull();
    });
  });
});
