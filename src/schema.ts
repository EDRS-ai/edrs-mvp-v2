// Sprint 2 PROMPT 1 — model danych i rejestry.
//
// Zasady (z promptu, non-negotiable):
//   1. ZERO STAWEK W KODZIE — każda stawka to wiersz w rate_cards z datą obowiązywania.
//   2. TRZY OSIE DAT: event_date / operational_date / booking_date (dodane w PROMPT 3).
//   3. LEDGER NIEZMIENIALNY (dodane w PROMPT 3).
//   4. IDEMPOTENCY: format {źródło}:{id} (dodane w PROMPT 2).
//   5. MULTI-OPERATOR: ten sam punkt może mieć wielu operatorów (location_operators).
//   6. SCOPING W WARSTWIE DANYCH — implementowany w handler.ts (session 2).
//
// Co zrobiłem w tej sesji:
//   - Zachowałem WSZYSTKIE istniejące tabele (users, sessions, invites, points, collections, settlements,
//     invoices, drivers, settlement_cycles, operator_credits, sorter_receipts, event_log, meta).
//     Demo z PROMPT 0 nadal działa.
//   - Dodałem nowe tabele obok: organizations, regions, locations, location_operators, devices,
//     device_shadow, device_heartbeats, contracts, rate_cards, logistic_minimums, memberships.
//   - Stare `points` zostaje na czas migracji — nowe `locations` jest kanoniczne (multi-tenant).
//     Handler zostanie przeniesiony na `locations` w sesji 2.

import { sqliteTable, integer, text, real, uniqueIndex, index, primaryKey, blob } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// ─── PROMPT 0 tables (zachowane bez zmian) ──────────────────────────────────────

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  salt: text("salt").notNull(),
  investorId: integer("investor_id"),
  driverId: integer("driver_id"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({ emailIdx: uniqueIndex("users_email_idx").on(t.email) }));

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastActivityAt: integer("last_activity_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const invites = sqliteTable("invites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull(),
  role: text("role").notNull(),
  label: text("label").notNull(),
  investorId: integer("investor_id"),
  driverId: integer("driver_id"),
  status: text("status").notNull().default("pending"),
  createdBy: integer("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  usedAt: integer("used_at"),
}, (t) => ({ tokenIdx: uniqueIndex("invites_token_idx").on(t.token) }));

export const investors = sqliteTable("investors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
});

export const drivers = sqliteTable("drivers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  company: text("company"),
  bdoNumber: text("bdo_number"),
  bdoVerified: integer("bdo_verified").notNull().default(0),
  gpsId: text("gps_id"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
});

export const points = sqliteTable("points", {
  id: text("id").primaryKey(),
  address: text("address").notNull(),
  district: text("district").notNull(),
  investorId: integer("investor_id").notNull(),
  lat: real("lat"),
  lng: real("lng"),
  fillLevel: integer("fill_level").notNull().default(0),
  status: text("status").notNull().default("online"),
  lastCollectionAt: integer("last_collection_at"),
  monthlyPackages: integer("monthly_packages").notNull().default(0),
  createdAt: integer("created_at").notNull(),
}, (t) => ({ invIdx: index("points_investor_idx").on(t.investorId) }));

export const collections = sqliteTable("collections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pointId: text("point_id").notNull(),
  driverId: integer("driver_id").notNull(),
  status: text("status").notNull().default("completed"),
  packages: integer("packages"),
  weightKg: real("weight_kg"),
  acceptedAt: integer("accepted_at"),
  collectedAt: integer("collected_at"),
  cycleId: integer("cycle_id"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  pointIdx: index("collections_point_idx").on(t.pointId),
  driverIdx: index("collections_driver_idx").on(t.driverId),
  statusIdx: index("collections_status_idx").on(t.status),
  cycleIdx: index("collections_cycle_idx").on(t.cycleId),
}));

export const settlements = sqliteTable("settlements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  period: text("period").notNull(),
  party: text("party").notNull(),
  partyType: text("party_type").notNull(),
  investorId: integer("investor_id"),
  driverId: integer("driver_id"),
  count: integer("count").notNull(),
  rateLabel: text("rate_label").notNull(),
  netGrosze: integer("net_grosze").notNull(),
  vatGrosze: integer("vat_grosze").notNull(),
  grossGrosze: integer("gross_grosze").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => ({ periodIdx: index("settlements_period_idx").on(t.period) }));

export const invoices = sqliteTable("invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ksefNumber: text("ksef_number").notNull(),
  recipient: text("recipient").notNull(),
  investorId: integer("investor_id"),
  driverId: integer("driver_id"),
  title: text("title").notNull(),
  amountGrosze: integer("amount_grosze").notNull(),
  issueDate: text("issue_date").notNull(),
  status: text("status").notNull().default("zaakceptowana"),
  createdAt: integer("created_at").notNull(),
});

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const settlementCycles = sqliteTable("settlement_cycles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  periodStart: integer("period_start").notNull(),
  periodEnd: integer("period_end").notNull(),
  status: text("status").notNull().default("draft"), // PROMPT 3: draft | approved | invoiced | settled | reopened
  cycleType: text("cycle_type"), // PROMPT 3: deposit | handling_fee | logistics | platform
  contractId: integer("contract_id"), // PROMPT 3: długość cyklu to PARAMETR KONTRAKTU
  approvedBy: integer("approved_by"), // PROMPT 3: kto zatwierdził
  approvedAt: integer("approved_at"), // PROMPT 3: kiedy zatwierdzono
  closedAt: integer("closed_at"),
  createdAt: integer("created_at").notNull(),
  createdBy: integer("created_by"),
}, (t) => ({
  statusIdx: index("settlement_cycles_status_idx").on(t.status),
  labelIdx: uniqueIndex("settlement_cycles_label_idx").on(t.label),
}));

// PROMPT 3 — ledger_entries: NIEZMIENIALNE (immutable). Korekta = nowa pozycja, nigdy UPDATE.
// 3 osie dat: event_date (sesja zwrotu/odbiór), operational_date (potwierdzenie operatora), booking_date (uznanie rachunku).
// 18 entry_types: DEPOSIT_REIMBURSEMENT, HANDLING_FEE, HANDLING_FEE_CORRECTION, LOGISTICS_FEE,
// DRIVER_FEE, CARRIER_FEE, PLATFORM_SUBSCRIPTION, PLATFORM_SETTLEMENT_FEE, ACQUIRER_FEE,
// LEASE_RENT, SERVICE_FEE, INCIDENTAL_PICKUP, RECONCILIATION_ADJUSTMENT, DISPUTE_HOLD,
// DISPUTE_RELEASE, FRAUD_CLAWBACK, PENALTY, OTHER_ADJUSTMENT.
// end_to_end_id: kotwica do linii na wyciągu bankowym — generowany przy tworzeniu pozycji.
// INWARIANT: suma amount_net wszystkich pozycji cyklu dla danej strony = kwota przelewu do tej strony.
export const ledgerEntries = sqliteTable("ledger_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: integer("cycle_id").notNull(),
  entryType: text("entry_type").notNull(),
  partyOrgId: integer("party_org_id"), // organization.id strony rozliczenia
  direction: text("direction").notNull(), // credit | debit
  amountNet: integer("amount_net").notNull(), // grosze
  vatRate: real("vat_rate").notNull().default(23), // % VAT
  vatAmount: integer("vat_amount").notNull(), // grosze
  amountGross: integer("amount_gross").notNull(), // grosze
  locationId: text("location_id"),
  deviceId: text("device_id"),
  eventDate: integer("event_date"), // PROMPT 3: data zdarzenia (sesja zwrotu / odbiór)
  operationalDate: integer("operational_date"), // PROMPT 3: data operacyjna (potwierdzenie operatora)
  bookingDate: integer("booking_date"), // PROMPT 3: data księgowania (uznanie rachunku)
  sourceEventId: integer("source_event_id"), // FK do event_log.id
  endToEndId: text("end_to_end_id"), // kotwica do wyciągu bankowego
  invoiceId: integer("invoice_id"), // FK do invoices.id
  rateCardId: integer("rate_card_id"), // FK do rate_cards.id (źródło stawki)
  reversalOfId: integer("reversal_of_id"), // PROMPT 3: jeśto pozycja odwracająca → ID pierwotnej
  // PROMPT 5: append-only integrity chain (SHA-256 prev_hash → entry_hash)
  // Pierwszy wpis cyklu ma prev_hash = 'GENESIS'. Stare (backfilled) wpisy: entry_hash = 'BACKFILL'.
  prevHash: text("prev_hash"),
  entryHash: text("entry_hash"),
  // PROMPT 5: kto / skąd stworzył wpis (audyt). Np. user_id, 'settlement_engine', 'reversal_creation'.
  author: text("author"),
  source: text("source"), // np. 'engine:deposit', 'engine:dispute_hold', 'manual:correction'
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  cycleIdx: index("ledger_entries_cycle_idx").on(t.cycleId),
  partyIdx: index("ledger_entries_party_idx").on(t.partyOrgId),
  entryTypeIdx: index("ledger_entries_entry_type_idx").on(t.entryType),
  endToEndIdx: uniqueIndex("ledger_entries_end_to_end_idx").on(t.endToEndId),
  hashChainIdx: index("ledger_entries_hash_idx").on(t.cycleId, t.id),
  // PROMPT 6 — indexes for 4000 pkt performance
  ledgerCycleTypeIdx: index("ledger_entries_cycle_type_idx").on(t.cycleId, t.entryType),
  ledgerLocationCreatedIdx: index("ledger_entries_location_created_idx").on(t.locationId, t.createdAt),
  ledgerEntryHashIdx: index("ledger_entries_entry_hash_idx").on(t.entryHash),
  ledgerPrevHashIdx: index("ledger_entries_prev_hash_idx").on(t.prevHash),
}));

// ─── PROMPT 5: operator_terms (terminy kaucyjne per operator) ──────────────
// Konfigurowalne per kontrakt: ile dni od uznania do raportu, ile dni do wypłaty,
// czy liczymy dni robocze czy kalendarzowe.
// Wartości seedowane dla Reselekt (kontrakt 2): 7 dni raport, 14 dni wypłata, BUSINESS.
// Zmiana terminów to ZMIANA KONTRAKTU, nigdy nie w kodzie.
export const operatorTerms = sqliteTable("operator_terms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contractId: integer("contract_id").notNull().references(() => contracts.id),
  reportDays: integer("report_days").notNull(), // dni od uznania do raportu rozliczeniowego
  payoutDays: integer("payout_days").notNull(), // dni od raportu do wypłaty
  dayType: text("day_type").notNull().default("BUSINESS"), // CALENDAR | BUSINESS
  currency: text("currency").notNull().default("PLN"),
  notes: text("notes"),
  validFrom: integer("valid_from").notNull(),
  validTo: integer("valid_to"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  contractIdx: index("operator_terms_contract_idx").on(t.contractId),
  validIdx: index("operator_terms_valid_idx").on(t.validFrom),
}));

// ─── PROMPT 4: reconciliations + disputes ──────────────────────────────────────

// reconciliations: 3 źródła (device / sorter / operator), delta per para, status.
// Próg auto-accept: 2%, KONFIGUROWALNY PER KONTRAKT (nie stała w kodzie).
export const reconciliations = sqliteTable("reconciliations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: integer("cycle_id"),
  scopeType: text("scope_type").notNull(), // shipment | period | location
  scopeRef: text("scope_ref").notNull(), // np. location_id lub shipment_id
  sourceAJson: text("source_a_json"), // licznik recyklomatu (device)
  sourceBJson: text("source_b_json"), // waga w hali (sorter)
  sourceCJson: text("source_c_json"), // potwierdzenie operatora
  deltaAb: real("delta_ab"),
  deltaBc: real("delta_bc"),
  deltaAc: real("delta_ac"),
  deltaPct: real("delta_pct"),
  status: text("status").notNull().default("matched"), // matched | variance | disputed | resolved
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  cycleIdx: index("reconciliations_cycle_idx").on(t.cycleId),
  scopeIdx: index("reconciliations_scope_idx").on(t.scopeType, t.scopeRef),
}));

// disputes: automat o 8 stanach (wzorzec Square Dispute).
// INQUIRY_EVIDENCE_REQUIRED → INQUIRY_PROCESSING → INQUIRY_CLOSED
// EVIDENCE_REQUIRED → PROCESSING → WON | LOST | ACCEPTED
// Faza inquiry (przed formalnym sporem) jest obowiązkowa.
// AKCJA DOMYŚLNA PO UPŁYWIE TERMINU: jeśli nikt nie zareagował do due_at, system automatycznie zgłasza zastrzeżenie.
export const disputes = sqliteTable("disputes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reconciliationId: integer("reconciliation_id").notNull(),
  state: text("state").notNull().default("INQUIRY_EVIDENCE_REQUIRED"),
  dueAt: integer("due_at").notNull(), // deadline 5 dni roboczych
  evidenceJson: text("evidence_json"), // tablica dowodów
  disputedAmountGrosze: integer("disputed_amount_grosze"),
  outcome: text("outcome"), // WON | LOST | ACCEPTED | null
  defaultActionTaken: integer("default_action_taken").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  reconIdx: index("disputes_reconciliation_idx").on(t.reconciliationId),
  stateIdx: index("disputes_state_idx").on(t.state),
  dueIdx: index("disputes_due_idx").on(t.dueAt),
}));

export const operatorCredits = sqliteTable("operator_credits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: integer("cycle_id").notNull(),
  pointId: text("point_id").notNull(),
  packages: integer("packages").notNull(),
  amountGrosze: integer("amount_grosze").notNull(),
  sourceCsv: text("source_csv"),
  sourceRow: integer("source_row"),
  sourceReference: text("source_reference"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  cycleIdx: index("operator_credits_cycle_idx").on(t.cycleId),
  pointIdx: index("operator_credits_point_idx").on(t.pointId),
}));

export const sorterReceipts = sqliteTable("sorter_receipts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: integer("cycle_id").notNull(),
  pointId: text("point_id").notNull(),
  packages: integer("packages").notNull(),
  receivedAt: integer("received_at"),
  sourceCsv: text("source_csv"),
  sourceRow: integer("source_row"),
  sourceReference: text("source_reference"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  cycleIdx: index("sorter_receipts_cycle_idx").on(t.cycleId),
  pointIdx: index("sorter_receipts_point_idx").on(t.pointId),
}));

export const eventLog = sqliteTable("event_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: integer("cycle_id"), // zachowane dla kompatybilności
  pointId: text("point_id"), // zachowane dla kompatybilności
  eventType: text("event_type").notNull(), // np. device.heartbeat, session.closed, itp.
  idempotencyKey: text("idempotency_key"), // UNIQUE, format {źródło}:{id}
  payloadJson: text("payload_json"),
  source: text("source"), // np. "reselekt_csv", "rvm_api"
  actorId: integer("actor_id"), // zachowane dla kompatybilności
  receivedAt: integer("received_at"),
  processedAt: integer("processed_at"),
  processingError: text("processing_error"),
  correlationId: text("correlation_id"),
  createdAt: integer("created_at").notNull(), // zachowane dla kompatybilności
}, (t) => ({
  cycleIdx: index("event_log_cycle_idx").on(t.cycleId),
  typeIdx: index("event_log_type_idx").on(t.eventType),
  createdIdx: index("event_log_created_idx").on(t.createdAt),
  idempotencyIdx: uniqueIndex("event_log_idempotency_idx").on(t.idempotencyKey),
}));

// ─── PROMPT 1 tables (NOWE) ────────────────────────────────────────────────────

// organizations: multi-tenant root. Zastępuje investors (który zostaje dla kompatybilności demo).
// type: network_operator | investor | housing_coop | deposit_operator | carrier | hub | bank | acquirer
export const organizations = sqliteTable("organizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  nip: text("nip"),
  krs: text("krs"),
  regon: text("regon"),
  bdoNumber: text("bdo_number"),
  bankAccountsJson: text("bank_accounts_json"),
  vatWhitelistStatus: text("vat_whitelist_status"),
  vatWhitelistCheckedAt: integer("vat_whitelist_checked_at"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  typeIdx: index("organizations_type_idx").on(t.type),
  nipIdx: uniqueIndex("organizations_nip_idx").on(t.nip),
}));

export const regions = sqliteTable("regions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  hubOrgId: integer("hub_org_id").notNull().references(() => organizations.id),
  managerUserId: integer("manager_user_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
}, (t) => ({ hubIdx: index("regions_hub_idx").on(t.hubOrgId) }));

// locations: kanoniczna tabela punktów (multi-tenant). Stara `points` zostaje na czas migracji.
export const locations = sqliteTable("locations", {
  id: text("id").primaryKey(),
  address: text("address").notNull(),
  district: text("district"),
  lat: real("lat"),
  lng: real("lng"),
  regionId: integer("region_id").references(() => regions.id),
  investorOrgId: integer("investor_org_id").references(() => organizations.id),
  coopOrgId: integer("coop_org_id").references(() => organizations.id),
  exclusivityRadiusM: integer("exclusivity_radius_m"),
  investmentPeriodMonths: integer("investment_period_months"),
  efficiencyThresholdUnits: integer("efficiency_threshold_units"),
  launchDate: text("launch_date"),
  monthlyRentGrosze: integer("monthly_rent_grosze"),
  placemeDataJson: text("placeme_data_json"),
  fillLevel: integer("fill_level").notNull().default(0),
  status: text("status").notNull().default("online"),
  lastCollectionAt: integer("last_collection_at"),
  monthlyPackages: integer("monthly_packages").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  regionIdx: index("locations_region_idx").on(t.regionId),
  investorIdx: index("locations_investor_idx").on(t.investorOrgId),
}));

// location_operators: n:m — punkt może mieć wielu operatorów (jednocześnie lub sekwencyjnie).
// PROMPT 1 hard rule #5: ten sam punkt może należeć do kilku operatorów — relacja n:m, nie kolumna.
export const locationOperators = sqliteTable("location_operators", {
  locationId: text("location_id").notNull().references(() => locations.id),
  operatorOrgId: integer("operator_org_id").notNull().references(() => organizations.id),
  activeFrom: integer("active_from").notNull(),
  activeTo: integer("active_to"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.locationId, t.operatorOrgId, t.activeFrom] }),
  locIdx: index("location_operators_loc_idx").on(t.locationId),
  opIdx: index("location_operators_op_idx").on(t.operatorOrgId),
}));

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  serial: text("serial").notNull(),
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  firmwareVersion: text("firmware_version"),
  locationId: text("location_id").references(() => locations.id),
  status: text("status").notNull().default("active"),
  terminalMid: text("terminal_mid"),
  terminalTid: text("terminal_tid"),
  fractionCapacityJson: text("fraction_capacity_json"),
  installedAt: integer("installed_at"),
  warrantyUntil: integer("warranty_until"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  serialIdx: uniqueIndex("devices_serial_idx").on(t.serial),
  locationIdx: index("devices_location_idx").on(t.locationId),
}));

export const deviceShadow = sqliteTable("device_shadow", {
  deviceId: text("device_id").primaryKey().references(() => devices.id),
  desiredJson: text("desired_json"),
  reportedJson: text("reported_json"),
  lastSync: integer("last_sync"),
  driftFlag: integer("drift_flag").notNull().default(0),
});

export const deviceHeartbeats = sqliteTable("device_heartbeats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id").notNull().references(() => devices.id),
  ts: integer("ts").notNull(),
  online: integer("online").notNull(),
  fillPctJson: text("fill_pct_json"),
  versionsJson: text("versions_json"),
  errorsJson: text("errors_json"),
}, (t) => ({
  deviceIdx: index("device_heartbeats_device_idx").on(t.deviceId),
  tsIdx: index("device_heartbeats_ts_idx").on(t.ts),
}));

// contracts: typ + strony + okres obowiązywania + status.
// type: lease | implementation | ipz_operator | acquirer | service | carrier
export const contracts = sqliteTable("contracts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  partyAOrgId: integer("party_a_org_id").notNull().references(() => organizations.id),
  partyBOrgId: integer("party_b_org_id").notNull().references(() => organizations.id),
  validFrom: integer("valid_from").notNull(),
  validTo: integer("valid_to"),
  noticePeriodDays: integer("notice_period_days").notNull().default(30),
  fileRef: text("file_ref"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  partyAIdx: index("contracts_party_a_idx").on(t.partyAOrgId),
  partyBIdx: index("contracts_party_b_idx").on(t.partyBOrgId),
  statusIdx: index("contracts_status_idx").on(t.status),
}));

// rate_cards: KLUCZOWA TABELA. Zero stawek w kodzie — każda stawka to wiersz tutaj.
// 4 wymiary: fraction × collection_model × packaging_type + rate_value/rate_unit.
// valid_from / valid_to dla wersjonowania stawek (operator zmienia stawkę bez aneksu).
// Przeliczenie bierze stawkę Z DATY ZDARZENIA, nie bieżącą.
export const rateCards = sqliteTable("rate_cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contractId: integer("contract_id").notNull().references(() => contracts.id),
  validFrom: integer("valid_from").notNull(),
  validTo: integer("valid_to"),
  fraction: text("fraction").notNull(),
  collectionModel: text("collection_model").notNull(),
  packagingType: text("packaging_type").notNull(),
  rateValue: real("rate_value").notNull(),
  rateUnit: text("rate_unit").notNull(),
  currency: text("currency").notNull().default("PLN"),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  contractIdx: index("rate_cards_contract_idx").on(t.contractId),
  validIdx: index("rate_cards_valid_idx").on(t.validFrom),
  fractionIdx: index("rate_cards_fraction_idx").on(t.fraction),
}));

// logistic_minimums: minimalna częstotliwość odbioru + opłata za dorywczy pickup.
export const logisticMinimums = sqliteTable("logistic_minimums", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contractId: integer("contract_id").notNull().references(() => contracts.id),
  frequency: text("frequency").notNull(),
  minimumUnits: integer("minimum_units").notNull(),
  incidentalPickupFeeGrosze: integer("incidental_pickup_fee_grosze"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  deletedAt: integer("deleted_at"),
});

// memberships: user ↔ org z rolą w orgu + scope (region/location/device).
// Zastępuje user.role (który zostaje dla kompatybilności).
// scope_type: region | location | device | null (ALL_CURRENT_AND_FUTURE).
// scope_ids_json: ["loc-NET-001", ...] lub null (cały org).
// assignment_type: ALL_CURRENT_AND_FUTURE | EXPLICIT.
export const memberships = sqliteTable("memberships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  role: text("role").notNull(),
  scopeType: text("scope_type"),
  scopeIdsJson: text("scope_ids_json"),
  assignmentType: text("assignment_type").notNull().default("EXPLICIT"),
  createdAt: integer("created_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  userOrgIdx: uniqueIndex("memberships_user_org_idx").on(t.userId, t.orgId),
  orgIdx: index("memberships_org_idx").on(t.orgId),
}));

// ─── Relations ────────────────────────────────────────────────────────────────

// ─── PROMPT 2 tables (NOWE) ────────────────────────────────────────────────────

// import_profiles: named mapping profile connected to source organization.
// MappingJson maps file headers to internal system field names.
export const importProfiles = sqliteTable("import_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), // np. "Katowice Śródmieście - Reselekt CSV"
  orgId: integer("org_id").notNull().references(() => organizations.id),
  kind: text("kind").notNull(), // telemetry | receipts | credits
  mappingJson: text("mapping_json").notNull(), // JSON string representing header maps
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  orgIdx: index("import_profiles_org_idx").on(t.orgId),
}));

export const catalogVersions = sqliteTable("catalog_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(), // np. "Reselekt", "Action"
  version: text("version").notNull(), // np. "2026-v1"
  checksum: text("checksum"),
  importedAt: integer("imported_at").notNull(),
  itemCount: integer("item_count").notNull(),
});

// packaging_items: 18 master data fields from standard operator spec.
export const packagingItems = sqliteTable("packaging_items", {
  ean: text("ean").primaryKey(),
  barcodeFormat: text("barcode_format"),
  barcodeWidth: integer("barcode_width"),
  barcodeHeight: integer("barcode_height"),
  productName: text("product_name"),
  volumeMl: integer("volume_ml"),
  material: text("material"), // PET | ALU | GLASS | MIXED
  fraction: text("fraction"),
  fractionColour: text("fraction_colour"),
  weightWithoutCapG: real("weight_without_cap_g"),
  weightTotalG: real("weight_total_g"), // KRYTYCZNE: z tego liczymy masę, nie z wagi rzeczywistej!
  heightWithoutCapMm: real("height_without_cap_mm"),
  heightTotalMm: real("height_total_mm"),
  widthMm: real("width_mm"),
  lengthMm: real("length_mm"),
  marketEntryDate: text("market_entry_date"),
  marketWithdrawalDate: text("market_withdrawal_date"),
  producer: text("producer"),
  depositAmountGrosze: integer("deposit_amount_grosze"),
  isDeleted: integer("is_deleted").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// catalog_overrides: manual blocks/allows that MUST survive reimports.
// Priority: local manual override is always higher than sync catalog.
export const catalogOverrides = sqliteTable("catalog_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ean: text("ean").notNull().references(() => packagingItems.ean),
  scope: text("scope").notNull(), // global | region | location | device
  scopeId: text("scope_id"), // np. locationId lub deviceId lub regionId
  action: text("action").notNull(), // block | allow
  reason: text("reason"),
  author: text("author"),
  validFrom: integer("valid_from").notNull(),
  validTo: integer("valid_to"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  eanScopeIdx: uniqueIndex("catalog_overrides_ean_scope_idx").on(t.ean, t.scope, t.scopeId),
}));

export const pointsRelations = relations(points, ({ one, many }) => ({
  collections: many(collections),
}));

export const collectionsRelations = relations(collections, ({ one }) => ({
  point: one(points, { fields: [collections.pointId], references: [points.id] }),
  driver: one(drivers, { fields: [collections.driverId], references: [drivers.id] }),
}));

export const investorsRelations = relations(investors, ({ many }) => ({
  points: many(points),
}));

// PROMPT 1 relations:
export const organizationsRelations = relations(organizations, ({ many }) => ({
  hubRegions: many(regions),
  contractsAsA: many(contracts, { relationName: "partyA" }),
  contractsAsB: many(contracts, { relationName: "partyB" }),
  memberships: many(memberships),
  locationOperators: many(locationOperators),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  region: one(regions, { fields: [locations.regionId], references: [regions.id] }),
  investorOrg: one(organizations, { fields: [locations.investorOrgId], references: [organizations.id] }),
  coopOrg: one(organizations, { fields: [locations.coopOrgId], references: [organizations.id] }),
  devices: many(devices),
  operators: many(locationOperators),
}));

export const locationOperatorsRelations = relations(locationOperators, ({ one }) => ({
  location: one(locations, { fields: [locationOperators.locationId], references: [locations.id] }),
  operatorOrg: one(organizations, { fields: [locationOperators.operatorOrgId], references: [organizations.id] }),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  location: one(locations, { fields: [devices.locationId], references: [locations.id] }),
  shadow: one(deviceShadow, { fields: [devices.id], references: [deviceShadow.deviceId] }),
  heartbeats: many(deviceHeartbeats),
}));

export const contractsRelations = relations(contracts, ({ one, many }) => ({
  partyA: one(organizations, { fields: [contracts.partyAOrgId], references: [organizations.id], relationName: "partyA" }),
  partyB: one(organizations, { fields: [contracts.partyBOrgId], references: [organizations.id], relationName: "partyB" }),
  rateCards: many(rateCards),
  logisticMinimums: many(logisticMinimums),
}));

export const rateCardsRelations = relations(rateCards, ({ one }) => ({
  contract: one(contracts, { fields: [rateCards.contractId], references: [contracts.id] }),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  org: one(organizations, { fields: [memberships.orgId], references: [organizations.id] }),
}));


// ─── PROMPT 10: payments — bramka płatności (PolCard/Fiserv; MVP = sandbox) ─────
// Flow: saldo ujemne → intent (pending) → confirm (sandbox) → wpis PAYMENT_RECEIVED
// w ledger (credit, hash chain) → saldo wyrównane. Produkcyjnie: wymiana confirm
// na webhook PolCard po podpisaniu umowy PSP (org 8 w seedzie = PolCard/Fiserv).
export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  amountGrosze: integer("amount_grosze").notNull(),
  status: text("status").notNull().default("pending"), // pending | paid | failed | cancelled
  provider: text("provider").notNull().default("polcard_sandbox"),
  reference: text("reference").notNull(),
  ledgerEntryId: integer("ledger_entry_id"),
  createdBy: integer("created_by"),
  createdAt: integer("created_at").notNull(),
  paidAt: integer("paid_at"),
}, (t) => ({
  paymentsOrgIdx: index("payments_org_idx").on(t.orgId),
  paymentsRefIdx: uniqueIndex("payments_reference_idx").on(t.reference),
}));

// ─── PROMPT 11: messages — skrzynka inwestor ↔ operator (in-app) ─────────────
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  senderUserId: integer("sender_user_id").notNull(),
  senderRole: text("sender_role").notNull(), // master | investor
  body: text("body").notNull(),
  readAt: integer("read_at"),
  createdAt: integer("created_at").notNull(),
}, (t) => ({
  messagesOrgIdx: index("messages_org_idx").on(t.orgId),
  messagesCreatedIdx: index("messages_created_idx").on(t.createdAt),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  org: one(organizations, { fields: [payments.orgId], references: [organizations.id] }),
}));
export const messagesRelations = relations(messages, ({ one }) => ({
  org: one(organizations, { fields: [messages.orgId], references: [organizations.id] }),
}));

// ─── PROMPT 12: dokumenty (archiwum per org, wzór eMieszkaniec) ─────────────
// org_id NULL = dokument globalny (widoczny dla wszystkich inwestorów).
// Bajty w doc_blobs — shard ≤1.8 MB (limit wiersza SQLite ~2 MB).
export const documentsTable = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").references(() => organizations.id),
  title: text("title").notNull(),
  category: text("category").notNull().default("inne"), // umowa | protokol | regulamin | sprawozdanie | inne
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: integer("uploaded_by"),
  createdAt: integer("created_at").notNull(),
  deletedAt: integer("deleted_at"),
}, (t) => ({
  documentsOrgIdx: index("documents_org_idx").on(t.orgId),
}));

export const docBlobs = sqliteTable("doc_blobs", {
  docId: integer("doc_id").notNull(),
  idx: integer("idx").notNull(),
  bytes: blob("bytes").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.docId, t.idx] }),
}));

// ─── PROMPT 12: akceptacje sprawozdań miesięcznych (odpowiednik „uchwał”) ─────
export const statementAcceptances = sqliteTable("statement_acceptances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  period: text("period").notNull(), // YYYY-MM
  acceptedBy: integer("accepted_by").notNull(),
  acceptedAt: integer("accepted_at").notNull(),
}, (t) => ({
  acceptOrgPeriodIdx: uniqueIndex("statement_acceptances_org_period_idx").on(t.orgId, t.period),
}));