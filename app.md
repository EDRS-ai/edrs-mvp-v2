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

## PROMPT 9/10/11 — Finanse, płatności (PolCard sandbox), wiadomości (MVP complete)

### PROMPT 9 — Naliczenia, saldo, netting
- `src/lib/finance.ts`: naliczenia miesięczne WYŁĄCZNIE z `rate_cards` (collection_model=`monthly_fixed` na kontrakcie `lease` inwestora; fraction LEASE→LEASE_RENT, SERVICE→SERVICE_FEE, ELECTRICITY→ELECTRICITY_FEE — rozszerzenie katalogu typów z PROMPT 3). Zero stawek w kodzie.
- Kontener naliczeń: cykl `OPŁATY-YYYY-MM` (cycle_type platform). Wpisy przez `insertLedgerEntry` (hash chain). Idempotencja: `end_to_end_id = charge:{TYP}:{org}:{okres}`.
- Punkty SYN-% NIE są naliczane (dane syntetyczne demo).
- Saldo = SUM(credit) − SUM(debit) per `party_org_id`. Netting: opłaty potrącane z przychodów kaucyjnych; saldo ujemne → płatność.
- Agent 4 `monthly_charges` (cron godzinowy, idempotentny) — naliczenia generują się same 1. dnia miesiąca bez ręcznej akcji.
- Endpointy: `GET /api/investor/finance` (saldo+wyciąg+płatności), `GET /api/investor/contracts` (umowy+stawki), `POST /api/admin/dev/seed-finance` (kontrakty lease + stawki demo 400/60/45 zł/pkt/mc + naliczenia — stawki trafiają do DB, idempotentne).

### PROMPT 10 — Płatności (PolCard/Fiserv — tryb sandbox)
- Tabela `payments` (migracja 0002). Flow: saldo brutto < 0 → `POST /api/investor/payments` (intent pending, kwota = −saldo) → `POST /api/investor/payments/:id/confirm` (sandbox) → wpis `PAYMENT_RECEIVED` (credit, VAT 0, hash chain, `end_to_end_id = payment:{id}`) → saldo 0. Podwójny confirm = no-op.
- Eventy audytowe: `payment_created`, `payment_confirmed` (actor_id inwestora).
- **Produkcyjnie**: confirm zastępuje webhook PolCard/Fiserv (org 8 w seedzie). Wymaga umowy PSP i onboardingu merchanta — proces biznesowy, nie techniczny. Dokumenty Fiserv/Polcard (umowa główna, polecenie zapłaty, regulacje produktowe) są w workspace usera.

### PROMPT 11 — Wiadomości inwestor ↔ operator
- Tabela `messages` (wątek = org inwestora). `GET/POST /api/investor/messages`, `GET/POST /api/admin/messages` (master: lista wątków z licznikiem nieprzeczytanych + wątek per org). Odczyt oznacza read_at drugiej strony. In-app only — zero wysyłek zewnętrznych.

### E2E (2026-08-11, browser-verified, zero błędów JS)
- seed-finance: 2 kontrakty lease, 6 stawek, 6 naliczeń (cykl OPŁATY-2026-08, 3 orgi)
- Inwestor A: saldo −18 634,50 zł brutto (LEASE_RENT+SERVICE_FEE+ELECTRICITY_FEE, 7 pkt × 505 zł netto + VAT) → „Zapłać (PolCard)" → PAYMENT_RECEIVED → **saldo 0,00 zł**, płatność #1 opłacona
- Umowy: 1 kontrakt + 3 stawki widoczne; Wiadomości: inwestor→master (unread badge) →odpowiedź mastera — obie strony OK

## PROMPT 12 — Dokumenty, sprawozdania z akceptacją, landing kafelkowy, mobile (wzór eMieszkaniec)

Dyrektywa Maćka: „platforma powinna wyglądać i działać jak emieszkaniec.pl". Mapowanie modułów w `documents/personal-0DaTPe4r/edrs/2026-08-11_eMieszkaniec_mapowanie_PROMPT12.md`.

### Archiwum dokumentów
- Tabele `documents` + `doc_blobs` (migracja 0003). Bajty shardowane ≤1.8 MB/wiersz; limit pliku 6 MB (upload JSON base64). `org_id NULL` = dokument globalny.
- Master: upload (tytuł, kategoria, odbiorca org/wszyscy) + archiwum + soft delete. Inwestor: lista własne+globalne, download przez `/api/documents/:id/download` (auth: master lub org właściciela; inline content-disposition).
- Audyt: eventy `document_uploaded` / `document_deleted` z actor_id.

### Sprawozdania miesięczne z akceptacją (odpowiednik „uchwał")
- `renderStatementHtml`: rozliczenie per org per okres (YYYY-MM) renderowane z ledgera — uznania/obciążenia/saldo netto+brutto, branding edrs.io, stopka o hash chain. Czysty widok, zero nowej logiki księgowej.
- Akceptacja: `statement_acceptances` (unique org+period) + event `statement_accepted`. Inwestor: lista okresów → Otwórz/Akceptuję. Master: status akceptacji wszystkich inwestorów + podgląd.

### Wygląd (eMieszkaniec-style)
- Landing: sekcja „Poznaj możliwości Twojego nowego systemu" — 8 kafelków modułów (ewidencja, mapa live, naliczenia, e-kartoteka, płatności, sprawozdania, dokumenty, komunikacja).
- NavShell: mobile drawer (hamburger < lg, overlay, auto-close po wyborze), header i main responsywne.

### E2E (2026-08-11, browser-verified, zero błędów JS)
- Upload regulaminu (master, globalny) → widoczny i pobieralny u inwestora (bajty zgodne z treścią)
- Sprawozdanie 2026-08 Inwestora A: uznania 18 634,50 / obciążenia 15 150,00 / saldo 3484,50 zł → Akceptuję → status „zaakceptowane" (widoczny też u mastera)
- Landing: 8 kafelków renderuje się; mobile: drawer działa (hamburger → wybór → zamknięcie)

### Znane ograniczenia
- Limit dokumentu 6 MB (base64 przez JSON); większe pliki = multipart/chunked upload w przyszłym PROMPT.
- Statement grupuje po miesiącu `booking_date` (fallback `created_at`) — wpisy bez booking_date liczą się do miesiąca utworzenia.

## PROMPT 13 — warstwa zaufania (2026-08-11)

- `src/lib/legal.ts`: `renderRegulamin()` (§1–§8, ustawa o świadczeniu usług drogą elektroniczną) i `renderPolitykaPrywatnosci()` (RODO) — server-side HTML, oznaczone „wersja 1.0 — do przeglądu prawnego".
- Routes publiczne: `GET /regulamin`, `GET /polityka-prywatnosci` (cache 1h).
- Landing: 4-kolumnowa stopka (marka, Produkt, Dokumenty prawne, Kontakt + nota PSP); LoginScreen z akceptacją Regulaminu.

## PROMPT 14 — szata graficzna eMieszkaniec (2026-08-11)

Pełny redesign wizualny wg wzorca emieszkaniec.pl (PDF od usera):
- Design system: granat `brand-navy #14315D`, niebieski `brand-blue #1565C0`, pomarańcz `brand-orange #F26722`; typografia Roboto + Roboto Condensed (nagłówki); tailwind.config inline w `public/index.html`.
- Landing przebudowany: hero = dwie karty z grubym borderem (niebieska „Platforma operatora" z widgetem live, pomarańczowa „Panel inwestora"), sekcja możliwości w układzie ikona-w-kafelku + tekst z pogrubionym leadem (naprzemiennie niebieski/pomarańczowy), banner KSeF, sekcja korzyści + wielkie pomarańczowe liczby pilotażu, stonowany cennik, jasna stopka.
- NavShell: granatowy sidebar, aktywna pozycja z pomarańczowym lewym borderem, biały header z condensed tytułem.
- KpiCard: biała karta z niebieską górną krawędzią (border-t-4), condensed liczby.
- Chrome odzielone od semantyki: przyciski akcji green→brand-blue; statusy/finanse (credit/debit, fill-bary, badge) pozostały w kolorach semantycznych.
- Strony legal: akcenty green→blue.
- E2E: landing (desktop+mobile, screenshoty) + panel master (sidebar/KPI/Mapa live/Agenci przez browser_use) — zero błędów JS.

## PROMPT 15 — ewidencja punktów + edytor stawek (2026-08-11)

Filozofia integracji danych: API tam, gdzie dane płyną często (telemetria, płatności); wpis jednorazowy tam, gdzie płynie umowa (prąd, serwis, leasing = rate_cards); docelowo koszty rzeczywiste przez KSeF (faktury zakupowe).

- **Endpointy master**: `GET/POST /api/admin/locations` (lista bez SYN-%, liczba syntetycznych, orgs inwestorskie, auto-numeracja nextId NET-xxx), `PATCH /api/admin/locations/:id` (edycja + deactivate=soft delete), `GET/POST /api/admin/rate-cards`.
- **Walidacje POST locations**: regex ID, adres min 5, koordynaty wymagane i w granicach PL (48.9–55.1 / 13.9–24.2), duplikat ID → 409, inwestor musi istnieć, **ostrzeżenie bliskości <150 m** (equirectangular; 409 `BLISKO:` → klient confirm → force:true).
- **Wersjonowanie stawek**: POST rate-cards zamyka bieżącą wersję tej samej kombinacji (valid_to = nowy valid_from) i wstawia nową — bez mutacji wartości; przeliczenia biorą stawkę z daty zdarzenia. Frakcje: LEASE/SERVICE/ELECTRICITY/PET/ALU/GLASS.
- **Event log**: location.created / location.updated / location.deactivated / rate_card.created (source admin_ui, idempotency keys).
- **UI**: zakładka „Punkty" (tabela + formularz z mini-mapą Leaflet: geokodowanie Nominatim client-side, klik/drag pineski, dzielnica, inwestor, czynsz) i „Stawki" (formularz nowej wersji + tabela z badge „aktualna", zamknięte wersje wyszarzone).
- **Ogonki**: przywrócone polskie diakrytyki na landing page (56 fraz z PROMPT 14).
- **E2E (browser_use)**: NET-011 dodany przez formularz (geokod Marszałkowska 100 → 52.22774,21.01252), widoczny w tabeli; nowa wersja stawki ELECTRICITY 45 zł — stara zamknięta 10.08.2026, nowa „aktualna"; zero błędów JS.

## PROMPT 16 — dane pokazowe (2026-08-11)

Powód: panel wyglądał na pusty (1 dokument, 2 wiadomości, 0 heartbeatów) — demo bez treści nie sprzedaje.

- **Endpoint** `GET /api/admin/dev/seed-demo-content` (requireMaster), idempotentny przez `idempotency_key = seed:demo-content:v2` w event_log.
- **10 dokumentów** z realną treścią i pełną polską ortografią: cennik usług 2026, wzór umowy najmu powierzchni pod recyklomat, instrukcja obsługi R1, instrukcja BHP odbioru, karta lokalizacji (formularz), procedura reklamacji i sporów, umowa powierzenia RODO (globalne) + protokół montażu NET-011 i dwie umowy inwestorskie (per org 2 / org 3).
- **10 wiadomości** w dwóch wątkach (montaż, alert zapełnienia 94%, akceptacja sprawozdania, wyciąg operacji, rozbudowa sieci) z realistycznymi znacznikami czasu i read_at.
- **260 heartbeatów** urządzeń (20 × 13 punktów czasowych co 2 h, jedno urządzenie offline) — zasila widoki telemetryczne i agenta health_check.
- **Fix**: pierwsza wersja zwracała 500 — użyto `c.get("user")` zamiast `c.get(APP_USER_KEY)`. Wersja v2 dodatkowo usuwa dokumenty v1 (bez ogonków) przed wstawieniem i czyści tabelę messages, żeby demo było spójne.
- **E2E (browser_use)**: seed `{"ok":true,"docs":10,"messages":10}`; master widzi 11 dokumentów, inwestor A widzi 10 (bez „pakiet 4 punktów" należącego do inwestora B — izolacja potwierdzona); treść pliku i wiadomości z poprawnymi ogonkami; zero błędów JS.

## PROMPT 17 — oryginalne pozycjonowanie marketingowe (2026-08-12)

Powód: poprzedni H1 „Poznaj edrs.io — kompleksowy system...” był zbyt bliski nagłówkowi eMieszkańca i nie budował własnej kategorii.

- Research porównawczy: DRS/RVM (Sensoneo, TOMRA, RVM Systems, Kaucja.pl, Reselekt, RecyHub, EcoAction), logistyka/floty (Samsara, Motive, Flexport, Webfleet, Fleetio), fintech rozliczeniowy (Stripe, Adyen, Modern Treasury, Ramp), polski B2B regulowany (Autenti, Fakturownia, Symfonia, eMieszkaniec).
- Nowe pozycjonowanie: **„Infrastruktura rozliczeniowa dla sieci recyklomatów”**; eyebrow „System kaucyjny poza handlem”; wspierający claim „Od butelki do faktury”.
- Nowy hero: kategoria + wynik + mechanizm; usunięte frazy „Poznaj... kompleksowy system”, „Przetestuj już dziś” i inne elementy copy zbyt bliskie eMieszkańcowi.
- Pasek dowodów: 2 024 zdarzenia telemetryczne, SHA-256, automatyczna kontrola co godzinę, KSeF w cenie.
- Nowa sekcja „Dla kogo”: Operator sieci / Inwestor / Punkt zbiórki, każda z problemem i wynikiem.
- Zmienione CTA: „Zobacz demo na żywo”, „Wejdź do panelu operatora”, „Wejdź do panelu inwestora”.
- Zmienione nagłówki sekcji i cennika na własny język kategorii.
- `<title>`: `edrs.io — Infrastruktura rozliczeniowa dla sieci recyklomatów`.
- Pełny brief: `documents/personal-0DaTPe4r/edrs/2026-08-12_Brief_Marketingowy_edrs_io.md` — pozycjonowanie, persony, analiza komunikacji 20+ marek, hierarchy of messages, copy bank, struktura strony, dowody, kanały, obiekcje, KPI i plan 90 dni.
- Browser verification: desktop 1365×768 + mobile 390×768; HTTP 200, brak page errors i failed requests. Znane ostrzeżenie: Tailwind Play CDN w produkcji (do usunięcia przed pełnym production hardening).

## PROMPT 18 — mechanizmy MVP z researchu międzybranżowego (2026-08-12)

- Migracja `0004_mvp_settlement_legs_driver_events`: `settlement_groups`, `settlement_legs`, `driver_job_events`; idempotency unique, indeksy status/cycle/party/driver.
- Settlement manifest: `GET /api/admin/cycles/:id/manifest`; synchronizuje każdą ledger entry do niezależnej nogi ze stanem PENDING/ELIGIBLE/HELD/SETTLED/REVERSED; agregat dopuszcza PARTIALLY_SETTLED. `effective_at` bierze event/operational/booking date, `recorded_at` zachowuje czas zapisu.
- Korekty pozostają kompensacyjne przez istniejące `reversal_of_id`; ledger ma 3 osie dat i SHA-256 hash chain.
- Spory: istniejący 8-state lifecycle + DISPUTE_HOLD; manifest oznacza hold per noga.
- Kierowca: `POST /api/driver/jobs/sync` przyjmuje idempotentny batch do 100 zdarzeń; akcje ACCEPTED/COMPLETED/FAILED, zamknięty katalog reason codes, notatka/dowód/GPS, occurred_at vs recorded_at, online/offline. UI ma lokalny outbox i auto-flush po odzyskaniu sieci.
- Bank Data Room v1: `GET /api/admin/bank-data-room`; read-only pakiet portfolio/cycles/ledger/disputes/telemetry/reconciliation, completeness, SHA-256, disclaimer; jawnie bez score i rekomendacji kredytowej. UI z KPI + eksport JSON.
- Model handlowy skorygowany wszędzie: 500 zł netto/punkt/mc + 220 zł netto/pojazd/mc; usunięte 149 zł i 0,5% z landingu/dashboardu/cennika demo.
- E2E: landing desktop+mobile assertions 500/220/H1; DB potwierdza 3 nowe tabele; Bank Data Room 35 punktów/21 aktywnych/50% kompletności/hash; manifesty: cycle 4 = 1 group, 7 ELIGIBLE legs; driver FAILED BRAK_DOSTEPU z notatką zapisany i odczytany przez admin API. Zero błędów runtime.

## PROMPT 19 — pełne scenariusze pokazowe MVP (2026-08-12)

- Idempotentny endpoint master: `GET /api/admin/dev/seed-mvp-showcase`, blokada przez `event_log.idempotency_key = seed:mvp-showcase:v1`.
- Seed cyklu 4: 6 rekoncyliacji trzech źródeł (RVM / hub scale / deposit operator): 3 matched, 2 variance, 1 disputed.
- 2 spory: NET-003 `EVIDENCE_REQUIRED` 1 245,00 zł z trzema dowodami; NET-007 `INQUIRY_PROCESSING` 689,00 zł z proof kierowcy, plombą, GPS i zdjęciem demo.
- `DISPUTE_HOLD` 1 245,00 zł dopisany przez append-only `insertLedgerEntry` z SHA-256 i stabilnym end_to_end_id. Manifest cyklu: 2 grupy, 8 nóg; grupa NET-003 = HELD.
- 4 faktury demo: abonament 6 pkt, moduł kierowcy 3 pojazdy, abonament 4 pkt i korekta NET-007; widoczność scoped per inwestor.
- 5 historycznych zdarzeń kierowcy: ACCEPTED, COMPLETED i FAILED z reason codes, GPS, timestamp, plomba/photoRef; jedno z `sync_source=offline`.
- E2E browser_use: seed zwrócił `{cycleId:4,reconciliations:6,disputes:2,invoices:4,driverEvents:5,manifestGroups:2,manifestLegs:8}`; master widzi spory i hold; inwestor A widzi dwie własne faktury i finanse; kierowca widzi zlecenia i outbox. Zero błędów JS/runtime.

## PROMPT 20 — profesjonalne formularze wprowadzania danych (2026-08-13)

- Nowa zakładka master „Wprowadzanie danych” z 6 kartami procesowymi, nie jednym formularzem ogólnym: Urządzenie RVM, Kierowca/przewoźnik, Kontrakt, Odbiór ręczny, Faktura, Spór.
- `GET /api/admin/data-entry/options`: organizacje, rzeczywiste lokalizacje, kierowcy, cykle i inwestorzy do dropdownów; dane odświeżają się po zapisie.
- 6 walidowanych endpointów POST `/api/admin/data-entry/{device|driver|contract|collection|invoice|dispute}`; master-only, `clientRequestId` wymagany, idempotencja przez unikalny `event_log.idempotency_key`.
- Urządzenie: ID, serial, producent, model, firmware, lokalizacja, terminal MID/TID, pojemności PET/ALU/szkło, instalacja i gwarancja; walidacja duplikatu ID/serial.
- Kierowca/przewoźnik: nazwa, typ, firma, BDO + status weryfikacji, ID GPS; walidacja unikalności BDO.
- Kontrakt: typ z zamkniętego katalogu, strony organizacyjne, valid_from/to, wypowiedzenie, referencja dokumentu; strony muszą istnieć i być różne.
- Odbiór ręczny: punkt, kierowca, cykl, liczba opakowań, masa, timestamp, plomby, GPS; aktualizuje ostatni odbiór punktu, plomby/GPS w event_log.
- Faktura: KSeF/roboczy numer, odbiorca, inwestor/kierowca, tytuł, kwota PLN, data, status; unikalny numer KSeF.
- Spór: cykl, punkt, kwota, deadline, delta%, powód i dowód; tworzy reconciliation + dispute `EVIDENCE_REQUIRED`.
- UI: wymagane pola oznaczone, podpowiedzi domenowe, responsywny grid, zielony komunikat ID po sukcesie, komunikat walidacji po błędzie.
- Naprawa po UAT-01: `entryLog` miał 11 wartości dla 10 kolumn i zwracał 500 po poprawnym zapisie. Poprawiono liczbę placeholderów i dodano defensywny catch z `ENTRY_LOG_FAILED`.
- E2E UAT-02: zapisane 6/6 rekordów przez UI: device RVM-UAT-014, driver #8, contract #9, collection #15, invoice #13, dispute #5 / reconciliation #9. Reload potwierdził nowego kierowcę w dropdown; zero błędów JS.

## PROMPT 21 — Energia i koszty mediów (2026-08-14)

Moduł zarządzania energią wzorowany na procesach Comarch ERP XL / enova365 (faktura → zobowiązanie → akceptacja → preliminarz/paczka → ręczne potwierdzenie rozrachunku) oraz Schneider EcoStruxure / Siemens Energy Manager / SAP Utilities (licznik, jakość odczytu, baseline, odchylenie faktury od pomiaru i taryfy).

### Model danych i migracja
- Migracja `0005_energy_management` tworzy 7 tabel: `energy_suppliers`, `energy_contracts`, `energy_meters`, `energy_readings`, `energy_invoices`, `energy_payment_orders`, `energy_alerts` + indeksy i unikalności.
- Relacja: dostawca → umowa/PPE/taryfa/moc/cena → licznik/RVM/punkt → odczyty → faktura → walidacja → zlecenie płatności → ręczne potwierdzenie z wyciągu.
- Odczyty mają `read_at`, stan narastający, interwał kWh, źródło i jakość (`valid|estimated|suspect|corrected`).

### API i workflow
- `GET /api/admin/energy/dashboard`, `GET /api/admin/energy/options`.
- POST formularze: `/energy/suppliers`, `/energy/contracts`, `/energy/meters`, `/energy/readings`, `/energy/invoices`.
- `validateEnergyInvoice`: oczekiwany koszt = kWh × stawka + opłata stała; porównanie z sumą odczytów w okresie; PASS ≤3%, WARNING ≤10%, FAIL >10% lub brak danych.
- Faktura: RECEIVED → DATA_VALIDATION / OPERATIONAL_APPROVAL → APPROVED_FOR_PAYMENT / ON_HOLD → PAID_RECONCILED.
- `POST /energy/invoices/:id/approve-payment`: FAIL blokuje; WARNING trafia ON_HOLD; PASS zatwierdza.
- `GET /energy/payments/:id/export`: CSV paczki przelewu. Eksport nie jest zapłatą.
- `POST /energy/payments/:id/mark-paid`: wymaga numeru potwierdzenia/wyciągu; payment SETTLED, invoice PAID_RECONCILED. Brak udawania działającego bank API.
- Alarm `CONSUMPTION_SPIKE`: interwał >2× średniej 7 odczytów; >4× = critical. Alert ma status OPEN/ACKNOWLEDGED.

### UI
- Nowa zakładka master `Energia` z 4 sekcjami: Podsumowanie, Dostawcy i umowy, Liczniki i odczyty, Faktury i płatności.
- KPI: kWh 30 dni, faktury do zapłaty, przeterminowane, alerty, liczba umów/dostawców.
- Tabela per punkt: kWh, koszt netto, opakowania, kWh/1000 opakowań, koszt/1000 opakowań.
- Formularze dostawcy, PPE/umowy, licznika, odczytu, faktury; lista faktur z walidacją, eksportem i ręcznym potwierdzeniem płatności.

### Dane demo i E2E
- Idempotentny `POST /api/admin/dev/seed-energy`: 2 dostawców demo, 3 umowy/PPE, 3 liczniki, 93 odczyty, 3 faktury oraz payment orders.
- E2E: 1857,9 kWh / 30 dni; 2158,46 zł brutto do zapłaty; NET-001/003/011 mają koszt i kWh na 1000 opakowań.
- Faktury: PASS 644,57 zł; WARNING 965,61 zł; FAIL 548,28 zł. PASS wyeksportowany do CSV i potwierdzony `BANK-DEMO-ENERGY-001` → SETTLED / PAID_RECONCILED.
- Manual reading id=95, 100 kWh vs baseline 31,23 kWh utworzył alert `CONSUMPTION_SPIKE` id=3 (3,2× baseline). Seed POST po ponownym uruchomieniu zwraca `already:true`.
- Browser E2E bez błędów JS. Znane ograniczenie: dane demo, brak realnego API dostawcy energii, KSeF i banku; integracje są następną warstwą po wyborze partnerów.

## PROMPT 22 — wszystkie pozostałe koszty i rozliczenia inwestycji (2026-08-14)

- Nowa zakładka master `Pozostałe koszty`: INTERNET, LEASING, INSURANCE, SERVICE, RENT, LOGISTICS, FUEL, SOFTWARE, ADMIN, OTHER.
- Migracja `0006_remaining_investment_costs`: `cost_contracts`, `cost_metrics`, `cost_invoices`, `cost_payment_orders`, `cost_alerts` z indeksami i unikalnościami.
- Umowa kosztowa przechowuje: dostawcę/NIP/rachunek, kategorię, punkt/urządzenie/kierowcę, numer i tytuł, model rozliczenia (`monthly_fixed|installment|per_unit|usage`), plan miesięczny, stawkę jednostkową, budżet, okres, termin, centrum kosztów i metadane kategorii.
- Metryka operacyjna: okres, nazwa, wartość, jednostka, źródło i jakość. Demo: data_usage GB, installment_no nr, claims count, service_hours h, area m2, distance km.
- Faktura kosztowa: umowa/kategoria/punkt, okres, ilość/jednostka, netto/VAT/brutto, termin, dokument i metadata. `validateCostInvoice`: stała/rata porównywana z planem; per_unit z ilość × stawka. PASS ≤3%, WARNING ≤10%, FAIL >10%; WARNING/FAIL tworzy `COST_VARIANCE` alert.
- Workflow płatności: APPROVED_FOR_PAYMENT / ON_HOLD → ręczne potwierdzenie z wyciągu → SETTLED / PAID_RECONCILED. FAIL blokuje akceptację, WARNING pozostaje ON_HOLD.
- Dashboard: aktywne umowy, kwota do zapłaty, przeterminowane, alerty, tabela plan vs wykonanie i odchylenie per kategoria.
- Formularze: Umowa, Metryka, Faktura; idempotentne endpointy `/api/admin/costs/*` i seed POST `/api/admin/dev/seed-costs`.
- Idempotentny seed: 6 umów i faktur (internet, leasing, ubezpieczenie, serwis, czynsz, logistyka) + 6 metryk i payment orders.
- E2E: 6 aktywnych umów, 4 961,82 zł brutto do zapłaty, 3 przeterminowane, 2 alerty. PASS: internet/insurance/rent/logistics; WARNING leasing +3,33%; FAIL service +12%. Faktura internetowa potwierdzona `COST-DEMO-BANK-001` → SETTLED / PAID_RECONCILED. Formularze i dashboard bez błędów JS/SQL.
