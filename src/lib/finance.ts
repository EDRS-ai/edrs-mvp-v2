// PROMPT 9 — Finanse inwestora: naliczenia miesięczne z rate_cards, saldo, netting.
//
// Model zarządcy wspólnot: inwestor ma "konto lokalu" w ledgerze (party_org_id).
// Uznania (HANDLING_FEE, DEPOSIT_REIMBURSEMENT...) minus obciążenia (LEASE_RENT,
// SERVICE_FEE, ELECTRICITY_FEE, PLATFORM_SUBSCRIPTION...) = saldo.
// Saldo > 0 → wypłata dla inwestora. Saldo < 0 → do zapłaty (bramka, PROMPT 10).
//
// Zasady twarde:
//   - ZERO STAWEK W KODZIE: naliczenie powstaje wyłącznie z wiersza rate_cards
//     (collection_model='monthly_fixed' na kontrakcie lease inwestora). Brak
//     wiersza = brak naliczenia.
//   - IDEMPOTENCJA: end_to_end_id = charge:{TYP}:{org}:{okres} (unique index) —
//     drugi run w tym samym miesiącu = no-op.
//   - LEDGER NIEZMIENIALNY: wpisy przez insertLedgerEntry (hash chain PROMPT 5).
//   - Punkty SYN-% (syntetyczne demo) NIE są naliczane.

import { insertLedgerEntry } from "./settlement";

// fraction w rate_cards (monthly_fixed) → entry_type w ledgerze.
// ELECTRICITY_FEE rozszerza katalog 18 typów z PROMPT 3 (udokumentowane w app.md).
const FRACTION_TO_ENTRY_TYPE: Record<string, string> = {
  LEASE: "LEASE_RENT",
  SERVICE: "SERVICE_FEE",
  ELECTRICITY: "ELECTRICITY_FEE",
  PLATFORM: "PLATFORM_SUBSCRIPTION",
};

export function currentPeriod(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7); // YYYY-MM (UTC)
}

// Cykl-kontener na naliczenia miesięczne: "OPŁATY-YYYY-MM" (cycle_type platform).
export function ensureChargeCycle(env: any, period: string): number {
  const label = `OPŁATY-${period}`;
  const ex = env.sql.query<{ id: number }>("SELECT id FROM settlement_cycles WHERE label = ?", [label]);
  if (ex[0]) return Number(ex[0].id);
  const [y, m] = period.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1) - 1;
  env.sql.exec(
    "INSERT INTO settlement_cycles (label, period_start, period_end, status, cycle_type, created_at) VALUES (?, ?, ?, 'approved', 'platform', ?)",
    [label, start, end, Date.now()]
  );
  return Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
}

// Aktywne stawki miesięczne inwestora (kontrakt lease, model monthly_fixed).
export function monthlyRates(env: any, orgId: number, at: number) {
  return env.sql.query<any>(
    `SELECT rc.id, rc.fraction, rc.rate_value, rc.rate_unit FROM rate_cards rc
       JOIN contracts ct ON ct.id = rc.contract_id
      WHERE rc.collection_model = 'monthly_fixed' AND ct.type = 'lease'
        AND ct.party_b_org_id = ? AND ct.status = 'active'
        AND rc.valid_from <= ? AND (rc.valid_to IS NULL OR rc.valid_to > ?)
        AND rc.deleted_at IS NULL`,
    [orgId, at, at]
  );
}

export async function generateMonthlyCharges(
  env: any,
  period = currentPeriod()
): Promise<{ cycleId: number; created: number; skipped: number; orgs: number }> {
  const cycleId = ensureChargeCycle(env, period);
  const [y, m] = period.split("-").map(Number);
  const at = Date.UTC(y, m - 1, 1);
  const orgs = env.sql.query<{ id: number }>(
    "SELECT DISTINCT investor_org_id AS id FROM locations WHERE investor_org_id IS NOT NULL AND deleted_at IS NULL AND id NOT LIKE 'SYN-%'"
  );
  let created = 0;
  let skipped = 0;
  for (const o of orgs) {
    const nLoc = Number(
      env.sql.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM locations WHERE investor_org_id = ? AND deleted_at IS NULL AND id NOT LIKE 'SYN-%'",
        [o.id]
      )[0].n
    );
    if (nLoc === 0) continue;
    for (const rate of monthlyRates(env, o.id, at)) {
      const entryType = FRACTION_TO_ENTRY_TYPE[rate.fraction] ?? "OTHER_ADJUSTMENT";
      const e2e = `charge:${entryType}:${o.id}:${period}`;
      const dup = env.sql.query<{ id: number }>("SELECT id FROM ledger_entries WHERE end_to_end_id = ? LIMIT 1", [e2e]);
      if (dup.length > 0) { skipped++; continue; }
      if (rate.rate_unit !== "PLN_PER_POINT_MONTH") { skipped++; continue; }
      const net = Math.round(Number(rate.rate_value) * 100) * nLoc;
      const vat = Math.round(net * 0.23);
      await insertLedgerEntry(env, {
        cycleId,
        entryType,
        partyOrgId: o.id,
        direction: "debit",
        amountNet: net,
        vatRate: 23,
        vatAmount: vat,
        amountGross: net + vat,
        bookingDate: at,
        endToEndId: e2e,
        rateCardId: rate.id,
        author: "agent:monthly_charges",
        source: `charge:${String(rate.fraction).toLowerCase()}`,
      });
      created++;
    }
  }
  return { cycleId, created, skipped, orgs: orgs.length };
}

export function investorBalance(env: any, orgId: number) {
  const r = env.sql.query<{ net: number; gross: number }>(
    `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_net ELSE -amount_net END),0) AS net,
            COALESCE(SUM(CASE WHEN direction='credit' THEN amount_gross ELSE -amount_gross END),0) AS gross
       FROM ledger_entries WHERE party_org_id = ?`,
    [orgId]
  );
  return { netGrosze: Number(r[0].net), grossGrosze: Number(r[0].gross) };
}

export function investorStatement(env: any, orgId: number, limit = 100) {
  return env.sql.query<any>(
    `SELECT le.id, le.entry_type, le.direction, le.amount_net, le.vat_amount, le.amount_gross,
            le.location_id, le.booking_date, le.created_at, le.source, sc.label AS cycle_label
       FROM ledger_entries le LEFT JOIN settlement_cycles sc ON sc.id = le.cycle_id
      WHERE le.party_org_id = ? ORDER BY le.id DESC LIMIT ?`,
    [orgId, Math.min(Math.max(limit, 1), 500)]
  );
}

// ── PROMPT 10: płatność sandbox (PolCard-shaped flow) ────────────────────────
// createPayment → wiersz payments (pending). confirmPayment → wpis ledger
// PAYMENT_RECEIVED (credit, netto=brutto, VAT 0 — wpłata rozlicza brutto) +
// status paid. Idempotencja: end_to_end_id = payment:{id}; podwójny confirm
// zwraca istniejący stan zamiast dublować wpis.
export function createPayment(env: any, orgId: number, userId: number): { id: number; amountGrosze: number } | { error: string } {
  const bal = investorBalance(env, orgId);
  if (bal.grossGrosze >= 0) return { error: "nothing_due" };
  const amount = -bal.grossGrosze;
  const now = Date.now();
  const reference = `pay:${orgId}:${now}:${Math.floor(Math.random() * 1e6)}`;
  env.sql.exec(
    "INSERT INTO payments (org_id, amount_grosze, status, provider, reference, created_by, created_at) VALUES (?, ?, 'pending', 'polcard_sandbox', ?, ?, ?)",
    [orgId, amount, reference, userId, now]
  );
  const id = Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
  return { id, amountGrosze: amount };
}

export async function confirmPayment(env: any, orgId: number, paymentId: number): Promise<{ ok: boolean; status?: string; error?: string }> {
  const p = env.sql.query<any>("SELECT id, org_id, amount_grosze, status FROM payments WHERE id = ? AND org_id = ?", [paymentId, orgId]);
  if (p.length === 0) return { ok: false, error: "not_found" };
  if (p[0].status === "paid") return { ok: true, status: "paid" };
  if (p[0].status !== "pending") return { ok: false, error: `bad_status:${p[0].status}` };
  const e2e = `payment:${paymentId}`;
  const dup = env.sql.query<{ id: number }>("SELECT id FROM ledger_entries WHERE end_to_end_id = ? LIMIT 1", [e2e]);
  let entryId: number;
  if (dup.length > 0) {
    entryId = Number(dup[0].id);
  } else {
    const cycleId = ensureChargeCycle(env, currentPeriod());
    entryId = await insertLedgerEntry(env, {
      cycleId,
      entryType: "PAYMENT_RECEIVED",
      partyOrgId: orgId,
      direction: "credit",
      amountNet: Number(p[0].amount_grosze),
      vatRate: 0,
      vatAmount: 0,
      amountGross: Number(p[0].amount_grosze),
      bookingDate: Date.now(),
      endToEndId: e2e,
      author: "polcard_sandbox",
      source: "payment:polcard_sandbox",
    });
  }
  env.sql.exec("UPDATE payments SET status = 'paid', paid_at = ?, ledger_entry_id = ? WHERE id = ?", [Date.now(), entryId, paymentId]);
  return { ok: true, status: "paid" };
}

export function paymentsFor(env: any, orgId: number, limit = 50) {
  return env.sql.query<any>(
    "SELECT id, amount_grosze, status, provider, reference, created_at, paid_at FROM payments WHERE org_id = ? ORDER BY id DESC LIMIT ?",
    [orgId, limit]
  );
}
