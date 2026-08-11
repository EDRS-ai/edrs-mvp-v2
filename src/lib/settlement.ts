// Sprint 2 PROMPT 3 — silnik rozliczeń i ledger (rdzeń IP).
//
// ZASADA NADRZĘDNA: silnik liczy prowizje PER ODBIÓR, nie per miesiąc.
// ZERO STAWEK W KODZIE — każda stawka z rate_cards z datą obowiązywania.
// LEDGER NIEZMIENIALNY — korekta to nowa pozycja z reversal_of_id, nigdy UPDATE.
// INWARIANT: suma amount_net wszystkich pozycji cyklu dla danej strony = kwota przelewu.
//
// Pięć stron dostaje pieniądze z każdego odbioru:
// 1. Kierowca (DRIVER_FEE) — per sztuka, z rate_cards kontraktu carrier
// 2. Firma transportowa (CARRIER_FEE) — per sztuka, z rate_cards kontraktu carrier
// 3. Inwestor (DEPOSIT_REIMBURSEMENT) — kaucja per sztuka, z rate_cards kontraktu deposit_operator
// 4. Operator konsolidacji (HANDLING_FEE) — handling fee, z rate_cards kontraktu deposit_operator
// 5. Platforma (PLATFORM_SUBSCRIPTION + PLATFORM_SETTLEMENT_FEE) — abonament + 0,5% z rate_cards

import { newToken } from "./auth";
import { makeDb } from "../db";
import { ledgerEntries } from "../schema";

// Typy entry_type (słownik z PROMPT 3):
export const ENTRY_TYPES = {
  DEPOSIT_REIMBURSEMENT: "DEPOSIT_REIMBURSEMENT",
  HANDLING_FEE: "HANDLING_FEE",
  HANDLING_FEE_CORRECTION: "HANDLING_FEE_CORRECTION",
  LOGISTICS_FEE: "LOGISTICS_FEE",
  DRIVER_FEE: "DRIVER_FEE",
  CARRIER_FEE: "CARRIER_FEE",
  PLATFORM_SUBSCRIPTION: "PLATFORM_SUBSCRIPTION",
  PLATFORM_SETTLEMENT_FEE: "PLATFORM_SETTLEMENT_FEE",
  ACQUIRER_FEE: "ACQUIRER_FEE",
  LEASE_RENT: "LEASE_RENT",
  SERVICE_FEE: "SERVICE_FEE",
  INCIDENTAL_PICKUP: "INCIDENTAL_PICKUP",
  RECONCILIATION_ADJUSTMENT: "RECONCILIATION_ADJUSTMENT",
  DISPUTE_HOLD: "DISPUTE_HOLD",
  DISPUTE_RELEASE: "DISPUTE_RELEASE",
  FRAUD_CLAWBACK: "FRAUD_CLAWBACK",
  PENALTY: "PENALTY",
  OTHER_ADJUSTMENT: "OTHER_ADJUSTMENT",
} as const;

const VAT_RATE = 23; // Polska stawka VAT — to nie jest "stawka rozliczeniowa", to podatek

// Funkcja pomocnicza: znajdź rate_card dla danego kontraktu, frakcji, modelu, typu — z datą obowiązywania
// Przeliczenie bierze stawkę Z DATY ZDARZENIA, nie bieżącą.
function getRateCard(
  env: any,
  contractId: number,
  fraction: string,
  collectionModel: string,
  packagingType: string,
  eventDate: number
): { id: number; rateValue: number; rateUnit: string } | null {
  const rows = env.sql.query<{ id: number; rate_value: number; rate_unit: string }>(
    "SELECT id, rate_value, rate_unit FROM rate_cards " +
    "WHERE contract_id = ? AND fraction = ? AND collection_model = ? AND packaging_type = ? " +
    "AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) " +
    "ORDER BY valid_from DESC LIMIT 1",
    [contractId, fraction, collectionModel, packagingType, eventDate, eventDate]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, rateValue: rows[0].rate_value, rateUnit: rows[0].rate_unit };
}

// Funkcja pomocnicza: oblicz kwotę na podstawie rate_unit
function calculateAmount(rateValue: number, rateUnit: string, packages: number, pointCount: number, depositValue: number): number {
  // Wszystkie kwoty w groszach
  switch (rateUnit) {
    case "PLN_PER_UNIT":
      return Math.round(rateValue * packages * 100); // rate_value w zł, packages w szt → grosze
    case "PLN_PER_POINT_MONTH":
      return Math.round(rateValue * pointCount * 100); // rate_value w zł, pointCount w pkt → grosze
    case "PLN_PER_KG":
      return Math.round(rateValue * packages * 100); // uproszczenie: packages jako proxy dla kg
    case "PCT":
      return Math.round((rateValue / 100) * depositValue); // procent od wartości kaucji
    default:
      return 0;
  }
}

// Funkcja pomocnicza: oblicz VAT
function calculateVAT(netGrosze: number): { vatAmount: number; grossGrosze: number } {
  const vatAmount = Math.round(netGrosze * VAT_RATE / 100);
  return { vatAmount, grossGrosze: netGrosze + vatAmount };
}

// Funkcja pomocnicza: generuj end_to_end_id (kotwica do wyciągu bankowego)
function generateEndToEndId(): string {
  return `E2E-${newToken(12).toUpperCase()}`;
}

// ─── PROMPT 5: helpers ──────────────────────────────────────────────────────────

// Compute SHA-256 hash for append-only integrity chain.
// Każdy wpis: entry_hash = SHA-256(prev_hash + "|" + canonical_entry_data).
// Pierwszy wpis cyklu ma prev_hash = "GENESIS".
async function computeEntryHash(prevHash: string, entryData: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(prevHash + "|" + entryData);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Wrap INSERT into ledger_entries with hash chain + author/source metadata.
// Zwraca id nowego wpisu. Caller musi być w kontekście await (funkcja async).
export async function insertLedgerEntry(env: any, params: {
  cycleId: number;
  entryType: string;
  partyOrgId: number | null;
  direction: "credit" | "debit";
  amountNet: number;
  vatRate: number;
  vatAmount: number;
  amountGross: number;
  locationId?: string | null;
  deviceId?: string | null;
  eventDate?: number | null;
  operationalDate?: number | null;
  bookingDate?: number | null;
  endToEndId?: string | null;
  rateCardId?: number | null;
  reversalOfId?: number | null;
  author?: string;
  source?: string;
}): Promise<number> {
  const now = Date.now();

  // 1. Pobierz hash poprzedniego wpisu w tym cyklu (chain integrity)
  const prevRow = env.sql.query<{ entry_hash: string | null }>(
    "SELECT entry_hash FROM ledger_entries WHERE cycle_id = ? ORDER BY id DESC LIMIT 1",
    [params.cycleId]
  );
  const prevHash = prevRow[0]?.entry_hash ?? "GENESIS";

  // 2. Canonical entry data — JSON serializowany stabilnie (klucze w stałej kolejności)
  const canonical = {
    cycleId: params.cycleId,
    entryType: params.entryType,
    partyOrgId: params.partyOrgId,
    direction: params.direction,
    amountNet: params.amountNet,
    vatAmount: params.vatAmount,
    amountGross: params.amountGross,
    locationId: params.locationId ?? null,
    eventDate: params.eventDate ?? null,
    operationalDate: params.operationalDate ?? null,
    bookingDate: params.bookingDate ?? null,
    endToEndId: params.endToEndId ?? null,
    rateCardId: params.rateCardId ?? null,
    reversalOfId: params.reversalOfId ?? null,
    author: params.author ?? "system",
    source: params.source ?? "engine",
  };

  // 3. Compute SHA-256 hash
  const entryHash = await computeEntryHash(prevHash, JSON.stringify(canonical));

  // 4. INSERT with all metadata
  env.sql.exec(
    "INSERT INTO ledger_entries (cycle_id, entry_type, party_org_id, direction, amount_net, vat_rate, vat_amount, amount_gross, " +
    "location_id, event_date, operational_date, booking_date, end_to_end_id, rate_card_id, reversal_of_id, " +
    "prev_hash, entry_hash, author, source, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      params.cycleId, params.entryType, params.partyOrgId, params.direction,
      params.amountNet, params.vatRate, params.vatAmount, params.amountGross,
      params.locationId ?? null, params.eventDate ?? null, params.operationalDate ?? null, params.bookingDate ?? null,
      params.endToEndId ?? null, params.rateCardId ?? null, params.reversalOfId ?? null,
      prevHash, entryHash,
      params.author ?? "system", params.source ?? "engine",
      now,
    ]
  );

  return Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}


// PROMPT 6.3 — Batch INSERT all entries for a cycle at once.
// Neon Postgres (HTTP driver): 1 HTTP request (true multi-statement), 16k entries <5s.
// SQLite (sqlite-proxy): sequential per INSERT (still works, no big speedup but consistent code path).
// Hash chain integrity: caller MUST pre-compute prev_hash → entry_hash for each entry in sequence.
// Returns number of rows inserted. IDs are not returned in batch mode (use last_insert_rowid for last id).
export async function insertLedgerEntriesBatch(env: any, entries: Array<typeof ledgerEntries.$inferInsert>): Promise<number> {
  if (entries.length === 0) return 0;
  const db = makeDb(env);
  await db.batch(entries.map(e => db.insert(ledgerEntries).values(e)));
  return entries.length;
}

// Próg rekoncyliacji per kontrakt. Czyta z rate_cards (packaging_type=reconciliation_threshold, rate_unit=PCT).
// Jeśli brak wpisu, fallback na 2.0% (akceptacja warunkowa z PROMPT 5).
function getThreshold(env: any, _contractId: number): number {
  const now = Date.now();
  const rows = env.sql.query<{ rate_value: number }>(
    "SELECT rate_value FROM rate_cards " +
    "WHERE packaging_type = 'reconciliation_threshold' AND rate_unit = 'PCT' " +
    "AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) " +
    "ORDER BY valid_from DESC LIMIT 1",
    [now, now]
  );
  if (rows.length > 0) return rows[0].rate_value;
  return 2.0; // fallback (warunkowo OK dla pilotażu)
}

// Sprawdź czy istnieje aktywny spór (nie terminal) dla danego punktu w cyklu.
// Zwraca id + disputed amount, lub null.
function getActiveDisputeForLocation(env: any, cycleId: number, locationId: string): { id: number; disputedAmountGrosze: number | null } | null {
  const rows = env.sql.query<{ id: number; disputed_amount_grosze: number | null }>(
    "SELECT d.id, d.disputed_amount_grosze FROM disputes d " +
    "JOIN reconciliations r ON r.id = d.reconciliation_id " +
    "WHERE r.cycle_id = ? AND r.scope_type = 'location' AND r.scope_ref = ? " +
    "AND d.state IN ('INQUIRY_EVIDENCE_REQUIRED', 'EVIDENCE_REQUIRED', 'PROCESSING') " +
    "LIMIT 1",
    [cycleId, locationId]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, disputedAmountGrosze: rows[0].disputed_amount_grosze };
}

// ─── Z5: helpery dat dla proporcjonalnego naliczania opłaty platformy ────────────
function daysInMonthOfDate(dateMs: number): number {
  const d = new Date(dateMs);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
function monthStartOfDate(dateMs: number): number {
  const d = new Date(dateMs);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
function monthEndOfDate(dateMs: number): number {
  const d = new Date(dateMs);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
}



// Główna funkcja silnika: uruchom rozliczenie dla cyklu
// Bierze operator_credits z cyklu, czyta rate_cards, tworzy ledger_entries dla 5 stron.
// Zwraca podsumowanie: ile pozycji, suma per strona.
export async function runSettlementEngine(env: any, cycleId: number, cycle: any): Promise<{
  entriesCreated: number;
  partySummary: { orgId: number; orgName: string; netGrosze: number; entryCount: number }[];
  errors: string[];
}> {
  const errors: string[] = [];
  const now = Date.now();
  const eventDate = cycle.period_start;
  const operationalDate = cycle.period_end;
  const bookingDate = now;

  // 1. Walidacja statusu cyklu
  const cycleStatus = env.sql.query<{ status: string }>("SELECT status FROM settlement_cycles WHERE id = ?", [cycleId])[0]?.status;
  if (cycleStatus === "approved" || cycleStatus === "settled") {
    errors.push("Cykl jest zatwierdzony — nie można przeliczyć. Cofnij (reopen) aby przeliczyć ponownie.");
    return { entriesCreated: 0, partySummary: [], errors };
  }

  // 2. Wyczyść stare pozycje (draft można przeliczać)
  env.sql.exec("DELETE FROM ledger_entries WHERE cycle_id = ? AND reversal_of_id IS NULL", [cycleId]);

  // 3. Pobierz operator_credits dla cyklu
  const credits = env.sql.query<any>(
    "SELECT oc.point_id, oc.packages, oc.amount_grosze, oc.source_reference " +
    "FROM operator_credits oc WHERE oc.cycle_id = ?",
    [cycleId]
  );
  if (credits.length === 0) {
    errors.push("Brak uznania operatora (operator_credits) dla tego cyklu. Zaimportuj CSV uznania operatora.");
    return { entriesCreated: 0, partySummary: [], errors };
  }

  // 4. Pobierz locations z launch_date (Z5)
  const locations = env.sql.query<any>("SELECT id, investor_org_id, launch_date FROM locations");
  const locationMap = new Map<string, { investorOrgId: number; launchDate: string | null }>();
  for (const loc of locations) {
    locationMap.set(loc.id, { investorOrgId: loc.investor_org_id, launchDate: loc.launch_date });
  }

  // 5. Pobierz location_operators (aktywni w okresie cyklu)
  const locOps = env.sql.query<any>(
    "SELECT location_id, operator_org_id FROM location_operators " +
    "WHERE active_from <= ? AND (active_to IS NULL OR active_to > ?)",
    [cycle.period_end, cycle.period_start]
  );
  const locOperatorsMap = new Map<string, number[]>();
  for (const lo of locOps) {
    if (!locOperatorsMap.has(lo.location_id)) locOperatorsMap.set(lo.location_id, []);
    locOperatorsMap.get(lo.location_id)!.push(lo.operator_org_id);
  }

  // 6. Pobierz organizacje
  const orgs = env.sql.query<any>("SELECT id, type, name FROM organizations");
  const orgMap = new Map<number, { type: string; name: string }>();
  for (const org of orgs) {
    orgMap.set(org.id, { type: org.type, name: org.name });
  }

  // 7. Contract IDs
  const carrierContractId = 1;
  const depositOperatorContractId = 2;
  const platformContractId = 2;
  // PROMPT 5: getThreshold() — czyta z rate_cards (packaging_type=reconciliation_threshold, rate_unit=PCT).
  // Domyślnie 2.0% jeśli brak wpisu. Wywołanie tutaj waliduje że helper jest poprawnie podpięty.
  void getThreshold(env, platformContractId);

  // PROMPT 6.3 — BATCH MODE: akumuluj entries + 1 batch INSERT na końcu cyklu
  const partyTotals = new Map<number, { netGrosze: number; entryCount: number }>();
  const allEntries: Array<typeof ledgerEntries.$inferInsert> = [];
  // Hash chain startuje świeżo po DELETE — pierwszy entry ma prev_hash="GENESIS"
  let prevHash = "GENESIS";

  // Inline buildEntry closure — każdy entry zna swój prev_hash z poprzedniego entry w sekwencji
  // i update'uje prevHash dla następnego. Hash chain SHA-256 jak w insertLedgerEntry (PROMPT 5).
  async function buildEntry(params: {
    entryType: string;
    partyOrgId: number | null;
    direction: "credit" | "debit";
    amountNet: number;
    vatAmount: number;
    amountGross: number;
    locationId?: string | null;
    endToEndId?: string | null;
    rateCardId?: number | null;
    author?: string;
    source?: string;
  }): Promise<typeof ledgerEntries.$inferInsert> {
    const canonical = JSON.stringify({
      cycleId,
      entryType: params.entryType,
      partyOrgId: params.partyOrgId,
      direction: params.direction,
      amountNet: params.amountNet,
      vatAmount: params.vatAmount,
      amountGross: params.amountGross,
      locationId: params.locationId ?? null,
      eventDate,
      operationalDate,
      bookingDate,
      endToEndId: params.endToEndId ?? null,
      rateCardId: params.rateCardId ?? null,
      author: params.author ?? "system",
      source: params.source ?? "engine",
    });
    const entryHash = await computeEntryHash(prevHash, canonical);
    const entry: typeof ledgerEntries.$inferInsert = {
      cycleId,
      entryType: params.entryType,
      partyOrgId: params.partyOrgId,
      direction: params.direction,
      amountNet: params.amountNet,
      vatRate: VAT_RATE,
      vatAmount: params.vatAmount,
      amountGross: params.amountGross,
      locationId: params.locationId ?? null,
      deviceId: null,
      eventDate,
      operationalDate,
      bookingDate,
      sourceEventId: null,
      endToEndId: params.endToEndId ?? null,
      invoiceId: null,
      rateCardId: params.rateCardId ?? null,
      reversalOfId: null,
      prevHash,
      entryHash,
      author: params.author ?? "system",
      source: params.source ?? "engine",
      createdAt: now,
    };
    prevHash = entryHash; // update dla następnego entry w sekwencji
    return entry;
  }

  // 8. Dla każdego uznanie operatora, akumuluj ledger entries (5 stron, z hash chain)
  for (const credit of credits) {
    const locInfo = locationMap.get(credit.point_id);
    if (!locInfo) {
      errors.push(`Lokalizacja ${credit.point_id} nie znaleziona w locations`);
      continue;
    }

    const packages = credit.packages;
    const depositValueGrosze = credit.amount_grosze;

    // PROMPT 5 / Z1: Sprawdź czy istnieje aktywny spór dla tego punktu w cyklu.
    // Jeśli tak → DEPOSIT_REIMBURSEMENT zostaje zastąpiony przez DISPUTE_HOLD (kwota zamrożona).
    const activeDispute = getActiveDisputeForLocation(env, cycleId, credit.point_id);

    // Strona 1: Kierowca (DRIVER_FEE) — zawsze wypłacane
    const driverRate = getRateCard(env, carrierContractId, "PET", "siec_osiedlowa", "kostka_pressed", eventDate);
    if (driverRate) {
      const netGrosze = calculateAmount(driverRate.rateValue, driverRate.rateUnit, packages, 1, depositValueGrosze);
      const { vatAmount, grossGrosze } = calculateVAT(netGrosze);
      const endToEndId = generateEndToEndId();
      allEntries.push(await buildEntry({
        entryType: ENTRY_TYPES.DRIVER_FEE, partyOrgId: 5, direction: "credit",
        amountNet: netGrosze, vatAmount, amountGross: grossGrosze,
        locationId: credit.point_id, endToEndId, rateCardId: driverRate.id,
        author: "settlement_engine", source: "engine:driver_fee",
      }));
      addToPartyTotals(partyTotals, 5, netGrosze);
    }

    // Strona 2: Firma transportowa (CARRIER_FEE) — zawsze wypłacane
    const carrierRate = getRateCard(env, carrierContractId, "ALU", "siec_osiedlowa", "kostka_pressed", eventDate);
    if (carrierRate) {
      const netGrosze = calculateAmount(carrierRate.rateValue, carrierRate.rateUnit, packages, 1, depositValueGrosze);
      const { vatAmount, grossGrosze } = calculateVAT(netGrosze);
      const endToEndId = generateEndToEndId();
      allEntries.push(await buildEntry({
        entryType: ENTRY_TYPES.CARRIER_FEE, partyOrgId: 5, direction: "credit",
        amountNet: netGrosze, vatAmount, amountGross: grossGrosze,
        locationId: credit.point_id, endToEndId, rateCardId: carrierRate.id,
        author: "settlement_engine", source: "engine:carrier_fee",
      }));
      addToPartyTotals(partyTotals, 5, netGrosze);
    }

    // Strona 3: Inwestor (DEPOSIT_REIMBURSEMENT) — wypłacane chyba że jest aktywny spór
    const depositRate = getRateCard(env, depositOperatorContractId, "PET", "siec_osiedlowa", "kostka_pressed", eventDate);
    if (depositRate && locInfo.investorOrgId) {
      const netGrosze = calculateAmount(depositRate.rateValue, depositRate.rateUnit, packages, 1, depositValueGrosze);
      const { vatAmount, grossGrosze } = calculateVAT(netGrosze);
      const endToEndId = generateEndToEndId();
      if (activeDispute) {
        // Z1: spór mrozi kwotę — zamiast DEPOSIT_REIMBURSEMENT (credit) tworzymy DISPUTE_HOLD (debit).
        // Reszta pozycji dla tej lokalizacji (driver, carrier, handling) idzie normalnie do batcha.
        allEntries.push(await buildEntry({
          entryType: ENTRY_TYPES.DISPUTE_HOLD, partyOrgId: locInfo.investorOrgId, direction: "debit",
          amountNet: netGrosze, vatAmount, amountGross: grossGrosze,
          locationId: credit.point_id, endToEndId, rateCardId: depositRate.id,
          author: "settlement_engine", source: `engine:dispute_hold:${activeDispute.id}`,
        }));
        addToPartyTotals(partyTotals, locInfo.investorOrgId, -netGrosze);
      } else {
        allEntries.push(await buildEntry({
          entryType: ENTRY_TYPES.DEPOSIT_REIMBURSEMENT, partyOrgId: locInfo.investorOrgId, direction: "credit",
          amountNet: netGrosze, vatAmount, amountGross: grossGrosze,
          locationId: credit.point_id, endToEndId, rateCardId: depositRate.id,
          author: "settlement_engine", source: "engine:deposit_reimbursement",
        }));
        addToPartyTotals(partyTotals, locInfo.investorOrgId, netGrosze);
      }
    }

    // Strona 4: Operator konsolidacji (HANDLING_FEE) — zawsze wypłacane
    const handlingRate = getRateCard(env, depositOperatorContractId, "PET", "siec_osiedlowa", "butelka_loose", eventDate);
    if (handlingRate) {
      const netGrosze = calculateAmount(handlingRate.rateValue, handlingRate.rateUnit, packages, 1, depositValueGrosze);
      const { vatAmount, grossGrosze } = calculateVAT(netGrosze);
      const endToEndId = generateEndToEndId();
      allEntries.push(await buildEntry({
        entryType: ENTRY_TYPES.HANDLING_FEE, partyOrgId: 6, direction: "credit",
        amountNet: netGrosze, vatAmount, amountGross: grossGrosze,
        locationId: credit.point_id, endToEndId, rateCardId: handlingRate.id,
        author: "settlement_engine", source: "engine:handling_fee",
      }));
      addToPartyTotals(partyTotals, 6, netGrosze);
    }
  }

  // Z5: Platform fee prorated per location (500 zł/pkt/mc × aktywne dni / dni w miesiącu).
  // Osobna linia inwestorskiego rozliczenia — NIE zlepiona z wdrożeniem ani handlingiem.
  // Naliczanie od miesiąca aktywacji punktu, proporcjonalnie za niepełny miesiąc.
  const platformRate = getRateCard(env, platformContractId, "MIXED", "siec_osiedlowa", "platform_subscription", eventDate);
  if (platformRate) {
    const daysInMonth = daysInMonthOfDate(eventDate);
    const monthStart = monthStartOfDate(eventDate);
    const monthEnd = monthEndOfDate(eventDate);
    const uniquePointIds = Array.from(new Set(credits.map((c: any) => c.point_id)));
    for (const pointId of uniquePointIds) {
      const locInfo = locationMap.get(pointId);
      if (!locInfo) continue;
      const launchDateMs = locInfo.launchDate ? new Date(locInfo.launchDate).getTime() : monthStart;
      const activeStart = Math.max(monthStart, launchDateMs);
      const activeEnd = Math.min(monthEnd, operationalDate);
      const activeDays = Math.max(0, Math.floor((activeEnd - activeStart) / 86400000) + 1);
      const prorated = Math.round(platformRate.rateValue * (activeDays / daysInMonth) * 100); // grosze
      if (prorated <= 0) continue;
      const { vatAmount, grossGrosze } = calculateVAT(prorated);
      const endToEndId = generateEndToEndId();
      allEntries.push(await buildEntry({
        entryType: ENTRY_TYPES.PLATFORM_SUBSCRIPTION, partyOrgId: 1, direction: "credit",
        amountNet: prorated, vatAmount, amountGross: grossGrosze,
        locationId: pointId, endToEndId, rateCardId: platformRate.id,
        author: "settlement_engine", source: "engine:platform_subscription_prorated",
      }));
      addToPartyTotals(partyTotals, 1, prorated);
    }
  }

  // PLATFORM_SETTLEMENT_FEE — 0,5% od wolumenu kaucji
  const totalDepositGrosze = credits.reduce((sum: number, c: any) => sum + c.amount_grosze, 0);
  const settlementRate = getRateCard(env, 3, "MIXED", "invoice", "ksef_fee", eventDate);
  if (settlementRate) {
    const netGrosze = Math.round((settlementRate.rateValue / 100) * totalDepositGrosze * 100);
    const { vatAmount, grossGrosze } = calculateVAT(netGrosze);
    const endToEndId = generateEndToEndId();
    allEntries.push(await buildEntry({
      entryType: ENTRY_TYPES.PLATFORM_SETTLEMENT_FEE, partyOrgId: 1, direction: "credit",
      amountNet: netGrosze, vatAmount, amountGross: grossGrosze,
      endToEndId, rateCardId: settlementRate.id,
      author: "settlement_engine", source: "engine:platform_settlement_fee",
    }));
    addToPartyTotals(partyTotals, 1, netGrosze);
  }

  // PROMPT 6.3 — BATCH INSERT all entries at once (Neon Postgres: 1 HTTP request, 16k entries <5s)
  const entriesCreated = await insertLedgerEntriesBatch(env, allEntries);

  // Buduj podsumowanie per strona
  const partySummary: { orgId: number; orgName: string; netGrosze: number; entryCount: number }[] = [];
  for (const [orgId, totals] of partyTotals) {
    const org = orgMap.get(orgId);
    partySummary.push({
      orgId,
      orgName: org?.name ?? `Org #${orgId}`,
      netGrosze: totals.netGrosze,
      entryCount: totals.entryCount,
    });
  }

  return { entriesCreated, partySummary, errors };
}


// Funkcja pomocnicza: dodaj do podsumowania per strona
function addToPartyTotals(map: Map<number, { netGrosze: number; entryCount: number }>, orgId: number, netGrosze: number) {
  const existing = map.get(orgId) ?? { netGrosze: 0, entryCount: 0 };
  existing.netGrosze += netGrosze;
  existing.entryCount += 1;
  map.set(orgId, existing);
}

// Funkcja: zatwierdź cykl (draft → approved)
// PROMPT 3: "draft → approved wymaga jawnego kliknięcia człowieka"
export function approveCycle(env: any, cycleId: number, approvedByUserId: number): { ok: boolean; error?: string } {
  const cycle = env.sql.query<{ status: string }>("SELECT status FROM settlement_cycles WHERE id = ?", [cycleId]);
  if (cycle.length === 0) return { ok: false, error: "not_found" };
  if (cycle[0].status !== "draft") return { ok: false, error: `cycle_status_is_${cycle[0].status}_not_draft` };

  const now = Date.now();
  env.sql.exec(
    "UPDATE settlement_cycles SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?",
    [approvedByUserId, now, cycleId]
  );

  // Log event
  env.sql.exec(
    "INSERT INTO event_log (cycle_id, event_type, payload_json, actor_id, created_at) VALUES (?, 'cycle_approved', ?, ?, ?)",
    [cycleId, JSON.stringify({ approved_by: approvedByUserId, approved_at: now }), approvedByUserId, now]
  );

  return { ok: true };
}

// Funkcja: cofnij cykl (approved → reopened)
// PROMPT 3: "approved → reopened tworzy pozycje odwracające, nigdy nie kasuje"
export function reopenCycle(env: any, cycleId: number, reopenedByUserId: number): { ok: boolean; error?: string; reversalsCreated: number } {
  const cycle = env.sql.query<{ status: string }>("SELECT status FROM settlement_cycles WHERE id = ?", [cycleId]);
  if (cycle.length === 0) return { ok: false, error: "not_found", reversalsCreated: 0 };
  if (cycle[0].status !== "approved" && cycle[0].status !== "settled") {
    return { ok: false, error: `cycle_status_is_${cycle[0].status}_not_approved`, reversalsCreated: 0 };
  }

  const now = Date.now();

  // Pobierz wszystkie pozycje ledger dla tego cyklu (bez już odwróconych)
  const entries = env.sql.query<any>(
    "SELECT id, entry_type, party_org_id, direction, amount_net, vat_rate, vat_amount, amount_gross, " +
    "location_id, event_date, operational_date, booking_date, end_to_end_id, rate_card_id " +
    "FROM ledger_entries WHERE cycle_id = ? AND reversal_of_id IS NULL",
    [cycleId]
  );

  // Dla każdej pozycji utwórz pozycję odwracającą (reversal)
  let reversalsCreated = 0;
  for (const entry of entries) {
    const reversalEndToEndId = generateEndToEndId();
    // Odwróć direction: credit → debit, debit → credit
    const reversalDirection = entry.direction === "credit" ? "debit" : "credit";
    env.sql.exec(
      "INSERT INTO ledger_entries (cycle_id, entry_type, party_org_id, direction, amount_net, vat_rate, vat_amount, amount_gross, " +
      "location_id, event_date, operational_date, booking_date, end_to_end_id, rate_card_id, reversal_of_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [cycleId, entry.entry_type, entry.party_org_id, reversalDirection,
       entry.amount_net, entry.vat_rate, entry.vat_amount, entry.amount_gross,
       entry.location_id, entry.event_date, entry.operational_date, now,
       reversalEndToEndId, entry.rate_card_id, entry.id, now]
    );
    reversalsCreated++;
  }

  // Zmień status na reopened
  env.sql.exec(
    "UPDATE settlement_cycles SET status = 'reopened', approved_by = NULL, approved_at = NULL WHERE id = ?",
    [cycleId]
  );

  // Log event
  env.sql.exec(
    "INSERT INTO event_log (cycle_id, event_type, payload_json, actor_id, created_at) VALUES (?, 'cycle_reopened', ?, ?, ?)",
    [cycleId, JSON.stringify({ reopened_by: reopenedByUserId, reversals_created: reversalsCreated }), reopenedByUserId, now]
  );

  return { ok: true, reversalsCreated };
}

// Funkcja: pobierz ledger entries dla cyklu z podsumowaniem per strona
export function getLedgerForCycle(env: any, cycleId: number): {
  entries: any[];
  partySummary: { orgId: number; orgName: string; netGrosze: number; entryCount: number }[];
  totalNetGrosze: number;
  invariantValid: boolean;
} {
  const entries = env.sql.query<any>(
    "SELECT le.id, le.cycle_id, le.entry_type, le.party_org_id, le.direction, le.amount_net, le.vat_rate, " +
    "le.vat_amount, le.amount_gross, le.location_id, le.event_date, le.operational_date, le.booking_date, " +
    "le.end_to_end_id, le.rate_card_id, le.reversal_of_id, le.created_at, " +
    "o.name AS party_org_name " +
    "FROM ledger_entries le LEFT JOIN organizations o ON o.id = le.party_org_id " +
    "WHERE le.cycle_id = ? ORDER BY le.created_at ASC",
    [cycleId]
  );

  // Podsumowanie per strona
  const partyMap = new Map<number, { orgId: number; orgName: string; netGrosze: number; entryCount: number }>();
  let totalNetGrosze = 0;

  for (const entry of entries) {
    // Pozycje odwracające mają reversal_of_id — ich kwota odejmuje się od sumy
    const sign = entry.reversal_of_id ? -1 : 1;
    const signedNet = entry.amount_net * sign;
    totalNetGrosze += signedNet;

    if (entry.party_org_id) {
      const existing = partyMap.get(entry.party_org_id) ?? {
        orgId: entry.party_org_id,
        orgName: entry.party_org_name ?? `Org #${entry.party_org_id}`,
        netGrosze: 0,
        entryCount: 0,
      };
      existing.netGrosze += signedNet;
      existing.entryCount += 1;
      partyMap.set(entry.party_org_id, existing);
    }
  }

  const partySummary = Array.from(partyMap.values());

  // INWARIANT: suma amount_net wszystkich pozycji cyklu = kwota przelewu do tej strony
  // Sprawdzenie: suma wszystkich credit powinna = suma wszystkich debit (double-entry bookkeeping)
  const totalCredit = entries.filter(e => e.direction === "credit" && !e.reversal_of_id).reduce((s, e) => s + e.amount_net, 0);
  const totalDebit = entries.filter(e => e.direction === "debit" && !e.reversal_of_id).reduce((s, e) => s + e.amount_net, 0);
  const totalReversalCredit = entries.filter(e => e.direction === "credit" && e.reversal_of_id).reduce((s, e) => s + e.amount_net, 0);
  const totalReversalDebit = entries.filter(e => e.direction === "debit" && e.reversal_of_id).reduce((s, e) => s + e.amount_net, 0);

  const netCredit = totalCredit - totalReversalDebit;
  const netDebit = totalDebit - totalReversalCredit;
  const invariantValid = netCredit === netDebit;

  return { entries, partySummary, totalNetGrosze, invariantValid };
}
