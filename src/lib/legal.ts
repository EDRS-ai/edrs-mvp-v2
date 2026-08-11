// PROMPT 13 — Warstwa zaufania: Regulamin + Polityka prywatności (RODO).
// Serwowane server-side pod /regulamin i /polityka-prywatnosci (publiczne,
// linkowane ze stopki landing i ekranu logowania). Treść = szkic ekspercki
// pod przegląd prawnika — oznaczony datą wersji, bez udawania porady prawnej.

const shell = (title: string, body: string) => `<!doctype html><html lang="pl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — edrs.io</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#111827;line-height:1.65}
  header{border-bottom:1px solid #f3f4f6;padding:16px 24px;display:flex;align-items:center;gap:10px}
  .logo{width:32px;height:32px;background:linear-gradient(135deg,#10b981,#047857);border-radius:10px}
  header b{font-size:17px} header a{margin-left:auto;color:#047857;text-decoration:none;font-size:14px;font-weight:600}
  main{max-width:760px;margin:0 auto;padding:48px 24px 80px}
  h1{font-size:28px;margin:0 0 4px} .ver{color:#6b7280;font-size:13px;margin-bottom:32px}
  h2{font-size:17px;margin:32px 0 8px;color:#065f46}
  p,li{font-size:14.5px;color:#374151} ul{padding-left:20px}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin:12px 0}
  th{text-align:left;border-bottom:2px solid #e5e7eb;padding:8px;color:#6b7280;font-size:12px;text-transform:uppercase}
  td{border-bottom:1px solid #f3f4f6;padding:8px;vertical-align:top}
  footer{border-top:1px solid #f3f4f6;padding:24px;text-align:center;color:#9ca3af;font-size:12px}
</style></head><body>
<header><div class="logo"></div><b>edrs.io</b><a href="/">← Wróć do strony głównej</a></header>
<main>${body}</main>
<footer>© 2026 edrs.io · Operatorem platformy jest NET4ZERO · kontakt: kontakt@edrs.io</footer>
</body></html>`;

export function renderRegulamin(): string {
  return shell("Regulamin", `
<h1>Regulamin platformy edrs.io</h1>
<div class="ver">Wersja 1.0 · obowiązuje od 11 sierpnia 2026 r. · dokument w fazie pilotażu — ostateczna wersja po przeglądzie prawnym</div>

<h2>§1. Definicje</h2>
<ul>
<li><b>Platforma</b> — system informatyczny edrs.io służący do ewidencji, telemetrii i rozliczeń sieci urządzeń zwrotnej zbiórki opakowań (RVM) działających poza jednostkami handlu, dostępny pod adresem wskazanym Operatorowi Sieci.</li>
<li><b>Usługodawca</b> — NET4ZERO, podmiot prowadzący i rozwijający Platformę (docelowo: spółka celowa edrs.io w organizacji).</li>
<li><b>Operator Sieci (Master)</b> — podmiot zarządzający siecią punktów zbiórki i procesem rozliczeń.</li>
<li><b>Inwestor</b> — podmiot będący stroną umowy dzierżawy lub zakupu urządzeń, posiadający dostęp do e-kartoteki: salda, wyciągu, sprawozdań, dokumentów i komunikacji.</li>
<li><b>Kierowca / Przewoźnik</b> — podmiot realizujący odbiory z punktów zbiórki, potwierdzający je w Platformie.</li>
<li><b>Ledger</b> — niezmienialny rejestr pozycji rozliczeniowych prowadzony w Platformie, z kryptograficznym łańcuchem integralności (SHA-256).</li>
<li><b>Cykl rozliczeniowy</b> — okres rozliczeniowy określony w umowie pomiędzy stronami (domyślnie 5-dniowy dla kaucji, miesięczny dla opłat stałych).</li>
</ul>

<h2>§2. Postanowienia ogólne</h2>
<ul>
<li>Regulamin określa zasady świadczenia usług drogą elektroniczną za pośrednictwem Platformy w rozumieniu ustawy z dnia 18 lipca 2002 r. o świadczeniu usług drogą elektroniczną.</li>
<li>Platforma jest narzędziem B2B. Dostęp mają wyłącznie użytkownicy zaproszeni przez Operatora Sieci na podstawie zawartych umów.</li>
<li>Korzystanie z Platformy wymaga zaakceptowania niniejszego Regulaminu oraz Polityki prywatności.</li>
</ul>

<h2>§3. Zakres usług</h2>
<ul>
<li>Ewidencja punktów zbiórki, urządzeń i organizacji wraz z historią zmian.</li>
<li>Telemetria urządzeń: poziomy zapełnienia, statusy, zdarzenia — prezentowane w czasie rzeczywistym.</li>
<li>Naliczenia okresowe wynikające wyłącznie z kart stawek (rate cards) przypisanych do umów — Platforma nie stosuje stawek zaszytych w oprogramowaniu.</li>
<li>Rozliczenia wielostronne: rejestr pozycji w Ledgerze, salda stron, kompensata (netting) opłat z przychodów kaucyjnych.</li>
<li>Sprawozdania miesięczne z możliwością akceptacji przez Inwestora.</li>
<li>Archiwum dokumentów oraz komunikacja pomiędzy Inwestorem a Operatorem Sieci.</li>
<li>Obsługa płatności dopłat — za pośrednictwem licencjonowanego dostawcy usług płatniczych (PolCard / Fiserv Polska); Usługodawca nie przechowuje danych kart płatniczych.</li>
</ul>

<h2>§4. Konta i bezpieczeństwo</h2>
<ul>
<li>Konta tworzone są wyłącznie na podstawie imiennych zaproszeń. Użytkownik zobowiązany jest do zachowania poufności danych logowania.</li>
<li>Sesja użytkownika wygasa po 12 godzinach bezczynności. Uwierzytelnienie realizowane jest wyłącznie przez bezpieczne pliki cookie (httpOnly, Secure, SameSite).</li>
<li>Użytkownik ma dostęp wyłącznie do danych własnej organizacji (separacja tenantów w warstwie zapytań).</li>
<li>Zabronione jest podejmowanie działań zakłócających pracę Platformy, prób nieautoryzowanego dostępu oraz udostępniania konta osobom trzecim.</li>
</ul>

<h2>§5. Rozliczenia i dane rozliczeniowe</h2>
<ul>
<li>Pozycje Ledgera są niezmienialne; korekta następuje wyłącznie przez pozycję odwracającą (storno), z zachowaniem pełnej historii.</li>
<li>Integralność Ledgera jest weryfikowana automatycznie (łańcuch SHA-256, cykliczna kontrola agentów systemowych).</li>
<li>Podstawą naliczeń są stawki z kart stawek obowiązujące w dacie zdarzenia. Zmiana stawki wymaga zmiany karty stawek i działa od daty jej obowiązywania.</li>
<li>Rozbieżności pomiędzy źródłami danych (urządzenie / sortownia / operator kaucyjny) podlegają procedurze rekoncyliacji i sporów opisanej w umowie z Operatorem Sieci.</li>
</ul>

<h2>§6. Odpowiedzialność</h2>
<ul>
<li>Usługodawca dokłada należytej staranności w celu zapewnienia ciągłości działania Platformy; planowane przerwy techniczne będą komunikowane z wyprzedzeniem.</li>
<li>Usługodawca nie ponosi odpowiedzialności za skutki podania nieprawdziwych danych przez użytkowników ani za dane źródłowe dostarczane przez podmioty trzecie (operator kaucyjny, sortownie, producenci urządzeń).</li>
<li>Odpowiedzialność Usługodawcy wobec Operatora Sieci regulowana jest umową główną; wobec pozostałych użytkowników ograniczona jest do przypadków winy umyślnej.</li>
</ul>

<h2>§7. Reklamacje</h2>
<ul>
<li>Reklamacje dotyczące działania Platformy należy zgłaszać na adres kontakt@edrs.io lub przez moduł Wiadomości.</li>
<li>Usługodawca rozpatruje reklamacje w terminie 14 dni od zgłoszenia.</li>
</ul>

<h2>§8. Postanowienia końcowe</h2>
<ul>
<li>Usługodawca może zmienić Regulamin z ważnych przyczyn (zmiana prawa, rozwój Platformy, bezpieczeństwo). O zmianach użytkownicy zostaną powiadomieni w Platformie z 14-dniowym wyprzedzeniem.</li>
<li>Prawem właściwym jest prawo polskie. Spory rozstrzyga sąd właściwy dla siedziby Usługodawcy, z zastrzeżeniem odmiennych postanowień umów głównych.</li>
<li>W sprawach nieuregulowanych stosuje się przepisy Kodeksu cywilnego, ustawy o świadczeniu usług drogą elektroniczną oraz RODO.</li>
</ul>`);
}

export function renderPolitykaPrywatnosci(): string {
  return shell("Polityka prywatności", `
<h1>Polityka prywatności edrs.io</h1>
<div class="ver">Wersja 1.0 · obowiązuje od 11 sierpnia 2026 r. · dokument w fazie pilotażu — ostateczna wersja po przeglądzie prawnym</div>

<h2>1. Administrator danych</h2>
<p>Administratorem danych osobowych przetwarzanych w Platformie edrs.io jest NET4ZERO (docelowo: spółka celowa edrs.io w organizacji). Kontakt w sprawach ochrony danych: kontakt@edrs.io.</p>

<h2>2. Zakres i cele przetwarzania</h2>
<table>
<thead><tr><th>Kategoria danych</th><th>Cel</th><th>Podstawa prawna (RODO)</th></tr></thead>
<tbody>
<tr><td>Dane konta (imię i nazwisko, e-mail, rola)</td><td>Uwierzytelnianie, prowadzenie konta, separacja uprawnień</td><td>art. 6 ust. 1 lit. b — wykonanie umowy</td></tr>
<tr><td>Dane rozliczeniowe (pozycje ledgera, salda, płatności)</td><td>Rozliczenia wielostronne, sprawozdawczość, dochodzenie roszczeń</td><td>art. 6 ust. 1 lit. b i f — umowa oraz prawnie uzasadniony interes</td></tr>
<tr><td>Dane telemetryczne urządzeń (zapełnienie, statusy, lokalizacja punktu)</td><td>Świadczenie usługi monitoringu i rozliczeń</td><td>art. 6 ust. 1 lit. b — wykonanie umowy (dane co do zasady nieosobowe)</td></tr>
<tr><td>Logi zdarzeń (event log: kto, co, kiedy)</td><td>Bezpieczeństwo, rozliczalność, audyt</td><td>art. 6 ust. 1 lit. f — prawnie uzasadniony interes</td></tr>
<tr><td>Treść wiadomości w module komunikacji</td><td>Obsługa relacji Inwestor–Operator</td><td>art. 6 ust. 1 lit. b — wykonanie umowy</td></tr>
<tr><td>Dane w dokumentach (umowy, protokoły)</td><td>Archiwizacja dokumentacji umownej</td><td>art. 6 ust. 1 lit. b i c — umowa oraz obowiązki prawne</td></tr>
</tbody>
</table>

<h2>3. Odbiorcy danych</h2>
<ul>
<li>Dostawcy infrastruktury chmurowej (hosting Platformy i bazy danych) — na podstawie umów powierzenia.</li>
<li>Dostawca usług płatniczych (PolCard / Fiserv Polska) — w zakresie realizacji płatności; dane kart nie przechodzą przez Platformę.</li>
<li>Operator systemu kaucyjnego, sortownie i przewoźnicy — wyłącznie w zakresie danych rozliczeniowych niezbędnych do rekoncyliacji.</li>
<li>Krajowy System e-Faktur (KSeF) — w zakresie danych fakturowych wymaganych prawem.</li>
</ul>

<h2>4. Okresy przechowywania</h2>
<ul>
<li>Dane rozliczeniowe i dokumenty księgowe — 5 lat od końca roku podatkowego (obowiązek prawny).</li>
<li>Dane konta — przez okres posiadania konta oraz do 3 lat po jego zamknięciu (przedawnienie roszczeń).</li>
<li>Logi zdarzeń — do 24 miesięcy.</li>
<li>Wiadomości i dokumenty — przez okres trwania umowy z Operatorem Sieci.</li>
</ul>

<h2>5. Prawa osób, których dane dotyczą</h2>
<p>Przysługuje Ci prawo dostępu do danych, ich sprostowania, usunięcia lub ograniczenia przetwarzania, prawo do przenoszenia danych, prawo sprzeciwu wobec przetwarzania opartego na prawnie uzasadnionym interesie oraz prawo wniesienia skargi do Prezesa UODO. Wnioski: kontakt@edrs.io.</p>

<h2>6. Bezpieczeństwo</h2>
<ul>
<li>Szyfrowanie transmisji (TLS) oraz uwierzytelnianie oparte wyłącznie na bezpiecznych cookies (httpOnly, Secure, SameSite).</li>
<li>Niezmienialny rejestr rozliczeń z kryptograficznym łańcuchem integralności (SHA-256) i automatyczną, cykliczną weryfikacją.</li>
<li>Separacja danych organizacji w warstwie zapytań (multi-tenant scoping) oraz zasada minimalnych uprawnień (RBAC).</li>
<li>Pełna rozliczalność operacji w rejestrze zdarzeń (kto, co, kiedy).</li>
</ul>

<h2>7. Pliki cookie</h2>
<p>Platforma używa wyłącznie niezbędnych plików cookie: sesyjnego cookie uwierzytelniającego. Nie stosujemy cookies marketingowych ani analitycznych podmiotów trzecich.</p>

<h2>8. Zmiany polityki</h2>
<p>O zmianach niniejszej Polityki użytkownicy zostaną powiadomieni w Platformie. Wersje archiwalne udostępniamy na żądanie.</p>`);
}
