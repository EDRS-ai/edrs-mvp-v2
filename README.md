# edrs-mvp-v2

**Clean rebuild** per Sprint 2 spec — system rozliczeń kaucyjnych dla sieci RVM w Polsce (Śląsk/Wrocław pilot).
Live: https://edrs-mvp-v2-m75lwujx.sauna.new/

## Sprint 2 — co jest zrobione

| Prompt | Co | Status |
|---|---|---|
| 0 | Auth: httpOnly+Secure+SameSite=Lax cookie, 12h idle, token rotation, brak query param fallback | ✅ deployed |
| 1 | Model danych: 8 organizations, 2 regions, **24 Śląsk locations** (Katowice/Gliwice/Zabrze/Bytom/Chorzów/Sosnowiec/Tychy), 20 devices, 4 contracts, 12 rate_cards (historia: PET 0.15→0.16→0.17), location_operators n:m, memberships | ✅ deployed |
| 2 | Event log + import: import_profiles, packaging_items (4 EAN), catalog_overrides (per local/global), universal CSV dry-run/commit | ✅ deployed |
| 3 | Silnik rozliczeń: ledger_entries (niezmienialne, 3 osie dat, 18 entry_types, end_to_end_id), runSettlementEngine (5 stron, ZERO stawek w kodzie), approve/reopen (reversal entries), getLedgerForCycle (invariant credit=debit) | ✅ deployed |
| 4 | Rekoncyliacja + spory: reconciliations (3 źródła A/B/C, delta_pct, próg 2%), disputes (8 stanów Square Dispute), kalkulator DNI ROBOCZYCH (Gauss + święta stałe), dispute state machine (5 dni roboczych due_at + akcja domyślna), MasterDisputes UI (alerty none/warning/critical/overdue) | ✅ deployed |
| **5** | **Pilot-Ready:** hash chain (SHA-256 prev_hash→entry_hash, append-only), DISPUTE_HOLD mrozi tylko kwotę sporną (test: 10 pozycji → 9 wypłacone + 1 HELD), operator_terms per kontrakt (Reselekt: 7/14 dni BUSINESS), applyDayType, getThreshold per kontrakt, proportional platform fee (500 zł/pkt/mc za aktywne dni), execute-hold endpoint, export CSV+HTML dla inwestora | ✅ local, **deploy pending** |

## Znany dług techniczny (przed wdrożeniem pilotażowym)

1. **SQLite (Drizzle na Cloudflare worker Durable Object).** Pilotaż 20-30 pkt jest OK; **powyżej 500 pkt** lub przy 2. integracji operatora — wymiana na Postgres jest obowiązkowa (patrz "Twardy próg wymiany" niżej).

2. **N+1 queries w settlement engine i reconciliation engine.** `runSettlementEngine` robi ~25 zapytań per credit × N credits = **~750 zapytań dla 250 pkt na cykl**. Akceptowalne dla pilotażu (5-10s na cykl), ale **nie do skali** — Postgres + batch INSERT jest konieczny.

3. **Brak paginacji.** UI ładuje wszystkie locations + wszystkie disputes. Przy 50+ punktach UI zaczyna się mulić. **Wymiana: virtual scroll + paginowane API**.

4. **Threshold rekoncyliacji jako stała w kodzie.** `getThreshold(contractId)` czyta z `rate_cards` (`packaging_type='reconciliation_threshold', rate_unit='PCT'`) — ale **seed nie ma takiego wpisu**, więc silnik zawsze zwraca fallback `2.0%`. Akceptacja warunkowa z PROMPT 5: dla pilotażu OK, ale **aneks do każdego kontraktu musi wprowadzić konkretny próg** jako wiersz w `rate_cards`.

5. **No data migration tooling.** Jeśli zmigrujemy na Postgres, nie mamy skryptu migracji SQLite → Postgres. Wymaga jednorazowej inwestycji przy wymianie.

## Twardy próg wymiany na Postgres + batch INSERT + virtual scroll

**Wymiana OBOWIĄZKOWA** (cokolwiek pierwsze):

- **A) Skala operacyjna:** >500 punktów podłączonych, LUB
- **B) Drugi operator kaucyjny** (np. oprócz Reselekt też Action / Tomra / inny IPZ-operator) — N mnoży queries.

**Inwestycja przy wymianie:**
- Postgres (Neon / Supabase / managed)
- Drizzle batch INSERT (`db.batch([...inserts])`)
- API paginowane (`?limit=50&offset=N`)
- Virtual scroll w UI (TanStack Virtual lub react-window)
- Szacowany czas: **2-3 tygodnie** (1 dev)

## Architektura (Sprint 2 — docelowa)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend (React + Hono)                                              │
│  - Master: pełny panel (6 zakładek: Overview, Points, Cycles,         │
│    Reconciliations, Disputes, Catalog/EAN)                            │
│  - Investor: tylko swoje punkty + swoje settlements                    │
│  - Driver: zbiórki + status (per collection)                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Backend (Hono + Drizzle + Cloudflare Workers Durable Object)         │
│  - Auth: cookie (httpOnly+Secure+SameSite=Lax, 12h idle, rotation)   │
│  - Ledger: append-only, hash chain SHA-256 (PROMPT 5)                │
│  - Settlement engine: 5 stron per odbiór (driver/carrier/investor/   │
│    handling/platform), dispute_hold (PROMPT 5), platform prorated    │
│  - Reconciliation: 3 źródła (device/sorter/operator), 8 stanów sporu  │
│  - CSV import: dry-run + commit, idempotency, catalog_overrides     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Dane (SQLite → Postgres)                                              │
│  8 organizations, 24 locations (Śląsk), 20 devices, 4 contracts,       │
│  12 rate_cards, ~30 cycles, ledger append-only, events                │
└─────────────────────────────────────────────────────────────────────┘
```

## Demo logins (master panel)

| Rola | Email | Hasło |
|---|---|---|
| Master (CEO NET4ZERO) | maciej@net4zero.pl | `edrs2026` |
| Investor A (Wspólnota Wilanów) | inwestor.a@net4zero.pl | `edrs2026` |
| Investor B (Fundacja Eko Praga) | inwestor.b@net4zero.pl | `edrs2026` |
| Driver (Jan Kowalski) | kierowca@net4zero.pl | `edrs2026` |

Master ma pełny panel z 6 zakładkami (włącznie z nową Spory i Katalog EAN).

## Poza zakresem (na później)

driver app · chain of custody · Emapa/VRP · live telemetry · KSeF (wraca po pilotażu) · portale · multi-acquirer · waterfall · data room · publiczne API.
