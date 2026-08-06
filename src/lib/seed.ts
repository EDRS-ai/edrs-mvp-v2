import { hashPassword, newToken } from "./auth";
import { investors, drivers, points, collections, settlements, invoices, users, invites, sessions, settlementCycles, operatorCredits, sorterReceipts, eventLog, organizations, regions, locations, locationOperators, devices, deviceShadow, deviceHeartbeats, contracts, rateCards, logisticMinimums, memberships, operatorTerms } from "../schema";

const POINTS_DATA = [
  { id: "NET-001", address: "Osiedle Wilanów, ul. Klimczaka 12", district: "Wilanów", fill: 87, monthlyPackages: 62000 },
  { id: "NET-002", address: "Osiedle Mokotów, ul. Puławska 145", district: "Mokotów", fill: 62, monthlyPackages: 58000 },
  { id: "NET-003", address: "Osiedle Ursynów, ul. Płaskowickiej 8", district: "Ursynów", fill: 94, monthlyPackages: 72000 },
  { id: "NET-004", address: "Osiedle Bielany, ul. Żeromskiego 3", district: "Bielany", fill: 41, monthlyPackages: 51000, investor: "B" },
  { id: "NET-005", address: "Osiedle Wola, ul. Kasprzaka 15", district: "Wola", fill: 78, monthlyPackages: 64000 },
  { id: "NET-006", address: "Osiedle Praga, ul. Targowa 67", district: "Praga", fill: 23, monthlyPackages: 45000, investor: "B" },
  { id: "NET-007", address: "Osiedle Ursus, ul. Dziekanowska 5", district: "Ursus", fill: 91, monthlyPackages: 68000 },
  { id: "NET-008", address: "Osiedle Bemowo, ul. Powstańców Śląskich 100", district: "Bemowo", fill: 56, monthlyPackages: 55000 },
  { id: "NET-009", address: "Osiedle Ochota, ul. Grójecka 50", district: "Ochota", fill: 73, monthlyPackages: 60000 },
  { id: "NET-010", address: "Osiedle Targówek, ul. Głębocka 13", district: "Targówek", fill: 49, monthlyPackages: 50000, investor: "B" },
];

const DRIVERS_DATA = [
  { name: "Jan Kowalski", type: "JDG", company: null, bdo: "000123456", verified: 1, gps: "WA12345" },
  { name: "Marek Nowak", type: "firma", company: "Trans-Eko Sp. z o.o.", bdo: "000234567", verified: 1, gps: "WA23456" },
  { name: "Piotr Wiśniewski", type: "firma", company: "Recykling-Trans S.J.", bdo: "000345678", verified: 1, gps: "WA34567" },
  { name: "Tomasz Wójcik", type: "JDG", company: null, bdo: "000456789", verified: 0, gps: "WA45678" },
  { name: "Adam Kowalczyk", type: "firma", company: "EkoLogistyka Sp. z o.o.", bdo: "000567890", verified: 1, gps: "WA56789" },
];

const RECENT_COLLECTIONS = [
  { point: "NET-006", driverIdx: 0, packages: 1980, hoursAgo: 1.6 },
  { point: "NET-002", driverIdx: 1, packages: 2150, hoursAgo: 2.9 },
  { point: "NET-010", driverIdx: 2, packages: 1830, hoursAgo: 4.8 },
  { point: "NET-005", driverIdx: 3, packages: 2200, hoursAgo: 6.6 },
  { point: "NET-004", driverIdx: 4, packages: 1990, hoursAgo: 7.3 },
  { point: "NET-001", driverIdx: 0, packages: 2050, hoursAgo: 22 },
  { point: "NET-009", driverIdx: 1, packages: 1920, hoursAgo: 24 },
  { point: "NET-007", driverIdx: 2, packages: 2100, hoursAgo: 26 },
  { point: "NET-003", driverIdx: 0, packages: 2180, hoursAgo: 28 },
  { point: "NET-008", driverIdx: 3, packages: 1980, hoursAgo: 30 },
  { point: "NET-002", driverIdx: 4, packages: 2010, hoursAgo: 48 },
  { point: "NET-005", driverIdx: 0, packages: 2050, hoursAgo: 50 },
];

const SETTLEMENTS_DATA = [
  { party: "Kierowcy (5 firm transportowych)", partyType: "driver", count: 342, rate: "0,03 zł/szt", netGrosze: 1836000, vatGrosze: 431000, grossGrosze: 2267000 },
  { party: "Firmy transportowe (handling)", partyType: "transport", count: 342, rate: "0,05 zł/szt", netGrosze: 306000, vatGrosze: 72000, grossGrosze: 378000 },
  { party: "Inwestorzy RVM (handling fee) - A", partyType: "investor", investorIdx: 0, count: 7, rate: "500 zł/pkt", netGrosze: 350000, vatGrosze: 82200, grossGrosze: 432200 },
  { party: "Inwestorzy RVM (handling fee) - B", partyType: "investor", investorIdx: 1, count: 3, rate: "500 zł/pkt", netGrosze: 150000, vatGrosze: 35250, grossGrosze: 185250 },
  { party: "Operator konsolidacji (Reselekt)", partyType: "consolidator", count: 1, rate: "umowa", netGrosze: 6000, vatGrosze: 1400, grossGrosze: 7400 },
];

const INVOICES_DATA = [
  { ksef: "KSF/2026/07/0001", recipient: "Inwestor A - Wilanów", title: "Obsługa RVM NET-001..003 lipiec 2026", amountGrosze: 215470, issueDate: "2026-07-01", investorIdx: 0 },
  { ksef: "KSF/2026/07/0002", recipient: "Inwestor A - Mokotów", title: "Obsługa RVM NET-005,007,008,009 lipiec 2026", amountGrosze: 287100, issueDate: "2026-07-01", investorIdx: 0 },
  { ksef: "KSF/2026/07/0003", recipient: "Inwestor B - Bielany", title: "Obsługa RVM NET-004 lipiec 2026", amountGrosze: 71700, issueDate: "2026-07-01", investorIdx: 1 },
  { ksef: "KSF/2026/07/0004", recipient: "Inwestor B - Praga/Targówek", title: "Obsługa RVM NET-006,010 lipiec 2026", amountGrosze: 113550, issueDate: "2026-07-01", investorIdx: 1 },
  { ksef: "KSF/2026/07/0005", recipient: "Jan Kowalski (JDG)", title: "Odbiór 78 transportów lipiec", amountGrosze: 165000, issueDate: "2026-07-01", driverIdx: 0 },
  { ksef: "KSF/2026/07/0006", recipient: "Marek Nowak (Trans-Eko)", title: "Odbiór 92 transportów lipiec", amountGrosze: 194000, issueDate: "2026-07-01", driverIdx: 1 },
  { ksef: "KSF/2026/07/0007", recipient: "Piotr Wiśniewski (Recykling-Trans)", title: "Odbiór 84 transportów lipiec", amountGrosze: 177000, issueDate: "2026-07-01", driverIdx: 2 },
];

// ─── PROMPT 1: organizations (multi-tenant root) ────────────────────────────────
const ORGANIZATIONS_DATA = [
  { id: 1, type: "network_operator", name: "edrs.io Sp. z o.o.", nip: "5260250995", krs: "0000912345", vatWhitelistStatus: "active", vatWhitelistCheckedAt: 1735689600000 },
  { id: 2, type: "investor", name: "Wspólnota Wilanów / Inwestor A", nip: "5261234567", vatWhitelistStatus: "active", vatWhitelistCheckedAt: 1735689600000 },
  { id: 3, type: "investor", name: "Fundacja Eko Praga / Inwestor B", nip: "5262345678", vatWhitelistStatus: "active", vatWhitelistCheckedAt: 1735689600000 },
  { id: 4, type: "housing_coop", name: "SM \"Śląsk\" Katowice", nip: "6340123456", vatWhitelistStatus: "missing" },
  { id: 5, type: "carrier", name: "EcoAction S.A.", nip: "5263456789" },
  { id: 6, type: "deposit_operator", name: "Reselekt System Kaucyjny Sp. z o.o.", nip: "5264567890" },
  { id: 7, type: "bank", name: "KSeF Bank (faktury)", nip: "5265678901" },
  { id: 8, type: "acquirer", name: "PolCard / Fiserv Polska", nip: "5266789012" },
];

// ─── PROMPT 1: regions ──────────────────────────────────────────────────────────
const REGIONS_DATA = [
  { id: 1, name: "Śląsk", hubOrgId: 1 },
  { id: 2, name: "Mazowsze", hubOrgId: 1 },
];

// ─── PROMPT 1: 24 lokalizacje na Śląsku ────────────────────────────────────────
// Inwestor A (Wspólnota Wilanów) → SL-001..SL-023 (23 punktów)
// Spółdzielnia Katowice (housing_coop) → SL-024 (1 punkt — per spec "JEDEN punkt")
const SLASK_LOCATIONS_DATA = [
  { id: "SL-001", address: "Katowice Śródmieście, ul. Adama Mickiewicza 12", district: "Śródmieście", lat: 50.2584, lng: 19.0275, investorOrgId: 2, fill: 87, monthlyPackages: 6200 },
  { id: "SL-002", address: "Katowice Koszutka, ul. Gen. Józefa Bema 5", district: "Koszutka", lat: 50.2700, lng: 19.0350, investorOrgId: 2, fill: 62, monthlyPackages: 5800 },
  { id: "SL-003", address: "Katowice Brynów, ul. Józefa Wieczorka 8", district: "Brynów", lat: 50.2450, lng: 19.0150, investorOrgId: 2, fill: 94, monthlyPackages: 7100 },
  { id: "SL-004", address: "Katowice Ligota, ul. Panewnicka 100", district: "Ligota", lat: 50.2300, lng: 19.0000, investorOrgId: 2, fill: 41, monthlyPackages: 4900 },
  { id: "SL-005", address: "Katowice Podlesie, ul. Uniczowska 17", district: "Podlesie", lat: 50.2200, lng: 19.0500, investorOrgId: 2, fill: 78, monthlyPackages: 6300 },
  { id: "SL-006", address: "Gliwice Śródmieście, ul. Zwycięstwa 15", district: "Śródmieście", lat: 50.2945, lng: 18.6714, investorOrgId: 2, fill: 88, monthlyPackages: 6500 },
  { id: "SL-007", address: "Gliwice Sośnica, ul. Łabędzka 3", district: "Sośnica", lat: 50.3150, lng: 18.6500, investorOrgId: 2, fill: 56, monthlyPackages: 5100 },
  { id: "SL-008", address: "Gliwice Łabędy, ul. Sikornik 22", district: "Łabędy", lat: 50.3200, lng: 18.6900, investorOrgId: 2, fill: 73, monthlyPackages: 5900 },
  { id: "SL-009", address: "Gliwice Czechowice, ul. Jasna 8", district: "Czechowice", lat: 50.3000, lng: 18.6800, investorOrgId: 2, fill: 49, monthlyPackages: 4700 },
  { id: "SL-010", address: "Zabrze Śródmieście, ul. Wolności 45", district: "Śródmieście", lat: 50.3249, lng: 18.7857, investorOrgId: 2, fill: 91, monthlyPackages: 6800 },
  { id: "SL-011", address: "Zabrze Biskupice, ul. Jordana 12", district: "Biskupice", lat: 50.3300, lng: 18.8000, investorOrgId: 2, fill: 65, monthlyPackages: 5400 },
  { id: "SL-012", address: "Zabrze Rokitnica, ul. Tarnogórska 100", district: "Rokitnica", lat: 50.3400, lng: 18.7700, investorOrgId: 2, fill: 82, monthlyPackages: 6100 },
  { id: "SL-013", address: "Bytom Śródmieście, ul. Piekarska 5", district: "Śródmieście", lat: 50.3480, lng: 18.9150, investorOrgId: 2, fill: 77, monthlyPackages: 5800 },
  { id: "SL-014", address: "Bytom Karb, ul. Witczaka 17", district: "Karb", lat: 50.3600, lng: 18.9300, investorOrgId: 2, fill: 53, monthlyPackages: 4900 },
  { id: "SL-015", address: "Bytom Stroszek, ul. Strzelców Bytomskich 8", district: "Stroszek", lat: 50.3550, lng: 18.9400, investorOrgId: 2, fill: 69, monthlyPackages: 5500 },
  { id: "SL-016", address: "Chorzów Śródmieście, ul. Wolności 22", district: "Śródmieście", lat: 50.2970, lng: 18.9500, investorOrgId: 2, fill: 84, monthlyPackages: 6400 },
  { id: "SL-017", address: "Chorzów Maciejkowice, ul. Inwalidzka 5", district: "Maciejkowice", lat: 50.3050, lng: 18.9600, investorOrgId: 2, fill: 47, monthlyPackages: 4400 },
  { id: "SL-018", address: "Chorzów Batory, ul. Kościuszki 33", district: "Batory", lat: 50.2900, lng: 18.9700, investorOrgId: 2, fill: 61, monthlyPackages: 5200 },
  { id: "SL-019", address: "Sosnowiec Śródmieście, ul. Modrzejowska 12", district: "Śródmieście", lat: 50.2860, lng: 19.1040, investorOrgId: 2, fill: 92, monthlyPackages: 7000 },
  { id: "SL-020", address: "Sosnowiec Zagórze, ul. Braci Mieroszewskich 8", district: "Zagórze", lat: 50.2950, lng: 19.1200, investorOrgId: 2, fill: 58, monthlyPackages: 5300 },
  { id: "SL-021", address: "Sosnowiec Kazimierz, ul. 11 Listopada 50", district: "Kazimierz", lat: 50.2800, lng: 19.1100, investorOrgId: 2, fill: 71, monthlyPackages: 5600 },
  { id: "SL-022", address: "Tychy Śródmieście, ul. Piłsudskiego 12", district: "Śródmieście", lat: 50.1210, lng: 18.9850, investorOrgId: 2, fill: 66, monthlyPackages: 5200 },
  { id: "SL-023", address: "Tychy Wilkowyje, ul. Edukacji 5", district: "Wilkowyje", lat: 50.1300, lng: 19.0000, investorOrgId: 2, fill: 49, monthlyPackages: 4600 },
  { id: "SL-024", address: "Dąbrowa Górnicza Śródmieście, ul. 3 Maja 22", district: "Śródmieście", lat: 50.3230, lng: 19.1930, investorOrgId: 4, coopOrgId: 4, fill: 72, monthlyPackages: 4800 },
];

// ─── PROMPT 1: 20 maszyn EcoAction ─────────────────────────────────────────────
const DEVICES_DATA = [
  { id: "EA-Cube-KTW-001", serial: "EAC-KTW-001", locationId: "SL-001" },
  { id: "EA-Cube-KTW-002", serial: "EAC-KTW-002", locationId: "SL-001" },
  { id: "EA-Cube-KTW-003", serial: "EAC-KTW-003", locationId: "SL-002" },
  { id: "EA-Cube-KTW-004", serial: "EAC-KTW-004", locationId: "SL-003" },
  { id: "EA-Cube-KTW-005", serial: "EAC-KTW-005", locationId: "SL-004" },
  { id: "EA-Cube-KTW-006", serial: "EAC-KTW-006", locationId: "SL-005" },
  { id: "EA-Cube-GLW-001", serial: "EAC-GLW-001", locationId: "SL-006" },
  { id: "EA-Cube-GLW-002", serial: "EAC-GLW-002", locationId: "SL-007" },
  { id: "EA-Cube-GLW-003", serial: "EAC-GLW-003", locationId: "SL-008" },
  { id: "EA-Cube-ZBR-001", serial: "EAC-ZBR-001", locationId: "SL-010" },
  { id: "EA-Cube-ZBR-002", serial: "EAC-ZBR-002", locationId: "SL-011" },
  { id: "EA-Cube-BTM-001", serial: "EAC-BTM-001", locationId: "SL-013" },
  { id: "EA-Cube-BTM-002", serial: "EAC-BTM-002", locationId: "SL-014" },
  { id: "EA-Cube-CHZ-001", serial: "EAC-CHZ-001", locationId: "SL-016" },
  { id: "EA-Cube-CHZ-002", serial: "EAC-CHZ-002", locationId: "SL-016" },
  { id: "EA-Cube-CHZ-003", serial: "EAC-CHZ-003", locationId: "SL-017" },
  { id: "EA-Cube-SOS-001", serial: "EAC-SOS-001", locationId: "SL-019" },
  { id: "EA-Cube-SOS-002", serial: "EAC-SOS-002", locationId: "SL-019" },
  { id: "EA-Cube-TCH-001", serial: "EAC-TCH-001", locationId: "SL-022" },
  { id: "EA-Cube-DGB-001", serial: "EAC-DGB-001", locationId: "SL-024" },
];

// ─── PROMPT 1: location_operators (n:m) — jeden punkt może mieć wielu operatorów
const LOCATION_OPERATORS_DATA = [
  { locationId: "SL-001", operatorOrgId: 5, activeFrom: 1704067200000 },
  { locationId: "SL-001", operatorOrgId: 6, activeFrom: 1735689600000 },
  { locationId: "SL-006", operatorOrgId: 5, activeFrom: 1704067200000 },
  { locationId: "SL-010", operatorOrgId: 6, activeFrom: 1704067200000 },
  { locationId: "SL-016", operatorOrgId: 5, activeFrom: 1704067200000 },
  { locationId: "SL-019", operatorOrgId: 6, activeFrom: 1704067200000 },
  { locationId: "SL-024", operatorOrgId: 5, activeFrom: 1735689600000 },
];

// ─── PROMPT 1: contracts ──────────────────────────────────────────────────────
const CONTRACTS_DATA = [
  { id: 1, type: "carrier", partyAOrgId: 1, partyBOrgId: 5, validFrom: 1704067200000, noticePeriodDays: 90 },
  { id: 2, type: "ipz_operator", partyAOrgId: 1, partyBOrgId: 6, validFrom: 1704067200000, noticePeriodDays: 60 },
  { id: 3, type: "service", partyAOrgId: 1, partyBOrgId: 7, validFrom: 1735689600000, noticePeriodDays: 30 },
  { id: 4, type: "acquirer", partyAOrgId: 1, partyBOrgId: 8, validFrom: 1748736000000, noticePeriodDays: 30 },
];

// ─── PROMPT 1: rate_cards (KLUCZOWE — zero stawek w kodzie!)
// Historia stawek z valid_from/valid_to. Przeliczenie bierze stawkę Z DATY ZDARZENIA.
// Wartości 0,17 / 0,20 / 0,23 / 500 / 0,03 to przykłady z PROMPT 1 — dozwolone w seed.
const RATE_CARDS_DATA = [
  // Kontrakt 1: edrs.io ↔ EcoAction (carrier) — handling fee za odbiór z RVM
  { contractId: 1, validFrom: 1704067200000, validTo: 1735689599999, fraction: "PET", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.15, rateUnit: "PLN_PER_UNIT", description: "PET mixed handling fee 2024" },
  { contractId: 1, validFrom: 1735689600000, validTo: 1767225599999, fraction: "PET", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.16, rateUnit: "PLN_PER_UNIT", description: "PET mixed handling fee 2025" },
  { contractId: 1, validFrom: 1767225600000, validTo: null, fraction: "PET", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.17, rateUnit: "PLN_PER_UNIT", description: "PET mixed handling fee 2026 (current)" },
  { contractId: 1, validFrom: 1704067200000, validTo: null, fraction: "PET", collectionModel: "siec_osiedlowa", packagingType: "butelka_loose", rateValue: 0.20, rateUnit: "PLN_PER_UNIT", description: "PET separated handling fee" },
  { contractId: 1, validFrom: 1704067200000, validTo: null, fraction: "ALU", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.23, rateUnit: "PLN_PER_UNIT", description: "ALU handling fee" },
  { contractId: 1, validFrom: 1704067200000, validTo: null, fraction: "GLASS", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.12, rateUnit: "PLN_PER_UNIT", description: "GLASS handling fee" },
  // Kontrakt 2: edrs.io ↔ Reselekt (deposit_operator) — deposit kaucji
  { contractId: 2, validFrom: 1704067200000, validTo: 1735689599999, fraction: "PET", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.18, rateUnit: "PLN_PER_UNIT", description: "PET deposit 2024" },
  { contractId: 2, validFrom: 1735689600000, validTo: 1767225599999, fraction: "PET", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.20, rateUnit: "PLN_PER_UNIT", description: "PET deposit 2025" },
  { contractId: 2, validFrom: 1767225600000, validTo: null, fraction: "PET", collectionModel: "siec_osiedlowa", packagingType: "kostka_pressed", rateValue: 0.23, rateUnit: "PLN_PER_UNIT", description: "PET deposit 2026 (current)" },
  { contractId: 2, validFrom: 1704067200000, validTo: null, fraction: "MIXED", collectionModel: "siec_osiedlowa", packagingType: "platform_subscription", rateValue: 500, rateUnit: "PLN_PER_POINT_MONTH", description: "Platform subscription per point per month" },
  // Kontrakt 3: edrs.io ↔ KSeF-bank — invoice fee
  { contractId: 3, validFrom: 1735689600000, validTo: null, fraction: "MIXED", collectionModel: "invoice", packagingType: "ksef_fee", rateValue: 0.03, rateUnit: "PCT", description: "KSeF invoice fee" },
  // Kontrakt 4: edrs.io ↔ PolCard — acquirer fee
  { contractId: 4, validFrom: 1748736000000, validTo: null, fraction: "MIXED", collectionModel: "payment", packagingType: "acquirer_fee", rateValue: 0.02, rateUnit: "PCT", description: "PolCard acquirer fee" },
];

// ─── PROMPT 1: logistic_minimums ──────────────────────────────────────────────
const LOGISTIC_MINIMUMS_DATA = [
  { contractId: 1, frequency: "5_day", minimumUnits: 200, incidentalPickupFeeGrosze: 50000 },
  { contractId: 2, frequency: "5_day", minimumUnits: 100, incidentalPickupFeeGrosze: 30000 },
];

const SEED_PASSWORD = "edrs2026";

export async function ensureSeeded(env: any) {
  const existing = env.sql.query<{ value: string }>("SELECT value FROM meta WHERE key='seeded'");
  if (existing.length === 0) {
    await seed(env);
    env.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', ?)", [new Date().toISOString()]);
    await seedPrompt1(env);
    return;
  }
  await backfillSprint2(env);
  await backfillPrompt2Tables(env);
  await backfillPrompt3Tables(env);
  await backfillPrompt4Tables(env);
  await backfillPrompt5Tables(env);
  await seedPrompt1(env);
  await seedPrompt5OperatorTerms(env);
}

// PROMPT 4 backfill: tworzy reconciliations + disputes IF NOT EXISTS
async function backfillPrompt4Tables(env: any) {
  const tableCheck = env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='reconciliations'");
  if (Number(tableCheck[0]?.n ?? 0) > 0) return;

  env.sql.exec(`CREATE TABLE IF NOT EXISTS reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER,
    scope_type TEXT NOT NULL,
    scope_ref TEXT NOT NULL,
    source_a_json TEXT,
    source_b_json TEXT,
    source_c_json TEXT,
    delta_ab REAL,
    delta_bc REAL,
    delta_ac REAL,
    delta_pct REAL,
    status TEXT NOT NULL DEFAULT 'matched',
    created_at INTEGER NOT NULL
  )`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS reconciliations_cycle_idx ON reconciliations(cycle_id)`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS reconciliations_scope_idx ON reconciliations(scope_type, scope_ref)`);

  env.sql.exec(`CREATE TABLE IF NOT EXISTS disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciliation_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'INQUIRY_EVIDENCE_REQUIRED',
    due_at INTEGER NOT NULL,
    evidence_json TEXT,
    disputed_amount_grosze INTEGER,
    outcome TEXT,
    default_action_taken INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS disputes_reconciliation_idx ON disputes(reconciliation_id)`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS disputes_state_idx ON disputes(state)`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS disputes_due_idx ON disputes(due_at)`);
}
// PROMPT 3 backfill: tworzy ledger_entries IF NOT EXISTS + ALTER TABLE settlement_cycles
async function backfillPrompt3Tables(env: any) {
  // 1. CREATE TABLE IF NOT EXISTS ledger_entries
  env.sql.exec(`CREATE TABLE IF NOT EXISTS ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    party_org_id INTEGER,
    direction TEXT NOT NULL,
    amount_net INTEGER NOT NULL,
    vat_rate REAL NOT NULL DEFAULT 23,
    vat_amount INTEGER NOT NULL,
    amount_gross INTEGER NOT NULL,
    location_id TEXT,
    device_id TEXT,
    event_date INTEGER,
    operational_date INTEGER,
    booking_date INTEGER,
    source_event_id INTEGER,
    end_to_end_id TEXT,
    invoice_id INTEGER,
    rate_card_id INTEGER,
    reversal_of_id INTEGER,
    created_at INTEGER NOT NULL
  )`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS ledger_entries_cycle_idx ON ledger_entries(cycle_id)`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS ledger_entries_party_idx ON ledger_entries(party_org_id)`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS ledger_entries_entry_type_idx ON ledger_entries(entry_type)`);
  env.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_end_to_end_idx ON ledger_entries(end_to_end_id)`);

  // 2. ALTER TABLE settlement_cycles: dodaj kolumny PROMPT 3 (nullable)
  const scCols = env.sql.query<{ name: string }>("PRAGMA table_info(settlement_cycles)");
  const scColNames = new Set(scCols.map((c: any) => c.name));
  if (!scColNames.has("cycle_type")) env.sql.exec("ALTER TABLE settlement_cycles ADD cycle_type TEXT");
  if (!scColNames.has("contract_id")) env.sql.exec("ALTER TABLE settlement_cycles ADD contract_id INTEGER");
  if (!scColNames.has("approved_by")) env.sql.exec("ALTER TABLE settlement_cycles ADD approved_by INTEGER");
  if (!scColNames.has("approved_at")) env.sql.exec("ALTER TABLE settlement_cycles ADD approved_at INTEGER");
}

// PROMPT 2 backfill: tworzy tabele IF NOT EXISTS w locie, potem seeduje
// Używane gdy stara baza na Workerze nie ma tabel PROMPT 2
// (migracja 0002 nie przeszła przez NOT NULL constraint)
async function backfillPrompt2Tables(env: any) {
  // Sprawdź czy import_profiles istnieje
  const tableCheck = env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='import_profiles'");
  if (Number(tableCheck[0]?.n ?? 0) > 0) return; // już istnieje

  // CREATE TABLE IF NOT EXISTS dla wszystkich tabel PROMPT 2
  env.sql.exec(`CREATE TABLE IF NOT EXISTS import_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    org_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    mapping_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS import_profiles_org_idx ON import_profiles(org_id)`);

  env.sql.exec(`CREATE TABLE IF NOT EXISTS catalog_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    version TEXT NOT NULL,
    checksum TEXT,
    imported_at INTEGER NOT NULL,
    item_count INTEGER NOT NULL
  )`);

  env.sql.exec(`CREATE TABLE IF NOT EXISTS packaging_items (
    ean TEXT PRIMARY KEY NOT NULL,
    barcode_format TEXT,
    barcode_width INTEGER,
    barcode_height INTEGER,
    product_name TEXT,
    volume_ml INTEGER,
    material TEXT,
    fraction TEXT,
    fraction_colour TEXT,
    weight_without_cap_g REAL,
    weight_total_g REAL,
    height_without_cap_mm REAL,
    height_total_mm REAL,
    width_mm REAL,
    length_mm REAL,
    market_entry_date TEXT,
    market_withdrawal_date TEXT,
    producer TEXT,
    deposit_amount_grosze INTEGER,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  env.sql.exec(`CREATE TABLE IF NOT EXISTS catalog_overrides (
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
  )`);
  env.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS catalog_overrides_ean_scope_idx ON catalog_overrides(ean, scope, scope_id)`);

  // ALTER TABLE event_log: dodaj kolumny PROMPT 2 (nullable, bez NOT NULL constraint)
  const cols = env.sql.query<{ name: string }>("PRAGMA table_info(event_log)");
  const colNames = new Set(cols.map((c: any) => c.name));
  if (!colNames.has("idempotency_key")) env.sql.exec("ALTER TABLE event_log ADD idempotency_key TEXT");
  if (!colNames.has("source")) env.sql.exec("ALTER TABLE event_log ADD source TEXT");
  if (!colNames.has("received_at")) env.sql.exec("ALTER TABLE event_log ADD received_at INTEGER");
  if (!colNames.has("processed_at")) env.sql.exec("ALTER TABLE event_log ADD processed_at INTEGER");
  if (!colNames.has("processing_error")) env.sql.exec("ALTER TABLE event_log ADD processing_error TEXT");
  if (!colNames.has("correlation_id")) env.sql.exec("ALTER TABLE event_log ADD correlation_id TEXT");
  env.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS event_log_idempotency_idx ON event_log(idempotency_key)");
}

async function backfillSprint2(env: any) {
  const cycleCount = Number(env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM settlement_cycles")[0]?.n ?? 0);
  if (cycleCount > 0) return;
  const now = Date.now();
  const cyclePeriods = [
    { label: "2026-W26", start: now - 15 * 86400000, end: now - 10 * 86400000, status: "closed" as const },
    { label: "2026-W27", start: now - 10 * 86400000, end: now - 5 * 86400000, status: "reconciling" as const },
    { label: "2026-W28", start: now - 5 * 86400000, end: now, status: "open" as const },
  ];
  const cycleIds: number[] = [];
  for (const cp of cyclePeriods) {
    env.sql.exec(
      "INSERT INTO settlement_cycles (label, period_start, period_end, status, created_at, created_by, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [cp.label, cp.start, cp.end, cp.status, cp.start, 1, cp.status === "closed" ? cp.end + 86400000 : null]
    );
    cycleIds.push(Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id));
  }
  const pointsList = POINTS_DATA.map((p) => p.id);
  const collectionsByPoint: Record<string, number> = {};
  for (const c of RECENT_COLLECTIONS) {
    collectionsByPoint[c.point] = (collectionsByPoint[c.point] ?? 0) + c.packages;
  }
  for (let i = 0; i < cycleIds.length; i++) {
    const cp = cyclePeriods[i];
    const cycId = cycleIds[i];
    for (const pid of pointsList) {
      const deviceBase = collectionsByPoint[pid] ?? 2000;
      const sorter = Math.round(deviceBase * (pid === "NET-007" && cp.label === "2026-W27" ? 0.97 : 1.01));
      const operator = Math.round(deviceBase * 1.0);
      const amountGrosze = operator * 50;
      env.sql.exec(
        "INSERT INTO operator_credits (cycle_id, point_id, packages, amount_grosze, source_csv, source_row, source_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [cycId, pid, operator, amountGrosze, "reselekt-" + cp.label + ".csv", 1, "RES-" + cp.label + "-" + pid, now]
      );
      if (cp.label !== "2026-W28") {
        env.sql.exec(
          "INSERT INTO sorter_receipts (cycle_id, point_id, packages, source_csv, source_row, source_reference, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [cycId, pid, sorter, "sorter-" + cp.label + ".csv", 1, "SOR-" + cp.label + "-" + pid, cp.end, now]
        );
      }
      env.sql.exec(
        "INSERT INTO event_log (cycle_id, point_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [cycId, pid, "seed_initial_data", JSON.stringify({ device: Math.round(deviceBase * (cp.label === "2026-W26" ? 0.6 : cp.label === "2026-W27" ? 0.5 : 0)), sorter, operator }), 1, now]
      );
    }
    env.sql.exec("INSERT INTO event_log (cycle_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?)", [cycId, "cycle_created", JSON.stringify({ label: cp.label, source: "backfill" }), 1, cp.start]);
    if (cp.status === "closed") {
      env.sql.exec("INSERT INTO event_log (cycle_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?)", [cycId, "cycle_closed", JSON.stringify({ source: "backfill" }), 1, cp.end + 86400000]);
    }
  }
}

// Sprint 2 PROMPT 1 — seed nowych tabel (organizations, regions, locations, devices,
// location_operators, contracts, rate_cards, logistic_minimums). Idempotentny:
// sprawdza czy organizations jest puste. Jeśli tak, wypełnia. Jeśli nie — skip.
// Handler.ts zostanie przeniesiony na nowe tabele w następnej sesji (PROMPT 1 część 2).
async function seedPrompt1(env: any) {
  const orgCount = Number(env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM organizations")[0]?.n ?? 0);
  if (orgCount > 0) return; // już wypełnione (np. po reseed lub poprzednim deployu)

  const now = Date.now();

  // 1. organizations (8: network_operator, 2× investor, housing_coop, carrier, deposit_operator, bank, acquirer)
  for (const o of ORGANIZATIONS_DATA) {
    env.sql.exec(
      "INSERT INTO organizations (id, type, name, nip, krs, vat_whitelist_status, vat_whitelist_checked_at, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)",
      [o.id, o.type, o.name, o.nip ?? null, o.krs ?? null, o.vatWhitelistStatus ?? null, o.vatWhitelistCheckedAt ?? null, now, now]
    );
  }

  // 2. regions (Śląsk + Mazowsze)
  for (const r of REGIONS_DATA) {
    env.sql.exec(
      "INSERT INTO regions (id, name, hub_org_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)",
      [r.id, r.name, r.hubOrgId, now, now]
    );
  }

  // 3. locations (24 Śląsk: 23 Inwestor A + 1 Spółdzielnia Katowice)
  for (const l of SLASK_LOCATIONS_DATA) {
    env.sql.exec(
      "INSERT INTO locations (id, address, district, lat, lng, region_id, investor_org_id, coop_org_id, fill_level, status, monthly_packages, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'online', ?, ?, ?, 1)",
      [l.id, l.address, l.district, l.lat, l.lng, l.investorOrgId, l.coopOrgId ?? null, l.fill, l.monthlyPackages, now, now]
    );
  }

  // 4. devices (20 maszyn EcoAction)
  for (const d of DEVICES_DATA) {
    env.sql.exec(
      "INSERT INTO devices (id, serial, manufacturer, model, status, location_id, installed_at, created_at, updated_at, version) VALUES (?, ?, 'EcoAction', 'Cube', 'active', ?, ?, ?, ?, 1)",
      [d.id, d.serial, d.locationId, now, now, now]
    );
  }

  // 5. location_operators (n:m — jeden punkt może mieć wielu operatorów)
  for (const lo of LOCATION_OPERATORS_DATA) {
    env.sql.exec(
      "INSERT INTO location_operators (location_id, operator_org_id, active_from, active_to, created_at) VALUES (?, ?, ?, NULL, ?)",
      [lo.locationId, lo.operatorOrgId, lo.activeFrom, now]
    );
  }

  // 6. contracts (4: edrs.io ↔ EcoAction / Reselekt / KSeF-bank / PolCard)
  for (const c of CONTRACTS_DATA) {
    env.sql.exec(
      "INSERT INTO contracts (id, type, party_a_org_id, party_b_org_id, valid_from, valid_to, notice_period_days, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, 1)",
      [c.id, c.type, c.partyAOrgId, c.partyBOrgId, c.validFrom, c.noticePeriodDays, now, now]
    );
  }

  // 7. rate_cards (KLUCZOWE — zero stawek w kodzie!)
  // Historia stawek z valid_from/valid_to. Przeliczenie bierze stawkę Z DATY ZDARZENIA.
  // Wartości 0,17 / 0,20 / 0,23 / 500 / 0,03 to przykłady z PROMPT 1 — dozwolone w seed.
  for (const r of RATE_CARDS_DATA) {
    env.sql.exec(
      "INSERT INTO rate_cards (contract_id, valid_from, valid_to, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, description, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PLN', ?, ?, ?, 1)",
      [r.contractId, r.validFrom, r.validTo, r.fraction, r.collectionModel, r.packagingType, r.rateValue, r.rateUnit, r.description, now, now]
    );
  }

  // 8. logistic_minimums (2: EcoAction, Reselekt)
  for (const lm of LOGISTIC_MINIMUMS_DATA) {
    env.sql.exec(
      "INSERT INTO logistic_minimums (contract_id, frequency, minimum_units, incidental_pickup_fee_grosze, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)",
      [lm.contractId, lm.frequency, lm.minimumUnits, lm.incidentalPickupFeeGrosze, now, now]
    );
  }

  // 9. memberships (master user → network_operator org)
  const masterUserId = Number(env.sql.query<{ id: number }>("SELECT id FROM users WHERE email = 'maciej@net4zero.pl'")[0]?.id ?? 0);
  if (masterUserId > 0) {
    env.sql.exec(
      "INSERT INTO memberships (user_id, org_id, role, scope_type, scope_ids_json, assignment_type, created_at) VALUES (?, 1, 'network_operator', NULL, NULL, 'ALL_CURRENT_AND_FUTURE', ?)",
      [masterUserId, now]
    );
  }
}

export async function reseed(env: any) {
  // PROMPT 1: nowe tabele — czyścimy PRZED starymi (FK i kolejność nie ma znaczenia przy reseed)
  env.sql.exec("DELETE FROM memberships");
  env.sql.exec("DELETE FROM logistic_minimums");
  env.sql.exec("DELETE FROM rate_cards");
  env.sql.exec("DELETE FROM contracts");
  env.sql.exec("DELETE FROM location_operators");
  env.sql.exec("DELETE FROM device_heartbeats");
  env.sql.exec("DELETE FROM device_shadow");
  env.sql.exec("DELETE FROM devices");
  env.sql.exec("DELETE FROM locations");
  env.sql.exec("DELETE FROM regions");
  env.sql.exec("DELETE FROM organizations");
  // PROMPT 0: stare tabele
  env.sql.exec("DELETE FROM event_log");
  env.sql.exec("DELETE FROM sorter_receipts");
  env.sql.exec("DELETE FROM operator_credits");
  env.sql.exec("DELETE FROM settlement_cycles");
  env.sql.exec("DELETE FROM invoices");
  env.sql.exec("DELETE FROM settlements");
  env.sql.exec("DELETE FROM collections");
  env.sql.exec("DELETE FROM points");
  env.sql.exec("DELETE FROM drivers");
  env.sql.exec("DELETE FROM investors");
  env.sql.exec("DELETE FROM invites");
  env.sql.exec("DELETE FROM sessions");
  env.sql.exec("DELETE FROM users");
  env.sql.exec("DELETE FROM meta");
  await seed(env);
  env.sql.exec("INSERT INTO meta (key, value) VALUES ('seeded', ?)", [new Date().toISOString()]);
  await seedPrompt1(env);
}

async function seed(env: any) {
  const now = Date.now();

  const masterPwd = await hashPassword(SEED_PASSWORD);
  env.sql.exec(
    "INSERT INTO users (email, name, role, password_hash, salt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["maciej@net4zero.pl", "Maciej Machłajewski", "master", masterPwd.hash, masterPwd.salt, "active", now]
  );

  const investorAId = insertInvestor(env, "Wspólnota Wilanów / Inwestor A", "wspolnota", now);
  const investorBId = insertInvestor(env, "Fundacja Eko Praga / Inwestor B", "fundacja", now);

  const investorAPwd = await hashPassword(SEED_PASSWORD);
  env.sql.exec(
    "INSERT INTO users (email, name, role, password_hash, salt, investor_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["inwestor.a@net4zero.pl", "Anna Wiśniewska (Inwestor A)", "investor", investorAPwd.hash, investorAPwd.salt, investorAId, "active", now]
  );
  const investorBPwd = await hashPassword(SEED_PASSWORD);
  env.sql.exec(
    "INSERT INTO users (email, name, role, password_hash, salt, investor_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["inwestor.b@net4zero.pl", "Tomasz Zieliński (Inwestor B)", "investor", investorBPwd.hash, investorBPwd.salt, investorBId, "active", now]
  );

  for (const p of POINTS_DATA) {
    const inv = p.investor === "B" ? investorBId : investorAId;
    env.sql.exec(
      "INSERT INTO points (id, address, district, investor_id, fill_level, status, monthly_packages, last_collection_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [p.id, p.address, p.district, inv, p.fill, "online", p.monthlyPackages, now - 86400000, now]
    );
  }

  const driverIds: number[] = [];
  for (const d of DRIVERS_DATA) {
    const id = insertDriver(env, d, now);
    driverIds.push(id);
  }
  const driverPwd = await hashPassword(SEED_PASSWORD);
  env.sql.exec(
    "INSERT INTO users (email, name, role, password_hash, salt, driver_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["kierowca@net4zero.pl", "Jan Kowalski", "driver", driverPwd.hash, driverPwd.salt, driverIds[0], "active", now]
  );

  const cyclePeriods = [
    { label: "2026-W26", start: now - 15 * 86400000, end: now - 10 * 86400000, status: "closed" as const },
    { label: "2026-W27", start: now - 10 * 86400000, end: now - 5 * 86400000, status: "reconciling" as const },
    { label: "2026-W28", start: now - 5 * 86400000, end: now, status: "open" as const },
  ];
  const cycleIds: number[] = [];
  for (const cp of cyclePeriods) {
    env.sql.exec(
      "INSERT INTO settlement_cycles (label, period_start, period_end, status, created_at, created_by, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [cp.label, cp.start, cp.end, cp.status, cp.start, 1, cp.status === "closed" ? cp.end + 86400000 : null]
    );
    cycleIds.push(Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id));
  }
  const pointsList = POINTS_DATA.map((p) => p.id);
  const collectionsByPoint: Record<string, number> = {};
  for (const c of RECENT_COLLECTIONS) {
    collectionsByPoint[c.point] = (collectionsByPoint[c.point] ?? 0) + c.packages;
  }
  for (let i = 0; i < cycleIds.length; i++) {
    const cp = cyclePeriods[i];
    const cycId = cycleIds[i];
    for (const pid of pointsList) {
      const deviceBase = collectionsByPoint[pid] ?? 2000;
      const sorter = Math.round(deviceBase * (pid === "NET-007" && cp.label === "2026-W27" ? 0.97 : 1.01));
      const operator = Math.round(deviceBase * 1.0);
      const amountGrosze = operator * 50;
      env.sql.exec(
        "INSERT INTO operator_credits (cycle_id, point_id, packages, amount_grosze, source_csv, source_row, source_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [cycId, pid, operator, amountGrosze, "reselekt-" + cp.label + ".csv", 1, "RES-" + cp.label + "-" + pid, now]
      );
      if (cp.label !== "2026-W28") {
        env.sql.exec(
          "INSERT INTO sorter_receipts (cycle_id, point_id, packages, source_csv, source_row, source_reference, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [cycId, pid, sorter, "sorter-" + cp.label + ".csv", 1, "SOR-" + cp.label + "-" + pid, cp.end, now]
        );
      }
      env.sql.exec(
        "INSERT INTO event_log (cycle_id, point_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [cycId, pid, "seed_initial_data", JSON.stringify({ device: Math.round(deviceBase * (cp.label === "2026-W26" ? 0.6 : cp.label === "2026-W27" ? 0.5 : 0)), sorter, operator }), 1, now]
      );
    }
    env.sql.exec("INSERT INTO event_log (cycle_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?)", [cycId, "cycle_created", JSON.stringify({ label: cp.label }), 1, cp.start]);
    if (cp.status === "closed") {
      env.sql.exec("INSERT INTO event_log (cycle_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?)", [cycId, "cycle_closed", JSON.stringify({}), 1, cp.end + 86400000]);
    }
  }

  for (const c of RECENT_COLLECTIONS) {
    env.sql.exec(
      "INSERT INTO collections (point_id, driver_id, status, packages, accepted_at, collected_at, created_at) VALUES (?, ?, 'completed', ?, ?, ?, ?)",
      [c.point, driverIds[c.driverIdx], c.packages, now - c.hoursAgo * 3600000, now - c.hoursAgo * 3600000 + 600000, now - c.hoursAgo * 3600000]
    );
  }
  for (const s of SETTLEMENTS_DATA) {
    env.sql.exec(
      "INSERT INTO settlements (period, party, party_type, investor_id, count, rate_label, net_grosze, vat_grosze, gross_grosze, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["2026-07", s.party, s.partyType, s.investorIdx != null ? (s.investorIdx === 0 ? investorAId : investorBId) : null, s.count, s.rate, s.netGrosze, s.vatGrosze, s.grossGrosze, now]
    );
  }
  for (const inv of INVOICES_DATA) {
    env.sql.exec(
      "INSERT INTO invoices (ksef_number, recipient, investor_id, driver_id, title, amount_grosze, issue_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [inv.ksef, inv.recipient, inv.investorIdx != null ? (inv.investorIdx === 0 ? investorAId : investorBId) : null, inv.driverIdx != null ? driverIds[inv.driverIdx] : null, inv.title, inv.amountGrosze, inv.issueDate, "zaakceptowana", now]
    );
  }
  env.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", ["packagesMonth", "612480"]);
  env.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", ["collectionsMonth", "342"]);
}

function insertInvestor(env: any, name: string, type: string, now: number): number {
  env.sql.exec(
    "INSERT INTO investors (name, type, status, created_at) VALUES (?, ?, ?, ?)",
    [name, type, "active", now]
  );
  return Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}

function insertDriver(env: any, d: any, now: number): number {
  env.sql.exec(
    "INSERT INTO drivers (name, type, company, bdo_number, bdo_verified, gps_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [d.name, d.type, d.company, d.bdo, d.verified, d.gps, "active", now]
  );
  return Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}


// PROMPT 5 backfill: dodaje kolumny hash chain do ledger_entries + tworzy tabelę operator_terms
async function backfillPrompt5Tables(env: any) {
  // 1. ALTER TABLE ledger_entries: dodaj kolumny hash chain (nullable, bez NOT NULL constraint)
  const cols = env.sql.query<{ name: string }>("PRAGMA table_info(ledger_entries)");
  const colNames = new Set(cols.map((c: any) => c.name));
  if (!colNames.has("prev_hash")) env.sql.exec("ALTER TABLE ledger_entries ADD COLUMN prev_hash TEXT");
  if (!colNames.has("entry_hash")) env.sql.exec("ALTER TABLE ledger_entries ADD COLUMN entry_hash TEXT");
  if (!colNames.has("author")) env.sql.exec("ALTER TABLE ledger_entries ADD COLUMN author TEXT");
  if (!colNames.has("source")) env.sql.exec("ALTER TABLE ledger_entries ADD COLUMN source TEXT");
  env.sql.exec("CREATE INDEX IF NOT EXISTS ledger_entries_hash_idx ON ledger_entries(cycle_id, id)");

  // 2. CREATE TABLE IF NOT EXISTS operator_terms (terminy kaucyjne per operator)
  env.sql.exec(`CREATE TABLE IF NOT EXISTS operator_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    report_days INTEGER NOT NULL,
    payout_days INTEGER NOT NULL,
    day_type TEXT NOT NULL DEFAULT 'BUSINESS',
    currency TEXT NOT NULL DEFAULT 'PLN',
    notes TEXT,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    deleted_at INTEGER
  )`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS operator_terms_contract_idx ON operator_terms(contract_id)`);
  env.sql.exec(`CREATE INDEX IF NOT EXISTS operator_terms_valid_idx ON operator_terms(valid_from)`);
}

// PROMPT 5 seed: domyślne terminy kaucyjne dla Reselekt (kontrakt 2).
// Reselekt = "7 dni na raport, 14 dni na wypłatę, dni robocze".
// Zmiana = aneks do kontraktu (nie stała w kodzie).
async function seedPrompt5OperatorTerms(env: any) {
  const count = Number(env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM operator_terms")[0]?.n ?? 0);
  if (count > 0) return; // już ma terminy — skip (idempotent)

  const now = Date.now();
  // Kontrakt 2: edrs.io ↔ Reselekt (deposit_operator / ipz_operator)
  env.sql.exec(
    "INSERT INTO operator_terms (contract_id, report_days, payout_days, day_type, currency, notes, valid_from, valid_to, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'PLN', ?, ?, NULL, ?, ?, 1)",
    [2, 7, 14, 'BUSINESS', 'Reselekt — 7 dni raport, 14 dni wypłata, dni robocze', 1704067200000, now, now]
  );
}

