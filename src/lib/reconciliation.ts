// Sprint 2 PROMPT 4 — rekoncyliacja 3-źródłowa i spory.
//
// TRZY ŹRÓDŁA:
// A. Licznik recyklomatu — sztuki per EAN, masa z karty produktu. Podstawa rozliczenia KAUCJI.
// B. Waga w hali konsolidacyjnej — skan plomby + waga rzeczywista. Nasza własna kontrola.
// C. Potwierdzenie operatora — sztuki i masa ze zliczarni. Podstawa rozliczenia HANDLING FEE.
//
// Próg auto-accept: 2%, KONFIGUROWALNY PER KONTRAKT (nie stała w kodzie).
// ≤2% → matched, auto-accept. >2% → variance → ticket sporu.
//
// ZEGAR 5 DNI ROBOCZYCH — najważniejsza funkcja w tym module.
// Brak zgłoszenia = MILCZĄCA AKCEPTACJA. Nieodwracalnie.
// - licz DNI ROBOCZE, z polskimi świętami
// - alert T-3 dni robocze (e-mail + panel)
// - eskalacja T-1 (powiadomienie push + oznaczenie krytyczne)
// - po due_at: akcja domyślna + wpis w event_log
//
// Dispute state machine 8 stanów (wzorzec Square Dispute):
// INQUIRY_EVIDENCE_REQUIRED → INQUIRY_PROCESSING → INQUIRY_CLOSED
// EVIDENCE_REQUIRED → PROCESSING → WON | LOST | ACCEPTED
// Faza inquiry (przed formalnym sporem) jest obowiązkowa.

import { newToken } from "./auth";

// ─── Kalkulator dni roboczych z polskimi świętami ──────────────────────────────

// Polskie święta stałe (miesiąc, dzień) — nie ruchome
const POLISH_HOLIDAYS_FIXED = new Set([
  "1-1",   // Nowy Rok
  "1-6",   // Trzech Króli
  "5-1",   // Święto Pracy
  "5-3",   // Konstytucji 3 Maja
  "8-15",  // Wniebowzięcie NMP
  "11-1",  // Wszystkich Świętych
  "11-11", // Niepodległości
  "12-25", // Boże Narodzenie
  "12-26", // Drugi dzień Bożego Narodzenia
]);

// Polskie święta ruchome — obliczane na podstawie Wielkanocy
// Wielkanoc = pierwsza niedziela po pierwszej pełni księżyca po równonocy wiosennej
function easter(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function getPolishHolidaysForYear(year: number): Set<string> {
  const holidays = new Set<string>();
  // Święta stałe
  for (const h of POLISH_HOLIDAYS_FIXED) holidays.add(`${year}-${h}`);
  // Święta ruchome
  const e = easter(year);
  const easterDate = new Date(year, e.month - 1, e.day);
  // Poniedziałek Wielkanocny (+1 dzień)
  const easterMonday = new Date(easterDate);
  easterMonday.setDate(easterDate.getDate() + 1);
  holidays.add(`${easterMonday.getFullYear()}-${easterMonday.getMonth() + 1}-${easterMonday.getDate()}`);
  // Boże Ciało (+60 dni)
  const corpusChristi = new Date(easterDate);
  corpusChristi.setDate(easterDate.getDate() + 60);
  holidays.add(`${corpusChristi.getFullYear()}-${corpusChristi.getMonth() + 1}-${corpusChristi.getDate()}`);
  // Zielone Świątki (+49 dni = Pięćdziesiątnica) — niedziela, nie jest dniem wolnym od pracy
  return holidays;
}

// Sprawdź czy data jest dniem roboczym (pon-pt, nie święto)
export function isBusinessDay(date: Date): boolean {
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false; // niedziela, sobota
  const year = date.getFullYear();
  const holidays = getPolishHolidaysForYear(year);
  const key = `${year}-${date.getMonth() + 1}-${date.getDate()}`;
  return !holidays.has(key);
}

// Dodaj N dni roboczych do daty (pomijając weekendy i święta)
export function addBusinessDays(startDate: Date, days: number): Date {
  const result = new Date(startDate);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (isBusinessDay(result)) {
      added++;
    }
  }
  return result;
}

// Policz ile dni roboczych pozostało do due_at
export function businessDaysBetween(from: Date, to: Date): number {
  let count = 0;
  const current = new Date(from);
  while (current < to) {
    current.setDate(current.getDate() + 1);
    if (isBusinessDay(current)) {
      count++;
    }
  }
  return count;
}

// ─── Silnik rekoncyliacji 3-źródłowej ────────────────────────────────────────────

type ReconciliationSource = {
  device: number;  // licznik recyklomatu
  sorter: number;  // waga w hali konsolidacyjnej
  operator: number; // potwierdzenie operatora
};

type ReconciliationResult = {
  deltaAb: number;
  deltaBc: number;
  deltaAc: number;
  deltaPct: number;
  status: "matched" | "variance" | "disputed";
  thresholdPct: number;
};

// Funkcja: uruchom rekoncyliację dla pojedynczego punktu w cyklu
// Próg auto-accept: z rate_cards kontraktu (KONFIGUROWALNY PER KONTRAKT, nie stała w kodzie)
export function reconcileThreeSources(
  sources: ReconciliationSource,
  thresholdPct: number
): ReconciliationResult {
  const { device, sorter, operator } = sources;
  const deltaAb = Math.abs(device - sorter);
  const deltaBc = Math.abs(sorter - operator);
  const deltaAc = Math.abs(device - operator);

  // Oblicz delta_pct jako największy rozjazd w procentach względem średniej 3 źródeł
  const avg = (device + sorter + operator) / 3;
  const maxDelta = Math.max(deltaAb, deltaBc, deltaAc);
  const deltaPct = avg > 0 ? (maxDelta / avg) * 100 : 0;

  let status: "matched" | "variance" | "disputed";
  if (deltaPct <= thresholdPct) {
    status = "matched";
  } else {
    status = "disputed"; // > threshold → ticket sporny (variance + dispute)
  }

  return {
    deltaAb,
    deltaBc,
    deltaAc,
    deltaPct: Math.round(deltaPct * 100) / 100,
    status,
    thresholdPct,
  };
}

// ─── Dispute state machine (wzorzec Square Dispute) ────────────────────────────

export const DISPUTE_STATES = {
  INQUIRY_EVIDENCE_REQUIRED: "INQUIRY_EVIDENCE_REQUIRED",
  INQUIRY_PROCESSING: "INQUIRY_PROCESSING",
  INQUIRY_CLOSED: "INQUIRY_CLOSED",
  EVIDENCE_REQUIRED: "EVIDENCE_REQUIRED",
  PROCESSING: "PROCESSING",
  WON: "WON",
  LOST: "LOST",
  ACCEPTED: "ACCEPTED",
} as const;

// Dozwolone przejścia stanów
const STATE_TRANSITIONS: Record<string, string[]> = {
  INQUIRY_EVIDENCE_REQUIRED: ["INQUIRY_PROCESSING", "INQUIRY_CLOSED"],
  INQUIRY_PROCESSING: ["INQUIRY_CLOSED", "EVIDENCE_REQUIRED"],
  INQUIRY_CLOSED: [], // terminal — inquiry zamknięte bez formalnego sporu
  EVIDENCE_REQUIRED: ["PROCESSING", "ACCEPTED"],
  PROCESSING: ["WON", "LOST", "ACCEPTED"],
  WON: [], // terminal
  LOST: [], // terminal
  ACCEPTED: [], // terminal
};

export function canTransition(from: string, to: string): boolean {
  const allowed = STATE_TRANSITIONS[from] ?? [];
  return allowed.includes(to);
}

// ─── Zegar 5 dni roboczych ─────────────────────────────────────────────────────

// Oblicz due_at = startDate + 5 dni roboczych
export function calculateDueAt(startDate: Date): Date {
  return addBusinessDays(startDate, 5);
}

// Sprawdź czy due_at minął
export function isOverdue(dueAt: Date): boolean {
  return Date.now() > dueAt.getTime();
}

// Poziom alertu: T-3 (warning), T-1 (critical), overdue (default action)
export function getAlertLevel(dueAt: Date): "none" | "warning" | "critical" | "overdue" {
  const now = new Date();
  const remaining = businessDaysBetween(now, dueAt);
  if (isOverdue(dueAt)) return "overdue";
  if (remaining <= 1) return "critical";
  if (remaining <= 3) return "warning";
  return "none";
}

// ─── Akcja domyślna po due_at ──────────────────────────────────────────────────

// AKCJA DOMYŚLNA PO UPŁYWIE TERMINU: jeśli nikt nie zareagował do due_at,
// system automatycznie zgłasza zastrzeżenie. Lepiej zgłosić i wycofać niż przegapić.
export function executeDefaultAction(env: any, disputeId: number, actorId: number): { ok: boolean; action: string } {
  const now = Date.now();
  const dispute = env.sql.query<{ id: number; state: string; due_at: number; reconciliation_id: number }>(
    "SELECT id, state, due_at, reconciliation_id FROM disputes WHERE id = ?",
    [disputeId]
  );
  if (dispute.length === 0) return { ok: false, action: "not_found" };
  const d = dispute[0];

  // Tylko jeśli due_at minął i nikt nie zareagował
  if (d.due_at > now) return { ok: false, action: "not_overdue" };
  if (d.state !== "INQUIRY_EVIDENCE_REQUIRED" && d.state !== "EVIDENCE_REQUIRED") {
    return { ok: false, action: "already_in_progress" };
  }

  // Akcja domyślna: automatycznie przejdź do EVIDENCE_REQUIRED (formalny spór)
  // Jeśli był w INQUIRY_EVIDENCE_REQUIRED → przejdź do EVIDENCE_REQUIRED
  // Jeśli był w EVIDENCE_REQUIRED → przejdź do PROCESSING (auto-accept operatora)
  let newState = "";
  if (d.state === "INQUIRY_EVIDENCE_REQUIRED") {
    newState = "EVIDENCE_REQUIRED";
  } else {
    newState = "PROCESSING";
  }

  env.sql.exec(
    "UPDATE disputes SET state = ?, default_action_taken = 1, updated_at = ? WHERE id = ?",
    [newState, now, disputeId]
  );

  // Zaktualizuj status rekoncyliacji na "disputed"
  env.sql.exec(
    "UPDATE reconciliations SET status = 'disputed' WHERE id = ?",
    [d.reconciliation_id]
  );

  // Log event
  env.sql.exec(
    "INSERT INTO event_log (event_type, payload_json, actor_id, created_at) VALUES ('dispute_default_action', ?, ?, ?)",
    [JSON.stringify({ disputeId, newState, reconciliationId: d.reconciliation_id, message: "Akcja domyślna: automatyczne zgłoszenie zastrzeżenia po upływie terminu" }), actorId, now]
  );

  return { ok: true, action: newState };
}

// ─── Tworzenie dispute z rekoncyliacji ─────────────────────────────────────────

export function createDisputeFromReconciliation(
  env: any,
  reconciliationId: number,
  disputedAmountGrosze: number,
  createdAt: Date
): { ok: boolean; disputeId?: number; error?: string } {
  const now = createdAt.getTime();
  const dueAt = calculateDueAt(createdAt);

  env.sql.exec(
    "INSERT INTO disputes (reconciliation_id, state, due_at, disputed_amount_grosze, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [reconciliationId, DISPUTE_STATES.INQUIRY_EVIDENCE_REQUIRED, dueAt.getTime(), disputedAmountGrosze, now, now]
  );

  const disputeId = Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);

  // Log event
  env.sql.exec(
    "INSERT INTO event_log (event_type, payload_json, created_at) VALUES ('dispute_created', ?, ?)",
    [JSON.stringify({ disputeId, reconciliationId, dueAt: dueAt.toISOString(), state: "INQUIRY_EVIDENCE_REQUIRED" }), now]
  );

  return { ok: true, disputeId };
}

// ─── Przejście stanu dispute ───────────────────────────────────────────────────

export function transitionDisputeState(
  env: any,
  disputeId: number,
  newState: string,
  actorId: number,
  evidence?: string
): { ok: boolean; error?: string } {
  const dispute = env.sql.query<{ id: number; state: string }>(
    "SELECT id, state FROM disputes WHERE id = ?",
    [disputeId]
  );
  if (dispute.length === 0) return { ok: false, error: "not_found" };

  const currentState = dispute[0].state;
  if (!canTransition(currentState, newState)) {
    return { ok: false, error: `invalid_transition: ${currentState} → ${newState}` };
  }

  const now = Date.now();
  let evidenceJson: string | undefined;
  if (evidence) {
    const existingEvidence = env.sql.query<{ evidence_json: string }>("SELECT evidence_json FROM disputes WHERE id = ?", [disputeId])[0]?.evidence_json || "[]";
    const parsed = JSON.parse(existingEvidence);
    parsed.push(evidence);
    evidenceJson = JSON.stringify(parsed);
  }

  env.sql.exec(
    "UPDATE disputes SET state = ?, updated_at = ?, evidence_json = COALESCE(?, evidence_json) WHERE id = ?",
    [newState, now, evidenceJson ?? null, disputeId]
  );

  // Log event
  env.sql.exec(
    "INSERT INTO event_log (event_type, payload_json, actor_id, created_at) VALUES ('dispute_state_transition', ?, ?, ?)",
    [JSON.stringify({ disputeId, from: currentState, to: newState }), actorId, now]
  );

  // Jeśli to stan terminalny (WON/LOST/ACCEPTED/INQUIRY_CLOSED), zaktualizuj rekoncyliację
  if (["WON", "LOST", "ACCEPTED", "INQUIRY_CLOSED"].includes(newState)) {
    const reconId = env.sql.query<{ reconciliation_id: number }>("SELECT reconciliation_id FROM disputes WHERE id = ?", [disputeId])[0]?.reconciliation_id;
    if (reconId) {
      env.sql.exec("UPDATE reconciliations SET status = 'resolved' WHERE id = ?", [reconId]);
    }
  }

  return { ok: true };
}

// ─── Uruchom pełną rekoncyliację dla cyklu ──────────────────────────────────────

export function runFullReconciliation(env: any, cycleId: number, cycle: any, thresholdPct: number): {
  reconciliationsCreated: number;
  disputesCreated: number;
  matched: number;
  disputed: number;
  errors: string[];
} {
  const errors: string[] = [];
  const now = Date.now();

  // Pobierz operator_credits per punkt (źródło C — potwierdzenie operatora)
  const credits = env.sql.query<any>(
    "SELECT point_id, packages, amount_grosze FROM operator_credits WHERE cycle_id = ?",
    [cycleId]
  );

  // Pobierz sorter_receipts per punkt (źródło B — waga w hali)
  const sorterReceipts = env.sql.query<any>(
    "SELECT point_id, packages FROM sorter_receipts WHERE cycle_id = ?",
    [cycleId]
  );
  const sorterMap = new Map<string, number>();
  for (const sr of sorterReceipts) {
    sorterMap.set(sr.point_id, sr.packages);
  }

  // Pobierz collections per punkt (źródło A — licznik recyklomatu)
  const collections = env.sql.query<any>(
    "SELECT point_id, COALESCE(SUM(packages), 0) AS packages FROM collections WHERE status='completed' AND collected_at BETWEEN ? AND ? GROUP BY point_id",
    [cycle.period_start, cycle.period_end]
  );
  const deviceMap = new Map<string, number>();
  for (const col of collections) {
    deviceMap.set(col.point_id, col.packages);
  }

  let reconciliationsCreated = 0;
  let disputesCreated = 0;
  let matched = 0;
  let disputed = 0;

  for (const credit of credits) {
    const pointId = credit.point_id;
    const device = deviceMap.get(pointId) ?? 0;
    const sorter = sorterMap.get(pointId) ?? 0;
    const operator = credit.packages;

    // Tylko jeśli wszystkie 3 źródła są obecne
    if (device === 0 || sorter === 0 || operator === 0) {
      errors.push(`Punkt ${pointId}: niekompletne źródła (device=${device}, sorter=${sorter}, operator=${operator})`);
      continue;
    }

    const result = reconcileThreeSources({ device, sorter, operator }, thresholdPct);

    // Zapisz rekoncyliację
    env.sql.exec(
      "INSERT INTO reconciliations (cycle_id, scope_type, scope_ref, source_a_json, source_b_json, source_c_json, delta_ab, delta_bc, delta_ac, delta_pct, status, created_at) VALUES (?, 'location', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [cycleId, pointId, JSON.stringify({ device }), JSON.stringify({ sorter }), JSON.stringify({ operator }),
       result.deltaAb, result.deltaBc, result.deltaAc, result.deltaPct, result.status, now]
    );
    reconciliationsCreated++;

    if (result.status === "matched") {
      matched++;
    } else {
      disputed++;
      // Utwórz dispute
      const reconId = Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
      const disputeResult = createDisputeFromReconciliation(env, reconId, credit.amount_grosze, new Date());
      if (disputeResult.ok) {
        disputesCreated++;
      } else {
        errors.push(`Punkt ${pointId}: błąd tworzenia dispute — ${disputeResult.error}`);
      }
    }
  }

  return { reconciliationsCreated, disputesCreated, matched, disputed, errors };
}


// ─── PROMPT 5: Terminy kaucyjne per operator (applyDayType) ────────────────

// Dodaj N dni do daty, z rozróżnieniem kalendarzowych vs roboczych.
// CALENDAR: proste dodanie days * 86400000.
// BUSINESS: pomija weekendy i polskie święta (algorytm Gaussa dla Wielkanocy + święta stałe).
export function applyDayType(startDateMs: number, days: number, dayType: "CALENDAR" | "BUSINESS"): number {
  if (days <= 0) return startDateMs;
  if (dayType === "CALENDAR") {
    return startDateMs + days * 86400000;
  }
  return addBusinessDays(new Date(startDateMs), days).getTime();
}

// Pobierz terminy kaucyjne dla kontraktu (konfigurowalne per operator).
// Czyta z operator_terms (najnowszy ważny wpis per contract_id).
// Zwraca { report_days, payout_days, day_type } lub domyślnie 7/14/BUSINESS jeśli brak.
export function getOperatorTerms(env: any, contractId: number): { reportDays: number; payoutDays: number; dayType: "CALENDAR" | "BUSINESS" } {
  const now = Date.now();
  const rows = env.sql.query<{ report_days: number; payout_days: number; day_type: string }>(
    "SELECT report_days, payout_days, day_type FROM operator_terms " +
    "WHERE contract_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) " +
    "ORDER BY valid_from DESC LIMIT 1",
    [contractId, now, now]
  );
  if (rows.length === 0) {
    return { reportDays: 7, payoutDays: 14, dayType: "BUSINESS" }; // domyślne fallback
  }
  return {
    reportDays: rows[0].report_days,
    payoutDays: rows[0].payout_days,
    dayType: rows[0].day_type === "CALENDAR" ? "CALENDAR" : "BUSINESS",
  };
}
