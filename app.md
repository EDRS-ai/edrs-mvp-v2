---
name: edrs-mvp-v2
description: edrs.io MVP v2 — clean rebuild per Sprint 2 spec. Auth via httpOnly+Secure+SameSite=Lax cookie, no query param fallback, 12h idle timeout, token rotation per login, integration test for token leak vectors.
manifest_version: 1
enabled: true
visibility: public
triggers:
  schedule:
    cron: "0 * * * *"
    timezone: UTC
    enabled: true
---

# edrs.io MVP v2 — Sprint 2 (PROMPT 0)

Clean rebuild. Difference from `edrs-mvp`:
- Session token delivered via **httpOnly + Secure + SameSite=Lax** cookie
- **No query param fallback** — server reads cookie + Authorization header only
- **12-hour idle timeout** via new `last_activity_at` column on `sessions`
- **Token rotation** on every login (fresh token per sign-in)
- Integration test verifies token does not leak to URL, query param, or Referer

Scope is strictly PROMPT 0. Schema and business logic unchanged beyond the `last_activity_at` column required by idle timeout. No new features.

Demo logins (seeded on first deploy):
- Master: `maciej@net4zero.pl` / `edrs2026`
- Investor A: `inwestor.a@net4zero.pl` / `edrs2026`
- Investor B: `inwestor.b@net4zero.pl` / `edrs2026`
- Driver: `kierowca@net4zero.pl` / `edrs2026`


## PROMPT 6 (Scale-Ready) — Postgres dual-driver

Pilot (24 pkt) działa na Cloudflare DO SQLite + Drizzle sqlite-proxy. Dla 4000+ pkt potrzebujemy Postgres (per `README.md` — IOPS throttling na write bursts + N+1 queries w settlement engine).

**Dual-driver pattern** — `src/db.ts` sprawdza `env.DATABASE_URL`:
- **Present → Neon Postgres** (production, HTTP driver via `@neondatabase/serverless`, scales do 4000+ pkt)
- **Missing → Cloudflare DO SQLite** (development / pilot <250 pkt, zero setup)

**To enable Neon in production:**
1. Create Neon project at https://console.neon.tech (free tier: 191h compute/mies + 0.5GB storage, ~$0 dla pilotażu)
2. Get connection string: `postgres://...?sslmode=require`
3. Set env var `DATABASE_URL` w Sauna deployment settings
4. Redeploy — następny request auto-routes do Neon

**No vendor lock-in:** Neon = standard Postgres. Switch providers (RDS, Supabase, lokalny) przez zmianę `DATABASE_URL`.

**Koszty:** free tier pokrywa pilot (4000 pkt × 5-dniowe cykle = <500k ledger entries/mies). Upgrade plan tylko jeśli >10k pkt.

## PROMPT 7 (Realtime) — SSE event stream + live map of Poland

PROMPT 7 dodaje real-time streaming dla MasterApp (zakładka "Mapa live"):

- **SSE endpoint**: `GET /api/admin/events/stream` — **micro-burst pattern** (jedno połączenie = jeden query + flush + close, EventSource auto-reconnect po `retry: 3000` z `Last-Event-ID`)
- **Event bus**: `event_log` (istniejący) + nowe typy eventów emitowane przez handlery
- **Cursor transport**: SSE `id:` field = `event_log.id` (PK), **nie** timestamp — batch INSERTs (`insertLedgerEntriesBatch`, logEvent loops) powodują kolizje na `created_at`
- **Auth**: `requireMaster` (stream + snapshot). Investor NIE widzi mapy — brak scopingu per `investor_org_id` w event_log (tenancy leak); investor scoping = PROMPT 8
- **Snapshot**: `GET /api/admin/map/snapshot` (master) — jeden GET zwraca 2000+ pkt + cursor (kompaktowe tablice, ~120 KB)
- **Dev tools** (master only): `POST /api/admin/dev/seed-locations` (16 miast PL, batch 500/call, zwraca `remaining` — klient woła aż 0), `POST /api/admin/dev/simulate` (location/credit/dispute bursts), `POST /api/admin/dev/purge-locations` (czyści SYN-%)

### Nowe typy eventów emitowane przez SSE
Producers działają po fixach C1 (await runSettlementEngine), C2 (orgName), H1 (dispute events z point_id):
- `location.fill_changed` (dev simulate) → kolor markera zmienia się wg fill_tiers. **UWAGA:** driver-complete path emituje w pustkę — `points.id` (NET-xxx) ≠ `locations.id` (SL-xxx/SYN-xxx), `emitLocationUpdate` loguje `console.warn` (patrz Known limitations)
- `cycle.credit_posted` (settlement engine + dev simulate) → toast bottom-right
- `dispute_created` / `ticket_opened` / `dispute_state_transition` (reconciliation, z `point_id` + `deltaPct`/`alertLevel`/`disputedAmountGrosze` w payload) → pulse marker na mapie

### Micro-burst SSE design — dlaczego nie long-poll
Runtime Sauny banuje `setTimeout`/`setInterval` (błędy hibernacji). Dlatego:
1. Auth → query `event_log` WHERE id > cursor → emit każdy row jako SSE frame → emit `: hb` heartbeat → close
2. Browser EventSource reconnect po `retry: 3000` ms z `Last-Event-ID` (cursor transportowany server-side)
3. Feature-detected: jeśli `scheduler.wait` (Cloudflare sanctioned awaitable) dostępny, trzymaj stream do 30 s (`MAX_TICKS=20 × 1500 ms`)

**Zero timers. Zero idle-timeout problem. Zero hibernation problem.** Dla >100 concurrent viewerów — switch na WebSocket + `env.websocket.broadcast`.

### Throttle w auth.ts (resolveSession)
Bez throttle, EventSource reconnect co 3 s = ~20 SQLite writes/min per otwarta zakładka. PROMPT 7 throttluje `UPDATE sessions SET last_activity_at = ?` do **60 s** granularność. 60 s < 12 h idle window — żadna sesja nie wygasa przez throttle.

### Frontend — Leaflet 1.9.4 CDN + Canvas circleMarkers
- **Leaflet**: `https://unpkg.com/leaflet@1.9.4/dist/leaflet.{css,js}` (CDN, zero npm dependency)
- **Markers**: `L.circleMarker` z JEDNYM wspólnym `L.canvas({padding:0.5})` w `rendererRef` (fix H3 — nie renderer-per-marker) — 2000+ markerów bez jank
- **Kolory per fill_%**: 4 tiers — `<30%` green `#16a34a`, `30-70%` yellow `#eab308`, `70-95%` orange `#f97316`, `>95%` red `#dc2626`
- **Pulse dla sporów**: `L.divIcon` z CSS `@keyframes edrsPulse` (1.6 s ease-out, T-1 alert 0.9 s intensywniejszy)
- **Toast dla kredytów**: bottom-right stack, max 4 widoczne, 6 s auto-dismiss z CSS animacją slide
- **Live dot**: pulsing zielony (2 s `edrsBlink`) + reconnect indicator
- **Filter controls**: segmentowane `Wszystko / Punkty / Rozliczenia / Spory` — steruje EventSource `type=` query
- **Demo panel** (master only): `Zasiej 2000 punktów`, `Symuluj ruch`, `Replay 50 zdarzeń`

### Endpoint contract
```
GET /api/admin/events/stream?since=<ms>&sinceId=<id>&type=all|location,cycle,dispute|all_events&replay=N
  Headers: Last-Event-ID: <cursor> (reconnect only)
  Response: text/event-stream
  - First frame: `retry: 3000`
  - Then: `id: <pk>\nevent: <category>\ndata: <JSON>\n\n` per event
  - Heartbeat: `: hb <ts> cursor=<pk>` comment (keepalive)
  - Replay: `?replay=N` last N events DESC reversed (dev mode)
  - Precedence: Last-Event-ID > ?sinceId > ?since > MAX(id)

GET /api/admin/map/snapshot (master)
  Returns: { cursor: <pk>, cols: [id,lat,lng,fill,status,lastCollectionAt,address,district], points: <2000+ rows> }
  ~120 KB dla 2000 pkt

POST /api/admin/dev/seed-locations (master)
  Body: { count?: 2000 } (max 5000)
  Batch: max 500 insertów/call, response { ok, created, total, remaining } — klient woła aż remaining === 0
  Idempotent (INSERT OR IGNORE): zwraca { note: "already_seeded" } jeśli >= target
  16 miast PL + random jitter, bounds [48.9,13.9]–[55.0,24.3]

POST /api/admin/dev/purge-locations (master)
  Usuwa locations SYN-% + powiązane event_log rows

POST /api/admin/dev/simulate (master)
  Body: { locations?: 25, credits?: 2, disputes?: 1 }
  Losuje N pkt → UPDATE fill → emitLocationUpdate, emitRealtimeEvent cycle/dispute
```

### Auth gate
- Bez cookie → HTTP 401 `{"error":"unauthorized"}`
- Driver cookie → HTTP 403 `{"error":"forbidden"}` (wymaga master/investor)
- Master/Investor cookie → stream ramek SSE

### Known limitations (PROMPT 8 candidates)
- **Investor bez mapy** — stream/snapshot to `requireMaster`; scoping eventów per `investor_org_id` = PROMPT 8.
- **points/locations id split** — `points.id` (NET-xxx) i `locations.id` (SL-xxx/SYN-xxx) to różne przestrzenie id; driver-complete `emitLocationUpdate` nie trafia w żaden marker (console.warn). Unifikacja tabel = PROMPT 8.
- **`DATABASE_URL` set later → empty event tail.** `realtime.ts` pins to `env.sql` (synchronous SQLite binding) — ta sama zasada co 105 innych call sites w `handler.ts`. Unifikacja Neon = osobny PROMPT (split-brain handler).
- **>100 concurrent SSE connections saturuje DO facet.** Realistic <20 viewerów (master only). Above 100 → WebSocket + `env.websocket.broadcast`.
- **Markercluster escape hatch** — dla >10k pkt canvas circleMarkers zaczynają dominować paint cost. PROMPT 8 może dodać clustering z kolorową legendą per cluster.

### Bug fixes applied during PROMPT 7
- **`src/lib/settlement.ts(523)`** — dodany brakujący `}` po `return { entriesCreated, partySummary, errors };` (runSettlementEngine kończył się bez zamknięcia — pre-existing bug z PROMPT 6.3, ujawniony przez nowy static check)
- **`src/lib/settlement.ts(16)`** — zmiana `import { makeDb } from "./db"` → `"../db"` (ścieżka prowadziła do nieistniejącego `src/lib/db.ts`, runtime „No such module db" w bundler Cloudflare)
- **`migrations/0000_prompt_6_indexes.sql`** — wszystkie 88 `CREATE TABLE`/`CREATE INDEX`/`CREATE UNIQUE INDEX` konwertowane na `IF NOT EXISTS` (migration idempotentna — nie crashuje na drugim deploy po zakończonym PROMPT 6.3)
- **`src/handler.ts` — usunięte SQL `BEGIN TRANSACTION`/`COMMIT`/`ROLLBACK`** z seed-locations i csv/commit (DO SQLite odrzuca SQL transactions: "use state.storage.transaction()"). Seed dawał 500 na każdym callu; csv/commit to był pre-existing bug z PROMPT 2 — import CSV na produkcji też by padł. Atomowość per request daje auto-coalescing DO; idempotency keys (CSV) i INSERT OR IGNORE (seed) czynią operacje resumable.

### Deployment status (2026-08-11)
- ✅ Full deploy (server + frontend MasterMapaLive + wszystkie fixy z advisor review C1–C3/H1–H4/M1–M7/L2–L8) live pod `https://edrs-mvp-v2-m75lwujx.sauna.new/` (code `c15944061382f65f09f7cc2e5257ee373`)
- ✅ E2E browser-verified (2026-08-11): login master, Mapa live "Na żywo", seed 4×500 → 2024 punkty, Symuluj ruch → toasty kredytów + pulse alerty (2→3) + Zmiany 48→88, zero błędów JS w konsoli
- Login demo: `maciej@net4zero.pl` / `edrs2026`

## PROMPT 8 — Panel inwestora, scoping, unifikacja, agenci wewnętrzni

### Unifikacja points/locations
- Migracja `0001_unify_points_locations.sql`: legacy `points` (NET-xxx) skopiowane do kanonicznej `locations` z zachowaniem id — `collections.point_id` / `event_log.point_id` pasują bez przepisywania. `investor_org_id` mapowany po IDENTYCZNEJ nazwie `investors.name = organizations.name` (celowa konwencja seeda PROMPT 1). Koordynaty: centroidy dzielnic Warszawy + deterministyczny jitter (points nie miały lat/lng).
- Driver-complete path (`/api/driver/jobs/:pointId/complete`) trafia teraz w istniejący wiersz `locations` — `emitLocationUpdate` emituje na mapę zamiast w pustkę (fix martwej ścieżki z PROMPT 7).
- `POST /api/investor/points` robi dual-write (points + locations). Legacy `points` zostaje read-path dla starych endpointów inwestora; pełne wycięcie = osobny PROMPT.

### Scoping per investor_org_id (naprawa H2)
- `GET /api/admin/events/stream` i `GET /api/admin/map/snapshot` → `requireMasterOrInvestor`. Master widzi wszystko; inwestor dostaje eventy TYLKO własnych punktów (`point_id IN (SELECT id FROM locations WHERE investor_org_id = ?)`). Eventy globalne bez point_id (cykle) nie są streamowane do inwestora — przychód czyta z REST.
- Mapowanie legacy `users.investor_id` → `organizations.id`: helper `investorOrgIdOf` (join po nazwie). Brak mapowania → 403 `no_org_mapping`.

### Panel inwestora (model zarządcy wspólnot: wspólnota = inwestor, mieszkanie = urządzenie)
- `GET /api/investor/dashboard`: przychód netto z ledgera (`party_org_id`), butelki per punkt (collections × locations), urządzenia + ostatni heartbeat, śr. zapełnienie.
- UI: Pulpit / Mapa live (ten sam komponent co master, scoped server-side, bez narzędzi demo) / Moje punkty / Odbiory / Rozliczenia / Faktury.
- Login demo inwestora: `inwestor.a@net4zero.pl` / `edrs2026` (Wspólnota Wilanów, org 2).

### Agenci wewnętrzni (cron `0 * * * *` UTC → onSchedule, zero LLM)
- `health_check`: fill ≥ 95% bez odbioru > 48 h → status `alert` + event; odzyskane (fill < 70) → `online`; urządzenia bez heartbeat > 24 h → `offline`.
- `data_quality`: sieroty referencyjne (collections/event_log bez lokalizacji) + weryfikacja hash chain ledgera (prev_hash ↔ entry_hash per cykl) + sanity netto+VAT=brutto.
- `dispute_deadline`: spory po `due_at` bez reakcji → automatyczne zastrzeżenie (default action, wzorzec Square) + event.
- Idempotencja: `idempotency_key = agent:{name}:{bucket-godzinowy}` — retry crona w tej samej godzinie = no-op. Ręczny trigger: `POST /api/admin/agents/run` (master, panel „Agenci”).
- Każdy run audytowalny: event `agent.run_completed` (payload: findings + actions), `source = agent:{name}`, stan w `meta`.

### Zgodność ISO-ready (fundament pod ISO 27001 / 9001)
- **Integralność zapisów**: ledger append-only z łańcuchem SHA-256 (PROMPT 5) + cykliczna weryfikacja łańcucha przez agenta data_quality (A.8.15/A.8.16: logging &amp; monitoring).
- **Rozliczalność**: event_log z actor_id/source/idempotency_key — kto, co, kiedy, skąd; wpisy agentów oznaczone `agent:*`.
- **Kontrola dostępu**: RBAC (master/investor/driver) + scoping tenantów w warstwie zapytań; cookie httpOnly+Secure+SameSite=Lax, 12 h idle.
- **Do zrobienia przed formalnym audytem** (backlog, nie kod): polityka retencji event_log/heartbeats, kopie zapasowe/eksport, rejestr przetwarzania (RODO art. 30), formalne procedury incydentów.

### Znane ograniczenia po PROMPT 8
- Inwestor nie widzi eventu kategorii `cycle` na streamie (kredyty mają payload bez point_id) — przychód w REST; PROMPT 9 doda `party_org_id` do payloadów i scoping kategorii cycle.
- Legacy `points` + `investors` nadal istnieją (read-path starych endpointów) — pełna konsolidacja na organizations/locations = PROMPT 9.
- Naliczenia kosztowe (raty/serwis/prąd), saldo i statement inwestora = PROMPT 9; bramka płatności (PolCard/Fiserv, org 8 w seedzie) = PROMPT 10.
