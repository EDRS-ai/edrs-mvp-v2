// Sprint 2 PROMPT 0 — client module.
// Removed: SESSION_TOKEN global, withAuth() function (which appended ?token=...).
// All fetch calls now use `credentials: "include"` so the httpOnly cookie is sent.
// Body of login/signup responses no longer store token client-side.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";

const fmt = (grosze: number) =>
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(grosze / 100);
const fmtInt = (n: number) => new Intl.NumberFormat("pl-PL").format(n);
const fmtPct = (n: number) => `${n.toFixed(2)}%`;
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString("pl-PL");
const fmtDateTime = (ts: number) => new Date(ts).toLocaleString("pl-PL");
const fmtIso = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");

// PROMPT 0: No SESSION_TOKEN global. No withAuth function.
// Cookie sent automatically by browser via credentials: "include".
async function api(path: string, opts: any = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

type User = {
  id: number;
  email: string;
  name: string;
  role: "master" | "investor" | "driver";
  investorId: number | null;
  driverId: number | null;
};

const Icon = ({ d, className = "w-4 h-4" }: { d: string; className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={d} />
  </svg>
);

function NavShell({
  title, nav, activeView, setView, user, onLogout, children,
}: {
  title: string;
  nav: { id: string; label: string; icon: string }[];
  activeView: string;
  setView: (v: string) => void;
  user: User;
  onLogout: () => void;
  children: any;
  sidebarWidth?: string;
}) {
  // PROMPT 12: mobile drawer. PROMPT 14: szata graficzna eMieszkaniec (granatowy sidebar, pomaranczowy akcent).
  const [menuOpen, setMenuOpen] = useState(false);
  const pick = (id: string) => { setView(id); setMenuOpen(false); };
  return (
    <div className="min-h-screen bg-gray-100">
      {menuOpen && <div className="fixed inset-0 bg-black/40 z-20 lg:hidden" onClick={() => setMenuOpen(false)} />}
      <aside className={`fixed left-0 top-0 h-full w-64 bg-brand-navy z-30 flex flex-col transform transition-transform duration-200 lg:translate-x-0 ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="px-5 py-5 border-b border-white/10 flex items-center gap-2.5">
          <div className="w-9 h-9 bg-brand-blue rounded-md flex items-center justify-center">
            <Icon d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" className="w-5 h-5 text-white" />
          </div>
          <span className="font-heading font-bold text-xl text-white tracking-wide">edrs.io</span>
        </div>
        <nav className="py-3 flex-1 overflow-y-auto">
          {nav.map((item) => (
            <button key={item.id} onClick={() => pick(item.id)}
              className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm text-left border-l-4 ${
                activeView === item.id ? "border-brand-orange bg-white/10 text-white font-semibold" : "border-transparent text-blue-100/80 hover:bg-white/5 hover:text-white"
              }`}>
              <Icon d={item.icon} />{item.label}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-white/10 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center shrink-0">
              <span className="text-sm font-semibold text-white">
                {user.name.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-white truncate">{user.name}</div>
              <div className="text-xs text-blue-100/60 truncate">{user.email}</div>
            </div>
          </div>
          <button onClick={onLogout} className="p-2 text-blue-100/70 hover:bg-white/10 hover:text-white rounded-md shrink-0" title="Wyloguj">
            <Icon d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </button>
        </div>
      </aside>
      <header className="fixed top-0 left-0 lg:left-64 right-0 h-16 bg-white border-b-2 border-gray-200 z-10 flex items-center justify-between px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <button className="lg:hidden p-2 hover:bg-gray-100 rounded-md" onClick={() => setMenuOpen(true)} title="Menu">
            <Icon d="M4 6h16M4 12h16M4 18h16" className="w-5 h-5" />
          </button>
          <h2 className="font-heading text-xl font-bold text-brand-navy">{title}</h2>
          <span className="px-2 py-0.5 bg-brand-bluelight text-brand-bluedark text-xs rounded font-semibold uppercase tracking-wide">
            {user.role === "master" ? "Master" : user.role === "investor" ? "Inwestor" : "Kierowca"}
          </span>
        </div>
      </header>
      <main className="lg:ml-64 mt-16 p-4 lg:p-6 min-w-0">{children}</main>
    </div>
  );
}

function FillBar({ value }: { value: number }) {
  const color = value >= 80 ? "bg-red-500" : value >= 50 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="w-32 bg-gray-200 rounded-full h-2 overflow-hidden">
      <div className={`fill-bar ${color} h-full`} style={{ width: `${value}%` }} />
    </div>
  );
}

function Loading({ message = "Ładowanie..." }: { message?: string }) {
  return <div className="p-8 text-center text-gray-500">{message}</div>;
}

function ErrorBox({ message }: { message: string }) {
  return <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">Błąd: {message}</div>;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    open: { label: "Otwarty", cls: "bg-gray-100 text-gray-700" },
    reconciling: { label: "Rekonsyliacja", cls: "bg-yellow-100 text-yellow-700" },
    reconciled: { label: "Uzgodniony", cls: "bg-green-100 text-green-700" },
    disputed: { label: "Sporny", cls: "bg-red-100 text-red-700" },
    closed: { label: "Zamknięty", cls: "bg-blue-100 text-blue-700" },
  };
  const v = map[status] ?? { label: status, cls: "bg-gray-100 text-gray-700" };
  return <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${v.cls}`}>{v.label}</span>;
}

function LandingPage({ onLoginClick, inviteToken }: { onLoginClick: () => void; inviteToken: string | null }) {
  if (inviteToken) return <SignupScreen token={inviteToken} />;
  const logoIcon = "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15";
  const feats = [
    { t: "Ewidencja", h: "Ewidencja punktów i urządzeń", d: "rejestr lokalizacji, recyklomatów, organizacji i umów z pełną historią zmian. Zaimportuj lub wprowadź dane całej sieci i miej je zawsze pod ręką, w jednym miejscu.", i: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" },
    { t: "Rozliczenia", h: "Automatyczne naliczenia i rozliczenia", d: "opłaty miesięczne naliczane wyłącznie ze stawek umownych oraz wielostronne rozliczenie kierowca–inwestor–punkt. Niezmienialny dziennik księgowy z kryptograficznym łańcuchem zapisów.", i: "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" },
    { t: "Mapa live", h: "Mapa i telemetria w czasie rzeczywistym", d: "zapełnienie, statusy urządzeń i zdarzenia operacyjne na mapie Polski. Alerty przepełnienia i brakującego odbioru docierają do operatora, zanim zadzwoni punkt.", i: "M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" },
    { t: "e-Kartoteka", h: "e-Kartoteka inwestora", d: "saldo, wyciąg operacji i netting: opłaty potrącane z przychodów kaucyjnych. Dopłaty online przez licencjonowanego operatora płatności, księgowane automatycznie.", i: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
    { t: "Dokumenty", h: "Cyfrowe archiwum dokumentów", d: "umowy, protokoły i regulaminy online, udostępniane per inwestor lub globalnie. Wersje elektroniczne oraz skany dokumentów papierowych w jednym, uporządkowanym archiwum.", i: "M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { t: "Sprawozdania", h: "Sprawozdania z akceptacją online", d: "miesięczne rozliczenie generowane automatycznie z dziennika księgowego, do pobrania i akceptacji jednym kliknięciem, z rejestrowanym śladem audytowym.", i: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { t: "Komunikacja", h: "Komunikacja z inwestorami", d: "bezpośrednie wątki inwestor–operator z historią i licznikiem nieprzeczytanych wiadomości. Koniec z ustaleniami przez telefon, których nikt nie zapisał.", i: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" },
    { t: "Samokontrola", h: "Wewnętrzni agenci systemu", d: "co godzinę automatycznie weryfikują spójność danych, łańcuch księgowy, terminy sporów i naliczenia. System sam pilnuje, żeby wszystko działało sprawnie.", i: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
  ];
  const benefits = [
    { b: "dostęp online 24/7", r: "system dostępny w chmurze przez szyfrowane połączenie w przeglądarce, bez instalacji oprogramowania." },
    { b: "audytowalny dziennik księgowy", r: "każdy zapis rozliczeniowy jest niezmienialny i spięty kryptograficznym łańcuchem — historia nie do podrobienia." },
    { b: "role i uprawnienia (RBAC)", r: "operator, inwestor i kierowca widzą wyłącznie swoje dane. Każdy inwestor ma odseparowaną kartotekę." },
    { b: "automatyzacja", r: "naliczenia, sprawozdania i kontrola jakości danych wykonują się same — wewnętrzni agenci pracują co godzinę." },
    { b: "integracje", r: "KSeF (faktury ustrukturyzowane), licencjonowany operator płatności, import CSV z urządzeń i tras." },
  ];
  return (
    <div className="min-h-screen bg-white text-gray-800">
      <header className="border-b-2 border-gray-100 bg-white sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-brand-blue rounded-md flex items-center justify-center">
              <Icon d={logoIcon} className="w-5 h-5 text-white" />
            </div>
            <span className="font-heading font-bold text-2xl text-brand-navy">edrs.io</span>
          </div>
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-gray-600">
            <a href="#rozwiazanie" className="hover:text-brand-blue">Możliwości</a>
            <a href="#korzysci" className="hover:text-brand-blue">Co zyskujesz</a>
            <a href="#pricing" className="hover:text-brand-blue">Cennik</a>
            <a href="/regulamin" className="hover:text-brand-blue">Regulamin</a>
          </nav>
          <div className="flex items-center gap-3">
            <button onClick={onLoginClick} className="text-sm text-gray-600 hover:text-brand-blue font-medium">Zaloguj się</button>
            <button onClick={onLoginClick} className="px-4 py-2 bg-brand-orange text-white text-sm rounded font-bold hover:bg-brand-orangedark">Przetestuj już dziś!</button>
          </div>
        </div>
      </header>

      <section className="bg-white">
        <div className="max-w-7xl mx-auto px-6 pt-10 pb-4 text-center">
          <h1 className="font-heading text-3xl lg:text-4xl font-bold text-brand-navy leading-tight max-w-4xl mx-auto">
            Poznaj edrs.io — kompleksowy system do zarządzania i rozliczeń sieci kaucyjnej poza handlem
          </h1>
          <p className="text-gray-600 mt-4 max-w-3xl mx-auto">
            Telemetria recyklomatów, wielostronne rozliczenia i e-kartoteka inwestora w jednej audytowalnej pętli.
            Bez szacunków, bez telefonów, bez arkuszy.
          </p>
        </div>
        <div className="max-w-7xl mx-auto px-6 py-10 grid lg:grid-cols-2 gap-8">
          <div className="rounded-3xl border-4 border-brand-blue p-8 flex flex-col">
            <div className="font-heading text-2xl font-bold text-gray-400 text-center mb-6">Platforma operatora sieci RVM</div>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">Stan sieci - LIVE</div>
                <div className="flex items-center gap-1.5 text-xs text-brand-blue font-semibold"><span className="live-dot" />online</div>
              </div>
              <div className="space-y-2">
                {[
                  { id: "NET-003 Ursynów", fill: 94, color: "bg-red-500" },
                  { id: "NET-007 Ursus", fill: 91, color: "bg-red-500" },
                  { id: "NET-005 Wola", fill: 78, color: "bg-yellow-500" },
                  { id: "NET-002 Mokotów", fill: 62, color: "bg-yellow-500" },
                  { id: "NET-008 Bemowo", fill: 56, color: "bg-brand-blue" },
                  { id: "NET-006 Praga", fill: 23, color: "bg-brand-blue" },
                ].map((pt) => (
                  <div key={pt.id} className="flex items-center gap-3 text-xs">
                    <div className="w-32 text-gray-600 font-mono truncate">{pt.id}</div>
                    <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                      <div className={`${pt.color} h-full`} style={{ width: `${pt.fill}%` }} />
                    </div>
                    <div className="w-10 text-right font-mono tabular-nums">{pt.fill}%</div>
                  </div>
                ))}
              </div>
              <p className="text-sm text-gray-600 mt-5 leading-relaxed">
                Ewidencja punktów, mapa live, cykle rozliczeniowe, import CSV, spory i katalog opakowań —
                wszystko w jednym panelu, z pełną historią zdarzeń.
              </p>
            </div>
            <button onClick={onLoginClick} className="font-heading text-xl font-bold text-brand-blue hover:text-brand-bluedark mt-6 text-center w-full">Przetestuj już dziś!</button>
          </div>
          <div className="rounded-3xl border-4 border-brand-orange p-8 flex flex-col">
            <div className="font-heading text-2xl font-bold text-gray-400 text-center mb-6">Panel inwestora online</div>
            <div className="flex-1">
              <ul className="space-y-3 text-sm text-gray-600">
                {[
                  ["Pulpit i mapa live", "wyłącznie własne punkty i zdarzenia inwestora"],
                  ["e-Kartoteka", "saldo, wyciąg operacji, naliczenia i netting z kaucji"],
                  ["Platnosci online", "dopłata salda przez operatora płatności, księgowana automatycznie"],
                  ["Sprawozdania", "miesięczne rozliczenie z akceptacją jednym kliknięciem"],
                  ["Dokumenty i komunikacja", "archiwum umów oraz bezpośredni wątek z operatorem"],
                ].map(([b, r]) => (
                  <li key={b} className="flex gap-2.5">
                    <Icon d="M5 13l4 4L19 7" className="w-4 h-4 text-brand-orange shrink-0 mt-0.5" />
                    <span><b className="text-gray-800">{b}</b> — {r}</span>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-gray-600 mt-5 leading-relaxed">
                Każdy inwestor loguje się do własnej, odseparowanej kartoteki — jak mieszkaniec do panelu wspólnoty.
              </p>
            </div>
            <button onClick={onLoginClick} className="font-heading text-xl font-bold text-brand-orange hover:text-brand-orangedark mt-6 text-center w-full">Zobacz demo panelu</button>
          </div>
        </div>
      </section>

      <section id="rozwiazanie" className="py-16 bg-white">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="font-heading text-3xl font-bold text-brand-navy text-center mb-12 max-w-3xl mx-auto">
            Poznaj możliwości Twojego nowego systemu
          </h2>
          <div className="grid md:grid-cols-2 gap-x-12 gap-y-10">
            {feats.map((m, idx) => {
              const c = idx % 2 === 0 ? "blue" : "orange";
              const border = c === "blue" ? "border-brand-blue" : "border-brand-orange";
              const text = c === "blue" ? "text-brand-blue" : "text-brand-orange";
              return (
                <div key={m.t} className="flex gap-5">
                  <div className="shrink-0 w-20">
                    <div className={`w-16 h-16 border-2 ${border} rounded-2xl flex items-center justify-center bg-white`}>
                      <Icon d={m.i} className={`w-8 h-8 ${text}`} />
                    </div>
                    <div className={`text-[11px] font-bold ${text} text-center mt-1.5 leading-tight`}>{m.t}</div>
                  </div>
                  <p className="text-sm text-gray-600 leading-relaxed text-justify">
                    <b className="text-gray-900">{m.h}</b> — {m.d}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-10 bg-white">
        <div className="max-w-6xl mx-auto px-6">
          <div className="rounded-3xl border-4 border-brand-orange p-8 lg:p-10">
            <h3 className="font-heading text-2xl font-bold text-brand-navy mb-3">Połącz swoją sieć kaucyjną z KSeF!</h3>
            <p className="text-sm text-gray-600 leading-relaxed max-w-4xl">
              Od 2026 roku faktury ustrukturyzowane stają się obowiązkowe dla kolejnych grup podatników.
              edrs.io wystawia faktury rozliczeniowe automatycznie na podstawie dziennika księgowego
              i przygotowuje je w formacie gotowym do wysyłki do Krajowego Systemu e-Faktur.
            </p>
            <div className="font-heading text-xl font-bold text-brand-orange text-center mt-6">Faktury KSeF w cenie platformy — bez dodatkowych modułów</div>
          </div>
        </div>
      </section>

      <section id="korzysci" className="py-16 bg-white">
        <div className="max-w-6xl mx-auto px-6 grid lg:grid-cols-2 gap-12 items-start">
          <div>
            <h2 className="font-heading text-2xl font-bold text-brand-navy mb-6">Sprawdź, co zyskujesz korzystając z naszej platformy!</h2>
            <ul className="space-y-4 text-sm text-gray-600">
              {benefits.map((x) => (
                <li key={x.b} className="flex gap-2.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-blue shrink-0 mt-1.5" />
                  <span className="text-justify leading-relaxed"><b className="text-gray-900">{x.b}</b> — {x.r}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="text-center pt-4">
            <div className="font-heading text-xl font-bold text-brand-orange mb-8">Z pilotażu platformy korzysta już</div>
            <div className="grid grid-cols-3 gap-6">
              <div><div className="font-heading text-5xl lg:text-6xl font-bold text-brand-orange">10</div><div className="font-heading font-bold text-brand-orange mt-1">punktów<br/>pilotażu</div></div>
              <div><div className="font-heading text-5xl lg:text-6xl font-bold text-brand-orange">5</div><div className="font-heading font-bold text-brand-orange mt-1">kierowców<br/>w sieci</div></div>
              <div><div className="font-heading text-5xl lg:text-6xl font-bold text-brand-orange">36 tys.</div><div className="font-heading font-bold text-brand-orange mt-1">zł ARR<br/>pilotażu</div></div>
            </div>
            <div className="text-xs text-gray-400 mt-6">Dane z pilotażu referencyjnego operatora sieci RVM (Warszawa).</div>
          </div>
        </div>
      </section>

      <section id="pricing" className="py-16 bg-gray-50 border-t border-gray-100">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="font-heading text-3xl font-bold text-brand-navy text-center mb-3">Prosty cennik. Płacisz za wartość.</h2>
          <p className="text-gray-600 text-center mb-10">Stały abonament za punkt + 0,5% od wolumenu kaucji. KSeF i sprawozdania w cenie.</p>
          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            <div className="bg-white p-8 rounded-2xl border-2 border-gray-200">
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Abonament platformy</div>
              <div className="mt-3 flex items-baseline gap-1"><div className="font-heading text-4xl font-bold text-brand-navy">149 zł</div><div className="text-sm text-gray-500">/ punkt / mc</div></div>
              <div className="text-sm text-gray-500 mt-1">netto · stała opłata</div>
            </div>
            <div className="bg-white p-8 rounded-2xl border-4 border-brand-blue relative">
              <div className="absolute top-4 right-4 px-2 py-1 bg-brand-blue text-white text-xs rounded font-bold">skaluje się</div>
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Settlement fee</div>
              <div className="mt-3 flex items-baseline gap-1"><div className="font-heading text-4xl font-bold text-brand-navy">0,5%</div><div className="text-sm text-gray-500">wolumenu kaucji</div></div>
              <div className="text-sm text-gray-500 mt-1">netto · tylko od sukcesu</div>
            </div>
            <div className="bg-white p-8 rounded-2xl border-2 border-brand-orange">
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Bank Data Room</div>
              <div className="mt-3 flex items-baseline gap-1"><div className="font-heading text-4xl font-bold text-brand-navy">0 zł</div><div className="text-sm text-gray-500">dodatkowo</div></div>
              <div className="text-sm text-gray-500 mt-1">w cenie platformy</div>
            </div>
          </div>
        </div>
      </section>

      <footer className="bg-white border-t-2 border-gray-100">
        <div className="max-w-7xl mx-auto px-6 py-12 grid sm:grid-cols-2 lg:grid-cols-4 gap-10 text-sm text-gray-500">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-brand-blue rounded-md flex items-center justify-center">
                <Icon d={logoIcon} className="w-5 h-5 text-white" />
              </div>
              <span className="font-heading font-bold text-xl text-brand-navy">edrs.io</span>
            </div>
            <p className="leading-relaxed">System operacyjny sieci kaucyjnej poza handlem. Telemetria, rozliczenia wielostronne i e-kartoteka inwestora w jednej audytowalnej pętli.</p>
          </div>
          <div>
            <div className="font-heading text-brand-navy font-bold mb-4 uppercase tracking-wider text-xs">Produkt</div>
            <ul className="space-y-2">
              <li><a href="#rozwiazanie" className="hover:text-brand-blue">Możliwości systemu</a></li>
              <li><a href="#korzysci" className="hover:text-brand-blue">Co zyskujesz</a></li>
              <li><a href="#pricing" className="hover:text-brand-blue">Cennik</a></li>
            </ul>
          </div>
          <div>
            <div className="font-heading text-brand-navy font-bold mb-4 uppercase tracking-wider text-xs">Dokumenty</div>
            <ul className="space-y-2">
              <li><a href="/regulamin" className="hover:text-brand-blue">Regulamin platformy</a></li>
              <li><a href="/polityka-prywatnosci" className="hover:text-brand-blue">Polityka prywatności (RODO)</a></li>
            </ul>
          </div>
          <div>
            <div className="font-heading text-brand-navy font-bold mb-4 uppercase tracking-wider text-xs">Kontakt</div>
            <ul className="space-y-2">
              <li>kontakt@edrs.io</li>
              <li>Warszawa, Polska</li>
              <li className="pt-2 text-xs text-gray-400">Operatorem platformy jest NET4ZERO. Płatności obsługuje licencjonowany dostawca usług płatniczych.</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-100">
          <div className="max-w-7xl mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-400">
            <span>© 2026 edrs.io · NET4ZERO · Wszystkie prawa zastrzeżone</span>
            <span className="flex gap-4">
              <a href="/regulamin" className="hover:text-brand-blue">Regulamin</a>
              <a href="/polityka-prywatnosci" className="hover:text-brand-blue">Polityka prywatności</a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: (u: User) => void }) {
  const [email, setEmail] = useState("maciej@net4zero.pl");
  const [password, setPassword] = useState("edrs2026");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: any) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const data = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      // PROMPT 0: token not stored client-side. Cookie is the only auth channel.
      onSuccess(data.user);
    } catch (err: any) { setError(err.message ?? "Błąd logowania"); }
    finally { setBusy(false); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <form onSubmit={submit} className="bg-white p-8 rounded-lg shadow-lg w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
            <Icon d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" className="w-8 h-8 text-brand-blue" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">edrs.io</h1>
          <p className="text-sm text-gray-500 mt-1">System operacyjny sieci kaucyjnej poza handlem</p>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} required className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Hasło</label>
            <input type="password" value={password} onChange={(e) => setPassword((e.target as HTMLInputElement).value)} required className="w-full px-3 py-2 border border-gray-300 rounded-md" />
          </div>
          {error && <div className="text-sm text-red-700 bg-red-50 p-2 rounded">{error}</div>}
          <button type="submit" disabled={busy} className="w-full bg-brand-blue text-white py-2.5 rounded-md font-medium hover:bg-brand-bluedark disabled:opacity-50">{busy ? "Logowanie..." : "Zaloguj się"}</button>
          <div className="text-xs text-gray-500 border-t border-gray-200 pt-3">
            <div className="font-medium mb-1">Konta demo (hasło: edrs2026):</div>
            <div>maciej@net4zero.pl — master</div>
            <div>inwestor.a@net4zero.pl — inwestor</div>
            <div>inwestor.b@net4zero.pl — inwestor</div>
            <div>kierowca@net4zero.pl — kierowca</div>
          </div>
          <div className="text-xs text-gray-400 text-center pt-1">
            Logując się akceptujesz <a href="/regulamin" className="text-brand-blue hover:underline">Regulamin</a> i <a href="/polityka-prywatnosci" className="text-brand-blue hover:underline">Politykę prywatności</a>.
          </div>
        </div>
      </form>
    </div>
  );
}

function SignupScreen({ token }: { token: string }) {
  const [invite, setInvite] = useState<any>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    api(`/api/invites/${token}`).then((data) => { setInvite(data); if (data.label) setName(data.label); }).catch((err) => setError(err.message));
  }, [token]);
  const submit = async (e: any) => {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      await api("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, email, name, password }) });
      setDone(true);
      setTimeout(() => { window.location.href = "/"; }, 1500);
    } catch (err: any) { setError(err.message ?? "Błąd rejestracji"); }
    finally { setBusy(false); }
  };
  if (done) return <div className="min-h-screen flex items-center justify-center bg-green-50"><div className="bg-white p-8 rounded-lg shadow-lg text-center"><Icon d="M5 13l4 4L19 7" className="w-12 h-12 text-green-600 mx-auto mb-4" /><h2 className="text-2xl font-bold text-gray-900">Konto utworzone</h2><p className="text-gray-600 mt-2">Przekierowuję do panelu...</p></div></div>;
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <form onSubmit={submit} className="bg-white p-8 rounded-lg shadow-lg w-full max-w-md">
        <div className="text-center mb-8"><h1 className="text-2xl font-bold text-gray-900">Rejestracja</h1>{invite && <p className="text-sm text-gray-500 mt-1">Zaproszenie dla: <span className="font-medium text-gray-700">{invite.label}</span></p>}</div>
        {invite && <div className="space-y-4">
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Email</label><input type="email" value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} required className="w-full px-3 py-2 border border-gray-300 rounded-md" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Imię i nazwisko</label><input type="text" value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} required className="w-full px-3 py-2 border border-gray-300 rounded-md" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Hasło (min 6 znaków)</label><input type="password" value={password} onChange={(e) => setPassword((e.target as HTMLInputElement).value)} required minLength={6} className="w-full px-3 py-2 border border-gray-300 rounded-md" /></div>
          {error && <div className="text-sm text-red-700 bg-red-50 p-2 rounded">{error}</div>}
          <button type="submit" disabled={busy} className="w-full bg-brand-blue text-white py-2.5 rounded-md font-medium hover:bg-brand-bluedark disabled:opacity-50">{busy ? "Tworzenie konta..." : "Utwórz konto"}</button>
        </div>}
      </form>
    </div>
  );
}

function MasterApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState("dashboard");
  const [overview, setOverview] = useState<any>(null);
  const [cycles, setCycles] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nav = [
    { id: "dashboard", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
    { id: "mapa", label: "Mapa live", icon: "M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" },
    { id: "punkty", label: "Punkty", icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z" },
    { id: "cycles", label: "Rozliczenia", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
    { id: "stawki", label: "Stawki", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
    { id: "disputes", label: "Spory", icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" },
    { id: "import", label: "Import CSV", icon: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" },
    { id: "catalog", label: "Katalog EAN", icon: "M5 5v14M9 5v14M11 5v14M14 5v14M18 5v14" },
    { id: "events", label: "Event log", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { id: "agents", label: "Agenci", icon: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
    { id: "wiadomosci", label: "Wiadomości", icon: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" },
    { id: "dokumenty", label: "Dokumenty", icon: "M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { id: "sprawozdania", label: "Sprawozdania", icon: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
  ];
  const reload = useCallback(async () => {
    try {
      setError(null);
      const [o, cy] = await Promise.all([api("/api/admin/overview"), api("/api/admin/cycles")]);
      setOverview(o); setCycles(cy.cycles);
    } catch (err: any) { setError(err.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return (
    <NavShell title={nav.find((n) => n.id === view)?.label ?? ""} nav={nav} activeView={view} setView={setView} user={user} onLogout={onLogout}>
      {error && <ErrorBox message={error} />}
      {view === "dashboard" && <MasterDashboard overview={overview} />}
      {view === "mapa" && <MasterMapaLive user={user} />}
      {view === "punkty" && <MasterPunkty />}
      {view === "cycles" && <MasterCycles cycles={cycles} onReload={reload} />}
      {view === "stawki" && <MasterStawki />}
      {view === "disputes" && <MasterDisputes />}
      {view === "import" && <MasterCsvImport cycles={cycles} onReload={reload} />}
      {view === "catalog" && <MasterCatalog />}
      {view === "events" && <MasterEvents />}
      {view === "agents" && <MasterAgents />}
      {view === "wiadomosci" && <MasterWiadomosci />}
      {view === "dokumenty" && <MasterDokumenty />}
      {view === "sprawozdania" && <MasterSprawozdania />}
    </NavShell>
  );
}

function MasterDashboard({ overview }: { overview: any }) {
  if (!overview) return <Loading />;
  return (
    <div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard label="Abonament platformy" value={fmt(overview.platformFeeGrosze)} sub={`${overview.pointsCount} pkt × 149 zł`} />
        <KpiCard label="Settlement fee" value={fmt(overview.settlementFeeGrosze)} sub="0,5% wolumenu" />
        <KpiCard label="Opakowania (mc)" value={fmtInt(overview.packagesMonth)} sub={`${overview.collectionsMonth} odbiory`} />
        <KpiCard label="ARR (szacunek)" value={fmt(overview.arrEstimateGrosze)} sub={`${fmt(overview.monthlyRecurringGrosze)} / mc`} />
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h3 className="font-semibold mb-2">Aktywne podmioty</h3>
        <div className="text-sm text-gray-600">{overview.investorsCount} inwestorów · {overview.driversCount} kierowców · {overview.pointsCount} punktów</div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: any; sub?: string }) {
  return (
    <div className="bg-white p-5 rounded-md border border-gray-200 border-t-4 border-t-brand-blue shadow-sm">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="font-heading text-3xl font-bold text-brand-navy mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-2">{sub}</div>}
    </div>
  );
}

// PROMPT 15: ewidencja punktow (formularz z geokodowaniem + mini-mapa) i edytor stawek.
function MasterPunkty() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [showForm, setShowForm] = useState(false);
  const load = useCallback(() => { api("/api/admin/locations").then(setData).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-4 fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="font-heading text-lg font-bold text-brand-navy">Ewidencja punkt\u00f3w</h3>
          <p className="text-xs text-gray-500">{data.locations.length} punkt\u00f3w rzeczywistych \u00b7 {fmtInt(data.synCount)} syntetycznych (demo) ukrytych na li\u015bcie</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="px-4 py-2 bg-brand-blue text-white text-sm rounded font-semibold hover:bg-brand-bluedark">{showForm ? "Zamknij formularz" : "+ Dodaj punkt"}</button>
      </div>
      {showForm && <LocationForm nextId={data.nextId} orgs={data.orgs} onSaved={() => { setShowForm(false); load(); }} />}
      <div className="bg-white rounded-md border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
            <th className="px-4 py-2.5">ID</th><th className="px-4 py-2.5">Adres</th><th className="px-4 py-2.5">Dzielnica</th><th className="px-4 py-2.5">Inwestor</th><th className="px-4 py-2.5 text-right">Czynsz/mc</th><th className="px-4 py-2.5">Zape\u0142nienie</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5"></th>
          </tr></thead>
          <tbody>
            {data.locations.map((l: any) => (
              <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2.5 font-mono text-xs">{l.id}</td>
                <td className="px-4 py-2.5">{l.address}</td>
                <td className="px-4 py-2.5 text-gray-500">{l.district ?? "\u2014"}</td>
                <td className="px-4 py-2.5">{l.investor_name ?? <span className="text-gray-400">nieprzypisany</span>}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{l.monthly_rent_grosze ? fmt(l.monthly_rent_grosze) : "\u2014"}</td>
                <td className="px-4 py-2.5"><FillBar value={l.fill_level} /></td>
                <td className="px-4 py-2.5"><span className={`px-2 py-0.5 text-xs rounded font-medium ${l.status === "online" ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"}`}>{l.status}</span></td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={async () => { if (!window.confirm(`Dezaktywowa\u0107 punkt ${l.id}? Zniknie z mapy i naliczen od nast\u0119pnego okresu.`)) return; try { await api(`/api/admin/locations/${l.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deactivate: true }) }); load(); } catch (e: any) { window.alert(e.message); } }} className="text-xs text-red-600 hover:underline">dezaktywuj</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LocationForm({ nextId, orgs, onSaved }: { nextId: string; orgs: any[]; onSaved: () => void }) {
  const [id, setId] = useState(nextId);
  const [address, setAddress] = useState("");
  const [district, setDistrict] = useState("");
  const [investorOrgId, setInvestorOrgId] = useState("");
  const [rent, setRent] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [geoBusy, setGeoBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const divRef = useRef<any>(null);
  useEffect(() => {
    const L = (window as any).L;
    if (!divRef.current || mapRef.current || !L) return;
    const m = L.map(divRef.current).setView([52.2297, 21.0122], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "\u00a9 OpenStreetMap" }).addTo(m);
    m.on("click", (e: any) => { setLat(e.latlng.lat); setLng(e.latlng.lng); });
    mapRef.current = m;
    setTimeout(() => m.invalidateSize(), 100);
    return () => { m.remove(); mapRef.current = null; markerRef.current = null; };
  }, []);
  useEffect(() => {
    const L = (window as any).L;
    if (!mapRef.current || lat == null || lng == null || !L) return;
    if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
    else {
      markerRef.current = L.marker([lat, lng], { draggable: true }).addTo(mapRef.current);
      markerRef.current.on("dragend", () => { const p = markerRef.current.getLatLng(); setLat(p.lat); setLng(p.lng); });
    }
    mapRef.current.setView([lat, lng], Math.max(mapRef.current.getZoom(), 14));
  }, [lat, lng]);
  const geocode = async () => {
    if (address.trim().length < 5) { setMsg("Wpisz najpierw adres (ulica, numer, miasto)."); return; }
    setGeoBusy(true); setMsg("");
    try {
      const q = encodeURIComponent(address + ", Polska");
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=pl&limit=1&q=${q}`, { headers: { Accept: "application/json" } });
      const js = await res.json();
      if (!js.length) setMsg("Nie znaleziono adresu \u2014 ustaw pinezk\u0119 klikaj\u0105c na mapie.");
      else { setLat(Number(js[0].lat)); setLng(Number(js[0].lon)); setMsg("Znaleziono: " + js[0].display_name); }
    } catch { setMsg("Geokodowanie chwilowo niedost\u0119pne \u2014 ustaw pinezk\u0119 klikaj\u0105c na mapie."); }
    setGeoBusy(false);
  };
  const submit = async (force: boolean) => {
    setBusy(true); setMsg("");
    try {
      await api("/api/admin/locations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, address, district: district || null, investorOrgId: investorOrgId || null, monthlyRentGrosze: rent ? Math.round(parseFloat(rent.replace(",", ".")) * 100) : null, lat, lng, force }) });
      onSaved();
    } catch (e: any) {
      const m = String(e.message);
      if (m.startsWith("BLISKO:")) {
        if (window.confirm(m + " Doda\u0107 mimo to?")) { await submit(true); return; }
      } else setMsg(m);
    }
    setBusy(false);
  };
  const inp = "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40";
  return (
    <div className="bg-white rounded-md border border-gray-200 border-t-4 border-t-brand-blue p-5 fade-in">
      <h4 className="font-heading font-bold text-brand-navy mb-4">Nowy punkt zbi\u00f3rki</h4>
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-semibold text-gray-500 uppercase">Identyfikator</label><input className={inp} value={id} onChange={(e) => setId(e.target.value.toUpperCase())} /></div>
            <div><label className="text-xs font-semibold text-gray-500 uppercase">Dzielnica / gmina</label><input className={inp} value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="np. Mokot\u00f3w" /></div>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase">Adres</label>
            <div className="flex gap-2">
              <input className={inp} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="ul. Pu\u0142awska 12, Warszawa" />
              <button onClick={geocode} disabled={geoBusy} className="px-3 py-2 bg-brand-blue text-white text-sm rounded font-medium hover:bg-brand-bluedark disabled:opacity-50 shrink-0">{geoBusy ? "Szukam..." : "Znajd\u017a na mapie"}</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase">Inwestor</label>
              <select className={inp} value={investorOrgId} onChange={(e) => setInvestorOrgId(e.target.value)}>
                <option value="">\u2014 nieprzypisany \u2014</option>
                {orgs.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div><label className="text-xs font-semibold text-gray-500 uppercase">Czynsz najmu (z\u0142/mc)</label><input className={inp} value={rent} onChange={(e) => setRent(e.target.value)} placeholder="np. 500" /></div>
          </div>
          <div className="text-xs text-gray-500">
            Wsp\u00f3\u0142rz\u0119dne: {lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "brak \u2014 u\u017cyj \u201eZnajd\u017a na mapie\u201d lub kliknij na map\u0119"}
          </div>
          {msg && <div className="text-xs bg-brand-bluelight text-brand-bluedark rounded p-2.5">{msg}</div>}
          <button onClick={() => submit(false)} disabled={busy} className="px-5 py-2.5 bg-brand-blue text-white rounded text-sm font-semibold hover:bg-brand-bluedark disabled:opacity-50">{busy ? "Zapisywanie..." : "Zapisz punkt"}</button>
        </div>
        <div>
          <div ref={divRef} className="h-72 rounded border border-gray-200 z-0" />
          <div className="text-[11px] text-gray-400 mt-1">Kliknij na map\u0119 lub przeci\u0105gnij pinezk\u0119, by skorygowa\u0107 po\u0142o\u017cenie.</div>
        </div>
      </div>
    </div>
  );
}

function MasterStawki() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState<any>({ contractId: "", fraction: "SERVICE", rateValue: "", validFrom: new Date().toISOString().slice(0, 10), description: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { api("/api/admin/rate-cards").then(setData).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <ErrorBox message={err} />;
  if (!data) return <Loading />;
  const FR: any = { LEASE: "Rata leasingu", SERVICE: "Serwis", ELECTRICITY: "Energia (pr\u0105d)", PET: "PET", ALU: "ALU", GLASS: "Szk\u0142o" };
  const submit = async () => {
    if (!form.contractId || !form.rateValue) { setMsg("Wybierz kontrakt i podaj stawk\u0119."); return; }
    setBusy(true); setMsg("");
    try {
      await api("/api/admin/rate-cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contractId: Number(form.contractId), fraction: form.fraction, collectionModel: "monthly_fixed", packagingType: "n/a", rateValue: parseFloat(String(form.rateValue).replace(",", ".")), rateUnit: "PLN_PER_POINT_MONTH", validFrom: form.validFrom, description: form.description || null }) });
      setMsg("Zapisano now\u0105 wersj\u0119 stawki. Poprzednia zosta\u0142a zamkni\u0119ta \u2014 naliczenia historyczne pozostaj\u0105 bez zmian.");
      setForm({ ...form, rateValue: "", description: "" });
      load();
    } catch (e: any) { setMsg("B\u0142\u0105d: " + e.message); }
    setBusy(false);
  };
  const inp = "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/40";
  return (
    <div className="space-y-4 fade-in">
      <div>
        <h3 className="font-heading text-lg font-bold text-brand-navy">Stawki umowne (rate cards)</h3>
        <p className="text-xs text-gray-500">Zero stawek w kodzie \u2014 ka\u017cda op\u0142ata (leasing, serwis, energia) to wiersz tutaj. Zmiana stawki tworzy now\u0105 wersj\u0119; przeliczenia bior\u0105 stawk\u0119 z daty zdarzenia.</p>
      </div>
      <div className="bg-white rounded-md border border-gray-200 border-t-4 border-t-brand-blue p-5">
        <h4 className="font-heading font-bold text-brand-navy mb-3">Nowa wersja stawki</h4>
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="lg:col-span-2"><label className="text-xs font-semibold text-gray-500 uppercase">Kontrakt</label>
            <select className={inp} value={form.contractId} onChange={(e) => setForm({ ...form, contractId: e.target.value })}>
              <option value="">\u2014 wybierz \u2014</option>
              {data.contracts.map((ct: any) => <option key={ct.id} value={ct.id}>#{ct.id} {ct.type} \u00b7 {ct.party_a} \u2192 {ct.party_b}</option>)}
            </select>
          </div>
          <div><label className="text-xs font-semibold text-gray-500 uppercase">Rodzaj op\u0142aty</label>
            <select className={inp} value={form.fraction} onChange={(e) => setForm({ ...form, fraction: e.target.value })}>
              {Object.keys(FR).map((k) => <option key={k} value={k}>{FR[k]}</option>)}
            </select>
          </div>
          <div><label className="text-xs font-semibold text-gray-500 uppercase">Stawka (z\u0142/pkt/mc)</label><input className={inp} value={form.rateValue} onChange={(e) => setForm({ ...form, rateValue: e.target.value })} placeholder="np. 45" /></div>
          <div><label className="text-xs font-semibold text-gray-500 uppercase">Obowi\u0105zuje od</label><input type="date" className={inp} value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <input className={inp + " max-w-md"} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Opis (opcjonalnie), np. podwy\u017cka taryfy energii od IX 2026" />
          <button onClick={submit} disabled={busy} className="px-5 py-2.5 bg-brand-blue text-white rounded text-sm font-semibold hover:bg-brand-bluedark disabled:opacity-50 shrink-0">{busy ? "Zapisywanie..." : "Zapisz stawk\u0119"}</button>
        </div>
        {msg && <div className="mt-3 text-xs bg-brand-bluelight text-brand-bluedark rounded p-2.5">{msg}</div>}
      </div>
      <div className="bg-white rounded-md border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
            <th className="px-4 py-2.5">Kontrakt</th><th className="px-4 py-2.5">Rodzaj</th><th className="px-4 py-2.5 text-right">Stawka</th><th className="px-4 py-2.5">Jednostka</th><th className="px-4 py-2.5">Od</th><th className="px-4 py-2.5">Do</th><th className="px-4 py-2.5">Opis</th>
          </tr></thead>
          <tbody>
            {data.rateCards.map((r: any) => (
              <tr key={r.id} className={`border-b border-gray-100 ${r.valid_to == null ? "" : "text-gray-400"}`}>
                <td className="px-4 py-2.5 text-xs">#{r.contract_id} {r.contract_type} \u00b7 {r.party_b}</td>
                <td className="px-4 py-2.5">{FR[r.fraction] ?? r.fraction}{r.valid_to == null && <span className="ml-2 px-1.5 py-0.5 bg-brand-bluelight text-brand-bluedark text-[10px] rounded font-bold uppercase">aktualna</span>}</td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{Number(r.rate_value).toLocaleString("pl-PL")} {r.currency}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{r.rate_unit === "PLN_PER_POINT_MONTH" ? "za punkt / mc" : r.rate_unit}</td>
                <td className="px-4 py-2.5 text-xs">{fmtDate(r.valid_from)}</td>
                <td className="px-4 py-2.5 text-xs">{r.valid_to ? fmtDate(r.valid_to) : "\u2014"}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{r.description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MasterCycles({ cycles, onReload }: { cycles: any[]; onReload: () => void }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [ledger, setLedger] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLedger = async (id: number) => {
    try {
      const d = await api(`/api/admin/cycles/${id}/ledger`);
      setLedger(d);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (openId !== null) loadLedger(openId);
  }, [openId]);

  const runEngine = async (id: number) => {
    setBusy(true); setError(null);
    try {
      await api(`/api/admin/cycles/${id}/run-engine`, { method: "POST" });
      await loadLedger(id);
      onReload();
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  };

  const approve = async (id: number) => {
    setBusy(true); setError(null);
    try {
      await api(`/api/admin/cycles/${id}/approve`, { method: "POST" });
      onReload();
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  };

  const reopen = async (id: number) => {
    setBusy(true); setError(null);
    try {
      await api(`/api/admin/cycles/${id}/reopen`, { method: "POST" });
      await loadLedger(id);
      onReload();
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
    };

  return (
    <div className="space-y-3">
      <h3 className="font-semibold mb-1">Cykle rozliczeniowe ({cycles.length})</h3>
      <p className="text-xs text-gray-500 mb-2">PROMPT 3: Silnik rozliczeń · draft → approved → reopened · ledger niezmienialny</p>
      {error && <ErrorBox message={error} />}
      {cycles.map((c) => (
        <div key={c.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setOpenId(openId === c.id ? null : c.id)}
            className="w-full flex items-center justify-between p-4 hover:bg-gray-50"
          >
            <div className="flex items-center gap-3">
              <Icon d={openId === c.id ? "M19 9l-7 7-7-7" : "M9 5l7 7-7 7"} className="w-4 h-4 text-gray-400" />
              <div className="text-left">
                <div className="font-medium">{c.label}</div>
                <div className="text-xs text-gray-500">{fmtDate(c.period_start)} → {fmtDate(c.period_end)}</div>
              </div>
            </div>
            <StatusBadge status={c.status} />
          </button>

          {openId === c.id && (
            <div className="border-t border-gray-200 p-4 space-y-4">
              {/* Action buttons */}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => runEngine(c.id)}
                  disabled={busy || c.status === "approved"}
                  className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? "Przetwarzam..." : "Uruchom silnik rozliczeń"}
                </button>
                {c.status === "draft" && (
                  <button
                    onClick={() => approve(c.id)}
                    disabled={busy}
                    className="px-3 py-1.5 bg-brand-blue text-white text-xs rounded-md hover:bg-brand-bluedark disabled:opacity-50"
                  >
                    Zatwierdź cykl (approve)
                  </button>
                )}
                {(c.status === "approved" || c.status === "settled") && (
                  <button
                    onClick={() => reopen(c.id)}
                    disabled={busy}
                    className="px-3 py-1.5 bg-amber-600 text-white text-xs rounded-md hover:bg-amber-700 disabled:opacity-50"
                  >
                    Cofnij cykl (reopen)
                  </button>
                )}
              </div>

              {/* Ledger entries */}
              {ledger && (
                <div className="space-y-3">
                  {/* Party summary */}
                  {ledger.partySummary && ledger.partySummary.length > 0 && (
                    <div className="bg-gray-50 rounded-lg p-3">
                      <div className="text-xs font-semibold text-gray-500 uppercase mb-2">Podsumowanie per strona</div>
                      <div className="grid grid-cols-2 gap-2">
                        {ledger.partySummary.map((ps: any) => (
                          <div key={ps.orgId} className="flex items-center justify-between bg-white rounded px-3 py-2 border border-gray-200">
                            <div>
                              <div className="text-sm font-medium">{ps.orgName}</div>
                              <div className="text-xs text-gray-500">{ps.entryCount} pozycji</div>
                            </div>
                            <div className="text-lg font-bold tabular-nums">{fmt(ps.netGrosze)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2">
                        <div className="text-xs font-semibold text-gray-500">Suma netto:</div>
                        <div className="text-lg font-bold text-green-700 tabular-nums">{fmt(ledger.totalNetGrosze)}</div>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${ledger.invariantValid ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                          {ledger.invariantValid ? "✓ Inwariant: suma credit = suma debit" : "✗ Inwariant: credit ≠ debit"}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Ledger entries table */}
                  {ledger.entries && ledger.entries.length > 0 ? (
                    <div className="overflow-x-auto border border-gray-200 rounded">
                      <table className="w-full text-xs border-collapse">
                        <thead className="bg-gray-50">
                          <tr className="text-left font-semibold text-gray-500 uppercase border-b border-gray-200">
                            <th className="px-3 py-2">Entry Type</th>
                            <th className="px-3 py-2">Strona</th>
                            <th className="px-3 py-2">Kierunek</th>
                            <th className="px-3 py-2 text-right">Netto</th>
                            <th className="px-3 py-2 text-right">VAT</th>
                            <th className="px-3 py-2 text-right">Brutto</th>
                            <th className="px-3 py-2">E2E ID</th>
                            <th className="px-3 py-2">Reversal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ledger.entries.map((e: any) => (
                            <tr key={e.id} className={`border-b border-gray-100 ${e.reversal_of_id ? "bg-red-50" : ""}`}>
                              <td className="px-3 py-2 font-mono text-[10px]">{e.entry_type}</td>
                              <td className="px-3 py-2">{e.party_org_name ?? "—"}</td>
                              <td className="px-3 py-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${e.direction === "credit" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                                  {e.direction}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">{fmt(e.amount_net)}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmt(e.vat_amount)}</td>
                              <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(e.amount_gross)}</td>
                              <td className="px-3 py-2 font-mono text-[10px] text-gray-400">{e.end_to_end_id?.slice(0, 16) ?? "—"}</td>
                              <td className="px-3 py-2 text-[10px]">
                                {e.reversal_of_id ? <span className="text-red-600 font-semibold">← #{e.reversal_of_id}</span> : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500 bg-gray-50 rounded p-4">
                      Brak pozycji ledger. Uruchom silnik rozliczeń aby wygenerować pozycje z rate_cards.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function MasterCsvImport({ cycles, onReload }: { cycles: any[]; onReload: () => void }) {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [cycleId, setCycleId] = useState<string>("");
  const [kind, setKind] = useState<"telemetry" | "credits" | "pickups">("telemetry");
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const [filename, setFilename] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreviewRows, setCsvPreviewRows] = useState<any[]>([]);

  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [newProfileName, setNewProfileName] = useState<string>("");
  const [saveProfile, setSaveProfile] = useState<boolean>(false);

  const [dryRunRes, setDryRunRes] = useState<any>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [commitRes, setCommitRes] = useState<any>(null);

  const targetFields = {
    telemetry: ["device_serial", "ts", "session_id", "ean", "fraction", "accepted", "reject_reason"],
    credits: ["period_from", "period_to", "location_ref", "fraction", "units_confirmed", "mass_kg", "deposit_value", "handling_fee_value"],
    pickups: ["pickup_ts", "device_serial", "driver_ref", "bale_seals", "units_per_bale", "gps_lat", "gps_lng"],
  };

  useEffect(() => {
    api("/api/admin/csv/profiles").then((d) => setProfiles(d.profiles)).catch(() => {});
    if (cycles.length > 0) setCycleId(cycles[0].id.toString());
  }, [cycles]);

  const selectProfile = (idStr: string) => {
    setSelectedProfileId(idStr);
    if (!idStr) {
      setMapping({});
      return;
    }
    const prof = profiles.find((p) => p.id.toString() === idStr);
    if (prof) {
      setKind(prof.kind);
      setMapping(JSON.parse(prof.mapping_json));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const text = await file.text();
    setCsvText(text);

    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      const headers = lines[0].split(",").map((h) => h.trim());
      setCsvHeaders(headers);
      const preview = lines.slice(1, 6).map((l) => {
        const cells = l.split(",");
        const r: Record<string, string> = {};
        headers.forEach((h, idx) => { r[h] = cells[idx] ?? ""; });
        return r;
      });
      setCsvPreviewRows(preview);
    }
  };

  const executeDryRun = async () => {
    setBusy(true); setError(null);
    try {
      if (saveProfile && newProfileName.trim()) {
        const pRes = await api("/api/admin/csv/profiles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: newProfileName, orgId: kind === "credits" ? 6 : 5, kind, mapping }),
        });
        api("/api/admin/csv/profiles").then((d) => {
          setProfiles(d.profiles);
          setSelectedProfileId(pRes.id.toString());
        });
      }

      const res = await api("/api/admin/csv/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, csv: csvText, mapping, cycleId: Number(cycleId) }),
      });
      setDryRunRes(res);
      setStep(3);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const executeCommit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api("/api/admin/csv/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, rows: dryRunRes.mappedRows, cycleId: Number(cycleId), filename }),
      });
      setCommitRes(res);
      setStep(4);
      onReload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
      <div className="flex items-center justify-between border-b border-gray-100 pb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Uniwersalny importer CSV</h3>
          <p className="text-xs text-gray-500 mt-1">PROMPT 2: Dynamiczne mapowanie nagłówków · walidacja błędów · delty · sumy kontrolne</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className={`px-2.5 py-1 rounded-full ${step === 1 ? "bg-green-100 text-green-800 font-medium" : "bg-gray-100"}`}>1. Plik</span>
          <Icon d="M9 5l7 7-7 7" className="w-3 h-3" />
          <span className={`px-2.5 py-1 rounded-full ${step === 2 ? "bg-green-100 text-green-800 font-medium" : "bg-gray-100"}`}>2. Mapowanie</span>
          <Icon d="M9 5l7 7-7 7" className="w-3 h-3" />
          <span className={`px-2.5 py-1 rounded-full ${step === 3 ? "bg-green-100 text-green-800 font-medium" : "bg-gray-100"}`}>3. Walidacja</span>
          <Icon d="M9 5l7 7-7 7" className="w-3 h-3" />
          <span className={`px-2.5 py-1 rounded-full ${step === 4 ? "bg-green-100 text-green-800 font-medium" : "bg-gray-100"}`}>4. Ledger</span>
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      {step === 1 && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Wybierz profil mapowania</label>
              <select value={selectedProfileId} onChange={(e) => selectProfile(e.target.value)} className="w-full text-sm border border-gray-300 rounded p-2">
                <option value="">Ręczne mapowanie (Nowy profil)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Rodzaj danych</label>
              <select disabled={!!selectedProfileId} value={kind} onChange={(e) => setKind(e.target.value as any)} className="w-full text-sm border border-gray-300 rounded p-2 bg-gray-50 disabled:opacity-75">
                <option value="telemetry">Telemetria (RVM)</option>
                <option value="credits">Potwierdzenia operatora (Credits)</option>
                <option value="pickups">Odbiory kierowców (Pickups)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Cykl rozliczeniowy</label>
              <select value={cycleId} onChange={(e) => setCycleId(e.target.value)} className="w-full text-sm border border-gray-300 rounded p-2">
                {cycles.map((c) => (
                  <option key={c.id} value={c.id}>{c.label} ({fmtDate(c.period_start)} → {fmtDate(c.period_end)}) [{c.status}]</option>
                ))}
              </select>
            </div>
          </div>

          <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center bg-gray-50 hover:bg-gray-100/50 transition relative">
            <input type="file" accept=".csv" onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <div className="space-y-1">
              <Icon d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" className="w-8 h-8 text-gray-400 mx-auto" />
              <div className="text-sm font-medium text-gray-700">{filename ? `Wybrany plik: ${filename}` : "Wybierz plik CSV lub przeciągnij tutaj"}</div>
              <div className="text-xs text-gray-500">Maksymalny rozmiar 10MB</div>
            </div>
          </div>

          {csvHeaders.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 uppercase">Podgląd pliku źródłowego (pierwsze 5 wierszy)</div>
              <div className="overflow-x-auto border border-gray-200 rounded">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead className="bg-gray-50">
                    <tr>
                      {csvHeaders.map((h) => <th key={h} className="px-3 py-1.5 text-gray-600 font-semibold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreviewRows.map((r, idx) => (
                      <tr key={idx} className="border-t border-gray-100">
                        {csvHeaders.map((h) => <td key={h} className="px-3 py-1.5 text-gray-500 truncate max-w-[150px]">{r[h]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button onClick={() => setStep(2)} className="px-4 py-2 bg-brand-blue text-white rounded text-sm font-medium hover:bg-brand-bluedark">Przejdź do mapowania kolumn</button>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="text-sm text-gray-600">Dopasuj pola systemowe (lewa kolumna) do nagłówków kolumn w Twoim pliku CSV (prawa kolumna).</div>
          <div className="grid grid-cols-2 gap-6 bg-gray-50 p-4 rounded border border-gray-200">
            <div className="space-y-1 font-semibold text-xs text-gray-500 uppercase">Pole systemowe</div>
            <div className="space-y-1 font-semibold text-xs text-gray-500 uppercase">Nagłówek w CSV</div>
            {targetFields[kind].map((field) => (
              <React.Fragment key={field}>
                <div className="flex items-center text-sm font-medium text-gray-700 font-mono">
                  {field} <span className="text-red-500 ml-0.5">*</span>
                </div>
                <div>
                  <select value={mapping[field] ?? ""} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })} className="w-full text-xs border border-gray-300 rounded p-1.5 bg-white font-mono">
                    <option value="">-- Ignoruj lub brak pasującego --</option>
                    {csvHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              </React.Fragment>
            ))}
          </div>

          {!selectedProfileId && (
            <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded p-3 text-xs">
              <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} className="mt-0.5" />
              <div className="space-y-2 flex-1">
                <span className="font-medium text-blue-900">Zapisz to mapowanie jako nowy profil importu na przyszłość</span>
                {saveProfile && (
                  <input type="text" value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} placeholder="Nazwa profilu (np. Reselekt Lipiec 2026)" className="w-full border border-blue-300 rounded p-1.5 text-xs bg-white" />
                )}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button onClick={executeDryRun} disabled={busy} className="px-4 py-2 bg-brand-blue text-white rounded text-sm font-medium hover:bg-brand-bluedark disabled:opacity-50">
              {busy ? "Analizuję (Dry-Run)..." : "Uruchom symulację (Dry-Run)"}
            </button>
            <button onClick={() => setStep(1)} className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm">Cofnij</button>
          </div>
        </div>
      )}

      {step === 3 && dryRunRes && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="px-3 py-1.5 bg-green-100 text-green-800 rounded-lg text-xs font-semibold">
              Wiersze poprawne: {dryRunRes.deltas.insertedEvents}
            </div>
            <div className="px-3 py-1.5 bg-red-100 text-red-800 rounded-lg text-xs font-semibold">
              Błędy walidacji: {dryRunRes.errorCount}
            </div>
            {dryRunRes.deltas.duplicatedKeys > 0 && (
              <div className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded-lg text-xs font-semibold">
                Duplikaty pominięte: {dryRunRes.deltas.duplicatedKeys}
              </div>
            )}
            <div className="px-3 py-1.5 bg-blue-100 text-blue-800 rounded-lg text-xs font-semibold">
              Suma kontrolna: {fmtInt(dryRunRes.deltas.checksumSum)} szt
            </div>
          </div>

          {dryRunRes.validationErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-2">
              <div className="text-xs font-bold text-red-800 uppercase flex items-center gap-1.5">
                <Icon d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" className="w-4 h-4 text-red-600" />
                Wykryto {dryRunRes.errorCount} błędów przed importem:
              </div>
              <ul className="text-xs text-red-700 pl-4 list-disc max-h-48 overflow-y-auto font-mono">
                {dryRunRes.validationErrors.map((err: string, i: number) => <li key={i}>{err}</li>)}
              </ul>
              <div className="text-[10px] text-red-500">Popraw plik CSV i wgraj ponownie lub popraw mapowanie kolumn przed zatwierdzeniem bazy.</div>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-500 uppercase">Symulacja mapowanych danych (pierwsze 10 poprawnych wierszy)</div>
            <div className="overflow-x-auto border border-gray-200 rounded max-h-72">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead className="bg-gray-50">
                  <tr>
                    {targetFields[kind].map((f) => <th key={f} className="px-3 py-1.5 text-gray-600 font-semibold">{f}</th>)}
                    {kind === "telemetry" && <th className="px-3 py-1.5 text-green-700 font-semibold">calculated_weight (g)</th>}
                  </tr>
                </thead>
                <tbody>
                  {dryRunRes.mappedRows.slice(0, 10).map((r: any, idx: number) => (
                    <tr key={idx} className="border-t border-gray-100">
                      {targetFields[kind].map((f) => {
                        const val = r[f];
                        const display = f.includes("ts") || f.includes("date") || f.includes("_to") || f.includes("_from") ? fmtIso(val) : val;
                        return <td key={f} className="px-3 py-1.5 text-gray-500 truncate max-w-[150px]">{display ?? "null"}</td>;
                      })}
                      {kind === "telemetry" && <td className="px-3 py-1.5 text-green-600 font-bold tabular-nums">{r.weight_from_catalog}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex gap-2 pt-2 border-t border-gray-100">
            <button onClick={executeCommit} disabled={dryRunRes.deltas.insertedEvents === 0 || busy} className="px-5 py-2.5 bg-brand-blue text-white rounded text-sm font-semibold hover:bg-brand-bluedark disabled:opacity-50 shadow-lg">
              {busy ? "Zapisuję..." : "Zatwierdź i zapisz w ledgerze (transakcyjnie)"}
            </button>
            <button onClick={() => setStep(2)} className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm">Cofnij mapowanie</button>
          </div>
        </div>
      )}

      {step === 4 && commitRes && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-8 text-center space-y-4 max-w-xl mx-auto my-6">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto text-green-600">
            <Icon d="M9 12l2 2 4-4m6-2a9 9 0 11-18 0 9 9 0 0118 0z" className="w-10 h-10" />
          </div>
          <div className="space-y-1">
            <h4 className="text-lg font-bold text-green-900">Batch zaimportowany pomyślnie!</h4>
            <p className="text-sm text-green-700">Zapisek transakcyjny został rozesłany do event_log i ledger_entries.</p>
          </div>
          <div className="bg-white rounded border border-green-100 p-4 text-xs font-mono text-left space-y-1.5 text-gray-600">
            <div><strong>Correlation ID:</strong> {commitRes.correlationId}</div>
            <div><strong>Zaimportowano rekordów:</strong> {commitRes.imported}</div>
            <div><strong>Pominiętych duplikatów:</strong> {commitRes.skippedDuplicates}</div>
            <div><strong>Timestamp:</strong> {fmtDateTime(Date.now())}</div>
          </div>
          <button onClick={() => { setStep(1); setFilename(""); setCsvHeaders([]); setDryRunRes(null); setCommitRes(null); }} className="px-4 py-2 bg-brand-blue text-white rounded text-sm font-medium hover:bg-brand-bluedark">Importuj kolejny plik</button>
        </div>
      )}
    </div>
  );
}

function MasterCatalog() {
  const [items, setItems] = useState<any[]>([]);
  const [query, setQ] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);

  const [overrideScope, setOverrideScope] = useState<string>("global");
  const [overrideScopeId, setOverrideScopeId] = useState<string>("");
  const [overrideAction, setOverrideAction] = useState<"block" | "allow">("block");
  const [overrideReason, setOverrideReason] = useState<string>("");

  const reload = useCallback(() => {
    setBusy(true);
    api(`/api/admin/catalog?q=${encodeURIComponent(query)}`)
      .then((d) => setItems(d.items))
      .catch(() => {})
      .finally(() => setBusy(false));
  }, [query]);

  useEffect(() => { reload(); }, [reload]);

  const saveOverride = async (e: any) => {
    e.preventDefault();
    if (!selectedItem) return;
    setBusy(true);
    try {
      await api("/api/admin/catalog/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ean: selectedItem.ean, scope: overrideScope, scopeId: overrideScopeId || undefined, action: overrideAction, reason: overrideReason }),
      });
      setSelectedItem(null);
      setOverrideScope("global"); setOverrideScopeId(""); setOverrideReason("");
      reload();
    } catch (err: any) {
      alert("Błąd: " + err.message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">Katalog opakowań (Biała lista EAN)</h3>
            <p className="text-xs text-gray-500 mt-1">PROMPT 2: centralny rejestr z priorytetyzowanymi blokadami (overrides) per lokalizacja</p>
          </div>
          <div className="flex items-center gap-2">
            <input type="text" value={query} onChange={(e) => setQ(e.target.value)} placeholder="Szukaj po EAN, nazwie, producencie..." className="border border-gray-300 rounded text-sm px-3 py-1.5 w-64" />
            <button onClick={reload} className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm">Szukaj</button>
          </div>
        </div>

        {selectedItem && (
          <form onSubmit={saveOverride} className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3">
            <div className="text-xs font-bold text-amber-800 uppercase">Dodaj ręczną blokadę / zezwolenie per EAN: {selectedItem.product_name} ({selectedItem.ean})</div>
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Zakres (Scope)</label>
                <select value={overrideScope} onChange={(e) => setOverrideScope(e.target.value)} className="w-full border border-gray-300 rounded p-1.5 text-xs bg-white">
                  <option value="global">Globalnie (Cały system)</option>
                  <option value="location">Lokalizacja (Location ID)</option>
                  <option value="device">Urządzenie (Device ID)</option>
                </select>
              </div>
              {overrideScope !== "global" && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">ID zakresu (Scope ID)</label>
                  <input type="text" required value={overrideScopeId} onChange={(e) => setOverrideScopeId(e.target.value)} placeholder={overrideScope === "location" ? "np. SL-001" : "np. EAC-KTW-001"} className="w-full border border-gray-300 rounded p-1.5 text-xs bg-white" />
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Akcja (Action)</label>
                <select value={overrideAction} onChange={(e) => setOverrideAction(e.target.value as any)} className="w-full border border-gray-300 rounded p-1.5 text-xs bg-white">
                  <option value="block">ZABLOKUJ (Block)</option>
                  <option value="allow">ZEZWÓL (Allow)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Powód blokady</label>
                <input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="np. Za duży dla urządzenia" className="w-full border border-gray-300 rounded p-1.5 text-xs bg-white" />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={busy} className="px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-semibold hover:bg-amber-700">Zapisz blokadę (Override)</button>
              <button type="button" onClick={() => setSelectedItem(null)} className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded text-xs">Anuluj</button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto border border-gray-200 rounded">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase border-b border-gray-200">
                <th className="px-4 py-3">EAN</th>
                <th className="px-4 py-3">Nazwa produktu</th>
                <th className="px-4 py-3">Producent</th>
                <th className="px-4 py-3">Frakcja</th>
                <th className="px-4 py-3 text-right">Waga całkowita (g)</th>
                <th className="px-4 py-3 text-right">Kaucja</th>
                <th className="px-4 py-3">Status / Overrides</th>
                <th className="px-4 py-3 text-right">Akcja</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500 text-sm">Brak produktów w katalogu.</td></tr>}
              {items.map((pi) => {
                const isBlocked = pi.override_action === "block" || pi.is_deleted === 1;
                return (
                  <tr key={pi.ean} className="border-b border-gray-100 hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{pi.ean}</td>
                    <td className="px-4 py-3 font-semibold text-gray-900">{pi.product_name}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{pi.producer}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${pi.fraction === "PET" ? "bg-purple-100 text-purple-700" : pi.fraction === "ALU" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>{pi.fraction}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{pi.weight_total_g} g</td>
                    <td className="px-4 py-3 text-right font-semibold text-green-700 tabular-nums">{fmt(pi.deposit_amount_grosze)}</td>
                    <td className="px-4 py-3">
                      {pi.override_action ? (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${pi.override_action === "block" ? "bg-red-100 text-red-800 border border-red-200" : "bg-green-100 text-green-800 border border-green-200"}`}>
                          Manual: {pi.override_action === "block" ? "BLOKADA" : "ZEZWOL"}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">Active (Katalog)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setSelectedItem(pi)} className="px-2.5 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 text-gray-700">Blokuj / Zezwól</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// PROMPT 4 — MasterDisputes: panel sporów posortowany po due_at + timeline stanów
function MasterDisputes() {
  const [disputes, setDisputes] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDispute, setSelectedDispute] = useState<any>(null);
  const [transitionState, setTransitionState] = useState("");
  const [evidence, setEvidence] = useState("");

  const reload = useCallback(() => {
    api("/api/admin/disputes")
      .then((d) => setDisputes(d.disputes))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const doTransition = async (e: any) => {
    e.preventDefault();
    if (!selectedDispute || !transitionState) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/admin/disputes/${selectedDispute.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newState: transitionState, evidence: evidence || undefined }),
      });
      setSelectedDispute(null);
      setTransitionState("");
      setEvidence("");
      reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doDefaultAction = async (id: number) => {
    setBusy(true); setError(null);
    try {
      await api(`/api/admin/disputes/${id}/default-action`, { method: "POST" });
      reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const alertColors: Record<string, string> = {
    none: "bg-gray-100 text-gray-600",
    warning: "bg-yellow-100 text-yellow-700",
    critical: "bg-orange-100 text-orange-700",
    overdue: "bg-red-100 text-red-700 border border-red-300",
  };

  const stateColors: Record<string, string> = {
    INQUIRY_EVIDENCE_REQUIRED: "bg-blue-100 text-blue-700",
    INQUIRY_PROCESSING: "bg-blue-200 text-blue-800",
    INQUIRY_CLOSED: "bg-gray-200 text-gray-600",
    EVIDENCE_REQUIRED: "bg-yellow-100 text-yellow-700",
    PROCESSING: "bg-orange-100 text-orange-700",
    WON: "bg-green-100 text-green-700",
    LOST: "bg-red-100 text-red-700",
    ACCEPTED: "bg-purple-100 text-purple-700",
  };

  const allowedTransitions: Record<string, string[]> = {
    INQUIRY_EVIDENCE_REQUIRED: ["INQUIRY_PROCESSING", "INQUIRY_CLOSED"],
    INQUIRY_PROCESSING: ["INQUIRY_CLOSED", "EVIDENCE_REQUIRED"],
    EVIDENCE_REQUIRED: ["PROCESSING", "ACCEPTED"],
    PROCESSING: ["WON", "LOST", "ACCEPTED"],
  };

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">Spory rozliczeniowe</h3>
            <p className="text-xs text-gray-500 mt-1">PROMPT 4: Zegar 5 dni roboczych · dispute state machine 8 stanów · akcja domyślna po due_at</p>
          </div>
          <div className="text-xs text-gray-500">Posortowane po due_at rosnąco</div>
        </div>

        {selectedDispute && (
          <form onSubmit={doTransition} className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3 mb-4">
            <div className="text-xs font-bold text-blue-800 uppercase">Zmień stan sporu #{selectedDispute.id} ({selectedDispute.state})</div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Nowy stan</label>
                <select value={transitionState} onChange={(e) => setTransitionState(e.target.value)} required className="w-full border border-gray-300 rounded p-1.5 text-xs bg-white">
                  <option value="">-- Wybierz --</option>
                  {(allowedTransitions[selectedDispute.state] ?? []).map((s: string) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Dowód / notatka (opcjonalnie)</label>
                <input type="text" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="np. Fotografia palety, weryfikacja z EcoAction" className="w-full border border-gray-300 rounded p-1.5 text-xs bg-white" />
              </div>
            </div>
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700">Zatwierdź przejście</button>
              <button type="button" onClick={() => { setSelectedDispute(null); setTransitionState(""); setEvidence(""); }} className="px-3 py-1.5 bg-gray-200 text-gray-700 rounded text-xs">Anuluj</button>
            </div>
          </form>
        )}

        {disputes.length === 0 ? (
          <div className="text-sm text-gray-500 bg-gray-50 rounded p-6 text-center">
            Brak otwartych sporów. Uruchom rekoncyliację z zakładki Rozliczenia aby wykryć rozjazdy {">2%"}.
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-200 rounded">
            <table className="w-full text-sm border-collapse">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold text-gray-500 uppercase border-b border-gray-200">
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Punkt</th>
                  <th className="px-3 py-2">Cykl</th>
                  <th className="px-3 py-2">Rozjazd</th>
                  <th className="px-3 py-2">Kwota</th>
                  <th className="px-3 py-2">Stan</th>
                  <th className="px-3 py-2">Due at</th>
                  <th className="px-3 py-2">Alert</th>
                  <th className="px-3 py-2">Dni rob.</th>
                  <th className="px-3 py-2 text-right">Akcja</th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((d) => (
                  <tr key={d.id} className={`border-b border-gray-100 hover:bg-gray-50/50 ${d.isOverdue ? "bg-red-50" : d.alertLevel === "critical" ? "bg-orange-50" : ""}`}>
                    <td className="px-3 py-2 font-mono text-xs">#{d.id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{d.scope_ref}</td>
                    <td className="px-3 py-2 text-xs">{d.cycle_label ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className={d.delta_pct > 5 ? "text-red-700 font-bold" : d.delta_pct > 2 ? "text-orange-700 font-semibold" : "text-gray-700"}>
                        {d.delta_pct?.toFixed(2)}%
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">{d.disputed_amount_grosze ? fmt(d.disputed_amount_grosze) : "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${stateColors[d.state] ?? "bg-gray-100 text-gray-600"}`}>
                        {d.state}
                      </span>
                      {d.default_action_taken ? <span className="ml-1 text-[9px] text-red-600">⚡auto</span> : null}
                    </td>
                    <td className="px-3 py-2 text-xs">{fmtDateTime(d.due_at)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${alertColors[d.alertLevel] ?? alertColors.none}`}>
                        {d.alertLevel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">
                      {d.isOverdue ? <span className="text-red-600 font-bold">przekroczone</span> : `${d.remainingDays}d`}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => setSelectedDispute(d)} disabled={!(allowedTransitions[d.state])} className="px-2 py-1 text-[10px] border border-gray-300 rounded hover:bg-gray-50 text-gray-700 disabled:opacity-30">Zmień stan</button>
                        {d.isOverdue && !d.default_action_taken && (d.state === "INQUIRY_EVIDENCE_REQUIRED" || d.state === "EVIDENCE_REQUIRED") && (
                          <button onClick={() => doDefaultAction(d.id)} disabled={busy} className="px-2 py-1 text-[10px] bg-red-600 text-white rounded hover:bg-red-700">Akcja domyślna</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MasterEvents() {
  const [events, setEvents] = useState<any[]>([]);
  useEffect(() => { api("/api/admin/events").then((d) => setEvents(d.events)).catch(() => {}); }, []);
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold mb-2">Event log (ostatnie 200)</h3>
      <div className="space-y-1 max-h-[60vh] overflow-y-auto">
        {events.length === 0 && <div className="text-sm text-gray-500">Brak zdarzeń.</div>}
        {events.map((e) => (
          <div key={e.id} className="flex items-start gap-2 text-xs font-mono border-b border-gray-50 pb-1">
            <span className="text-gray-400 shrink-0">{fmtIso(e.created_at)}</span>
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">{e.event_type}</span>
            <span className="text-gray-600 truncate flex-1">{e.payload_json || ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── PROMPT 7: Mapa live (Leaflet + SSE) ───────────────────────────────────────
declare const L: any;

// M2: XSS escape — addr/district/party przychodzą z CSV importów (operator-supplied).
const esc = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!)
  );

// Progi koloru fill_% — canvas circleMarker per punkt (nie markercluster —
// kolor per-punkt jest clou widoku). Markercluster wyłącza tę informację.
const FILL_TIERS = [
  { max: 30,  color: "#16a34a", label: "< 30% (OK)" },
  { max: 70,  color: "#eab308", label: "30–70%" },
  { max: 95,  color: "#f97316", label: "70–95%" },
  { max: 101, color: "#dc2626", label: "> 95% (alert)" },
];
const fillColor = (pct: number) =>
  (FILL_TIERS.find((t) => pct < t.max) ?? FILL_TIERS[3]).color;

// Hook EventSource z auto-reconnect + dedupe po SSE `id`. Cursor transportowany
// przez Last-Event-ID (server w realtime.ts czyta z `event_log.id`).
// M3: `sinceId` — cursor ze snapshotu; pierwszy connect zaczyna od niego (bez luki
// między snapshot query a otwarciem streamu). Reconnecty nadpisują go Last-Event-ID.
function useEventStream(
  enabled: boolean,
  types: string,
  sinceId: number | null,
  onEvent: (e: any) => void
) {
  const [state, setState] = useState<"connecting" | "live" | "error">("connecting");
  const [lastAt, setLastAt] = useState<number | null>(null);
  const cbRef = useRef(onEvent); cbRef.current = onEvent;
  useEffect(() => {
    if (!enabled || sinceId === null) return;
    const es = new EventSource(
      `/api/admin/events/stream?type=${encodeURIComponent(types)}&sinceId=${sinceId}`,
      { withCredentials: true } as any
    );
    const seen = new Set<number>();
    const handle = (ev: MessageEvent) => {
      try {
        const d = JSON.parse((ev as any).data);
        if (typeof d.id === "number") {
          if (seen.has(d.id)) return;
          seen.add(d.id);
          if (seen.size > 4000) seen.clear();
        }
        setState("live"); setLastAt(Date.now()); cbRef.current(d);
      } catch {}
    };
    for (const t of ["location", "cycle", "dispute", "message"]) {
      es.addEventListener(t, handle as any);
    }
    es.onopen = () => setState("live");
    es.onerror = () => setState((s) => (s === "live" ? "live" : "error"));
    return () => es.close();
  }, [enabled, types, sinceId]);
  return { state, lastAt };
}

function MasterMapaLive({ user }: { user: User }) {
  const mapRef = useRef<any>(null);
  const rendererRef = useRef<any>(null); // H3: JEDEN canvas renderer dla 2000+ markerów
  const markersRef = useRef<Map<string, any>>(new Map());
  const alertLayerRef = useRef<any>(null);
  const alertPulsesRef = useRef<any[]>([]); // L4: własna kolejka FIFO zamiast prywatnego _layers
  const canvasLayerRef = useRef<any>(null);
  const toastContainerRef = useRef<HTMLDivElement | null>(null);
  const replayEsRef = useRef<EventSource | null>(null); // M5: handle do cleanup
  const [stats, setStats] = useState({ points: 0, alerts: 0, changes: 0 });
  const [filter, setFilter] = useState<"all" | "location" | "cycle" | "dispute">("all");
  const [paused, setPaused] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamCursor, setStreamCursor] = useState<number | null>(null); // M3

  const onEvent = useCallback((d: any) => {
    if (paused) return;
    if (d.cat === "location" && d.pointId) {
      const m = markersRef.current.get(d.pointId);
      if (m && d.payload?.fillPct !== undefined) {
        m.setStyle({ fillColor: fillColor(d.payload.fillPct), color: "#fff" });
        // L3: pełna treść tooltipa (adres + dzielnica zachowane z datasetu markera)
        const meta = (m as any).__edrsMeta;
        if (meta) {
          meta.fill = d.payload.fillPct;
          m.setTooltipContent(
            `${esc(meta.id)} · ${esc(meta.district)}<br>${esc(meta.addr)}<br>Zapełnienie: ${esc(meta.fill)}%`
          );
        }
        // L2: licznik zmian tylko gdy marker faktycznie istnieje na mapie
        setStats((s) => ({ ...s, changes: s.changes + 1 }));
      }
    } else if (d.cat === "dispute" && d.pointId && d.type !== "ticket_resolved" && d.type !== "dispute_state_transition") {
      const m = markersRef.current.get(d.pointId);
      if (!m || !alertLayerRef.current) return;
      const latLng = m.getLatLng();
      const isT1 = d.payload?.alertLevel === "T-1";
      const pulseIcon = L.divIcon({
        className: "",
        html: `<div class="pulse-marker ${isT1 ? "t1" : ""}"></div>`,
        iconSize: [18, 18],
      });
      const pulse = L.marker(latLng, { icon: pulseIcon, interactive: true, zIndexOffset: 1000 })
        .addTo(alertLayerRef.current);
      const deltaTxt = d.payload?.deltaPct ? `${Number(d.payload.deltaPct).toFixed(1)}%` : "—";
      const amtTxt = fmt(d.payload?.disputedAmountGrosze ?? 0);
      pulse.bindPopup(
        `<div style="font-size:12px"><b>${esc(d.pointId)}</b><br>Spór: ${esc(deltaTxt)}<br>${esc(amtTxt)} netto<br>Poziom alertu: ${esc(d.payload?.alertLevel ?? "—")}</div>`
      );
      // L4: FIFO przez własną tablicę, nie prywatne _layers
      alertPulsesRef.current.push(pulse);
      if (alertPulsesRef.current.length > 60) {
        const oldest = alertPulsesRef.current.shift();
        try { alertLayerRef.current.removeLayer(oldest); } catch {}
      }
      setTimeout(() => {
        try {
          alertLayerRef.current?.removeLayer(pulse);
          const idx = alertPulsesRef.current.indexOf(pulse);
          if (idx >= 0) alertPulsesRef.current.splice(idx, 1);
        } catch {}
      }, 45000);
      setStats((s) => ({ ...s, alerts: s.alerts + 1 }));
    } else if (d.cat === "cycle") {
      const container = toastContainerRef.current;
      if (container) {
        // M2: textContent zamiast innerHTML — party pochodzi z payloadu (CSV-supplied org name)
        const toast = document.createElement("div");
        toast.className = "toast bg-white border border-gray-200 rounded-lg shadow-md p-3 text-sm";
        toast.setAttribute("role", "status");
        const title = document.createElement("div");
        title.className = "font-semibold text-gray-900";
        title.textContent = "Kredyt cyklu zaksięgowany";
        const body = document.createElement("div");
        body.className = "text-gray-600";
        body.textContent = `${d.payload?.party ?? "—"} · ${fmt(d.payload?.amountNetGrosze ?? 0)} netto`;
        toast.appendChild(title);
        toast.appendChild(body);
        toast.onclick = () => { try { toast.remove(); } catch {} };
        container.appendChild(toast);
        setTimeout(() => {
          toast.classList.add("leaving");
          setTimeout(() => { try { toast.remove(); } catch {} }, 220);
        }, 6000);
        while (container.children.length > 4) {
          try { container.children[0].remove(); } catch {}
        }
      }
    }
  }, [paused]);

  const { state: streamState, lastAt } = useEventStream(!paused, filter, streamCursor, onEvent);

  // H3: wspólna funkcja renderująca snapshot — jeden renderer, tooltip + popup + meta.
  const renderSnapshot = useCallback((snap: any) => {
    if (!canvasLayerRef.current || !rendererRef.current) return;
    canvasLayerRef.current.clearLayers();
    markersRef.current.clear();
    for (const row of snap.points as any[][]) {
      const [id, lat, lng, fill, status, lastColl, addr, district] = row;
      if (lat == null || lng == null) continue;
      const m = L.circleMarker([lat, lng], {
        renderer: rendererRef.current, // H3: JEDEN wspólny canvas
        radius: 5,
        weight: 1,
        color: "#fff",
        fillColor: fillColor(fill ?? 0),
        fillOpacity: 0.9,
      }).addTo(canvasLayerRef.current);
      (m as any).__edrsMeta = { id, addr: addr ?? "", district: district ?? "", fill: fill ?? 0 };
      m.bindTooltip(`${esc(id)} · ${esc(district ?? "")}<br>${esc(addr ?? "")}<br>Zapełnienie: ${esc(fill ?? 0)}%`);
      m.bindPopup(
        `<div style="font-size:12px"><b>${esc(id)}</b><br>${esc(addr ?? "")}<br>${esc(district ?? "")}<br>Zapełnienie: ${esc(fill ?? 0)}%<br>Ostatni odbiór: ${lastColl ? esc(new Date(lastColl).toLocaleString("pl-PL")) : "—"}<br>Status: ${esc(status ?? "—")}</div>`
      );
      markersRef.current.set(id, m);
    }
    setStats((s) => ({ ...s, points: markersRef.current.size }));
    // M3: cursor ze snapshotu → stream zaczyna od niego (bez luki)
    if (typeof snap.cursor === "number") setStreamCursor(snap.cursor);
  }, []);

  // Init mapy + snapshot. M4: pełny cleanup w return.
  useEffect(() => {
    if (typeof L === "undefined") {
      setLoadError("Nie udało się wczytać biblioteki Leaflet (CDN).");
      return;
    }
    const node = document.getElementById("edrs-map");
    if (!node) return;
    if (!mapRef.current) {
      const map = L.map(node, {
        preferCanvas: true,
        center: [52.0, 19.3],
        zoom: 6,
        minZoom: 5,
        maxZoom: 16,
        worldCopyJump: false,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 18,
      }).addTo(map);
      map.setMaxBounds([[48.9, 13.9], [55.0, 24.3]]);
      rendererRef.current = L.canvas({ padding: 0.5 }); // H3
      canvasLayerRef.current = L.layerGroup().addTo(map);
      alertLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
    }
    (async () => {
      try {
        const snap: any = await api("/api/admin/map/snapshot");
        renderSnapshot(snap);
      } catch (e: any) {
        setLoadError(e?.message ?? String(e));
      }
    })();
    return () => {
      // M4: destroy Leaflet + M5: close replay EventSource
      try { replayEsRef.current?.close(); } catch {}
      replayEsRef.current = null;
      try { mapRef.current?.remove(); } catch {}
      mapRef.current = null;
      rendererRef.current = null;
      canvasLayerRef.current = null;
      alertLayerRef.current = null;
      alertPulsesRef.current = [];
      markersRef.current.clear();
    };
  }, [renderSnapshot]);

  const refreshSnapshot = async () => {
    try {
      const snap: any = await api("/api/admin/map/snapshot");
      renderSnapshot(snap);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    }
  };

  const reseed = async () => {
    try {
      await api("/api/admin/dev/seed-locations", { method: "POST", body: JSON.stringify({ count: 2000 }) });
    } catch {}
    await refreshSnapshot();
  };

  const simulate = async () => {
    try {
      await api("/api/admin/dev/simulate", {
        method: "POST",
        body: JSON.stringify({ locations: 40, credits: 2, disputes: 1 }),
      });
    } catch {}
  };

  const replayEvents = () => {
    // M5: jeden replay naraz, handle w ref, onerror zamyka (bez infinite reconnect)
    try { replayEsRef.current?.close(); } catch {}
    const es = new EventSource(
      `/api/admin/events/stream?replay=50&type=${encodeURIComponent(filter)}`,
      { withCredentials: true } as any
    );
    replayEsRef.current = es;
    const handle = (ev: MessageEvent) => {
      if ((ev as any).type === "replay_done") { es.close(); replayEsRef.current = null; return; }
      try { onEvent(JSON.parse((ev as any).data)); } catch {}
    };
    for (const t of ["location", "cycle", "dispute", "replay_done", "message"]) {
      es.addEventListener(t, handle as any);
    }
    es.onerror = () => { es.close(); replayEsRef.current = null; };
  };

  // L5: paused ma własny stan wizualny — dot nie kłamie że "Na żywo"
  const statusLabel = paused
    ? "Wstrzymano"
    : streamState === "live"
    ? "Na żywo"
    : streamState === "connecting"
    ? "Łączenie…"
    : "Błąd połączenia";

  return (
    <div>
      {/* Header bar */}
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <span className={`live-dot ${!paused && streamState === "live" ? "" : "off"}`}></span>
          <span className="text-sm font-medium">{statusLabel}</span>
          <span className="text-xs text-gray-500">
            {lastAt ? `Ostatnie: ${new Date(lastAt).toLocaleTimeString("pl-PL")} · ` : ""}
            Punkty: <b>{stats.points}</b> · Alerty: <b>{stats.alerts}</b> · Zmiany: <b>{stats.changes}</b>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-gray-300 rounded-md overflow-hidden text-xs">
            {(["all", "location", "cycle", "dispute"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 ${filter === f ? "bg-gray-900 text-white" : "bg-white hover:bg-gray-50"}`}
              >
                {f === "all" ? "Wszystko" : f === "location" ? "Punkty" : f === "cycle" ? "Rozliczenia" : "Spory"}
              </button>
            ))}
          </div>
          <button
            onClick={refreshSnapshot}
            className="text-xs px-3 py-1 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Odśwież
          </button>
          <button
            onClick={() => setPaused((p) => !p)}
            className="text-xs px-3 py-1 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            {paused ? "Wznów" : "Pauza"}
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 text-xs text-gray-600 mb-3 flex-wrap">
        {FILL_TIERS.map((t) => (
          <span key={t.label} className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full inline-block" style={{ background: t.color }}></span>
            {t.label}
          </span>
        ))}
      </div>

      {/* Map + empty state */}
      {loadError && <ErrorBox message={loadError} />}
      {!loadError && stats.points === 0 && (
        <div className="text-center text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg p-3 mb-3">
          Brak punktów z współrzędnymi. Użyj „Zasiej 2000 punktów” w narzędziach demo.
        </div>
      )}
      <div id="edrs-map" style={{ height: "calc(100vh - 240px)", minHeight: 420 }}></div>

      {/* Toast host (PROMPT 7 — fixed bottom-right) */}
      <div ref={toastContainerRef} className="toast-stack" aria-live="polite"></div>

      {/* Dev tools (master only) */}
      {user.role === "master" && (
        <details className="mt-4 bg-white border border-gray-200 rounded-lg p-3 text-sm">
          <summary className="cursor-pointer font-semibold text-gray-700">Narzędzia demo</summary>
          <div className="flex gap-2 mt-2 flex-wrap">
            <button onClick={reseed} className="px-3 py-1.5 border border-gray-300 rounded-md hover:bg-gray-50">
              Zasiej 2000 punktów
            </button>
            <button onClick={simulate} className="px-3 py-1.5 border border-gray-300 rounded-md hover:bg-gray-50">
              Symuluj ruch
            </button>
            <button onClick={replayEvents} className="px-3 py-1.5 border border-gray-300 rounded-md hover:bg-gray-50">
              Replay 50 zdarzeń
            </button>
          </div>
        </details>
      )}
    </div>
  );
}

// ─── PROMPT 8: Agenci wewnętrzni (health check / data quality / dispute deadlines) ───
function MasterAgents() {
  const [status, setStatus] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setError(null); setStatus(await api("/api/admin/agents/status")); }
    catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const runNow = async () => {
    setRunning(true);
    try { await api("/api/admin/agents/run", { method: "POST" }); await load(); }
    catch (e: any) { setError(e.message); }
    setRunning(false);
  };
  const AGENT_LABELS: Record<string, string> = {
    health_check: "Health check (punkty + urządzenia)",
    data_quality: "Jakość danych (hash chain, sieroty)",
    dispute_deadline: "Terminy sporów (default action)",
  };
  const metaMap: Record<string, string> = {};
  for (const m of status?.meta ?? []) metaMap[m.key] = m.value;
  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="text-sm text-gray-600">
          Deterministyczna automatyzacja — cron co godzinę + trigger ręczny. Każdy run audytowalny w event logu (ścieżka ISO: kto / co / kiedy).
        </div>
        <button onClick={runNow} disabled={running} className="text-sm px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-50">
          {running ? "Uruchamiam…" : "Uruchom agentów teraz"}
        </button>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {Object.entries(AGENT_LABELS).map(([k, label]) => (
          <div key={k} className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="font-semibold text-sm mb-1">{label}</div>
            <div className="text-xs text-gray-500">Ostatni run: {metaMap[`agent:${k}:last_run`] ? new Date(Number(metaMap[`agent:${k}:last_run`])).toLocaleString("pl-PL") : "—"}</div>
            <div className="text-xs text-gray-500">Znaleziska: {metaMap[`agent:${k}:last_findings`] ?? "—"}</div>
          </div>
        ))}
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-sm mb-3">Ostatnie runy (event log)</h3>
        <div className="space-y-2 text-xs">
          {(status?.runs ?? []).map((r: any) => {
            let p: any = {};
            try { p = JSON.parse(r.payload_json ?? "{}"); } catch {}
            return (
              <div key={r.id} className="border-b border-gray-100 pb-2">
                <span className="font-medium">{r.source}</span> · {new Date(r.created_at).toLocaleString("pl-PL")} · znaleziska: <b>{p.findingCount ?? 0}</b>, akcje: <b>{p.actions ?? 0}</b>
                {p.findings?.length > 0 && (
                  <div className="text-gray-500 mt-1">
                    {p.findings.slice(0, 5).map((f: any, i: number) => (
                      <span key={i} className="inline-block mr-2">{f.kind}{f.ref ? `(${f.ref})` : ""}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {(status?.runs ?? []).length === 0 && <div className="text-gray-500">Jeszcze żadnych runów — kliknij „Uruchom agentów teraz”.</div>}
        </div>
      </div>
    </div>
  );
}


function App() {
  const [view, setView] = useState<"landing" | "login" | "app">("landing");
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  useEffect(() => {
    if (inviteToken) { setView("app"); setLoading(false); return; }
    api("/api/me").then((data) => { if (data.user) { setUser(data.user); setView("app"); } setLoading(false); }).catch(() => setLoading(false));
  }, []);
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null); setView("landing");
    window.history.pushState({}, "", "/");
  };
  const onLogin = (u: User) => { setUser(u); setView("app"); };
  if (loading) return <Loading />;
  if (view === "app") {
    if (!user) return <SignupScreen token={inviteToken!} />;
    if (user.role === "master") return <MasterApp user={user} onLogout={logout} />;
    if (user.role === "investor") return <InvestorApp user={user} onLogout={logout} />;
    if (user.role === "driver") return <DriverApp user={user} onLogout={logout} />;
  }
  if (view === "login") return <LoginScreen onSuccess={onLogin} />;
  return <LandingPage onLoginClick={() => setView("login")} inviteToken={inviteToken} />;
}

// ─── PROMPT 8: pełny panel inwestora (model zarządcy: wspólnota = inwestor) ──────
function InvestorApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState("pulpit");
  const [dash, setDash] = useState<any>(null);
  const [overview, setOverview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const nav = [
    { id: "pulpit", label: "Pulpit", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
    { id: "mapa", label: "Mapa live", icon: "M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" },
    { id: "punkty", label: "Moje punkty", icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" },
    { id: "odbiory", label: "Odbiory", icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" },
    { id: "rozliczenia", label: "Rozliczenia", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
    { id: "faktury", label: "Faktury", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { id: "finanse", label: "Finanse", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
    { id: "umowy", label: "Umowy", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { id: "wiadomosci", label: "Wiadomości", icon: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" },
    { id: "dokumenty", label: "Dokumenty", icon: "M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
    { id: "sprawozdania", label: "Sprawozdania", icon: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
  ];
  const reload = useCallback(async () => {
    try {
      setError(null);
      const [d, o] = await Promise.all([api("/api/investor/dashboard"), api("/api/investor/overview")]);
      setDash(d); setOverview(o);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return (
    <NavShell title={nav.find((n) => n.id === view)?.label ?? ""} nav={nav} activeView={view} setView={setView} user={user} onLogout={onLogout}>
      {error && <ErrorBox message={error} />}
      {view === "pulpit" && <InvestorPulpit dash={dash} />}
      {view === "mapa" && <MasterMapaLive user={user} />}
      {view === "punkty" && <InvestorPunkty dash={dash} />}
      {view === "odbiory" && <InvestorOdbiory />}
      {view === "rozliczenia" && <InvestorRozliczenia overview={overview} />}
      {view === "faktury" && <InvestorFaktury />}
      {view === "finanse" && <InvestorFinanse />}
      {view === "umowy" && <InvestorUmowy />}
      {view === "wiadomosci" && <InvestorWiadomosci />}
      {view === "dokumenty" && <InvestorDokumenty />}
      {view === "sprawozdania" && <InvestorSprawozdania />}
    </NavShell>
  );
}

function InvestorPulpit({ dash }: { dash: any }) {
  if (!dash) return <Loading />;
  const t = dash.totals;
  return (
    <div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard label="Przychód netto (ledger)" value={fmt(t.revenueNetGrosze)} sub={`${dash.revenueByType.length} typów pozycji`} />
        <KpiCard label="Butelki zebrane" value={fmtInt(t.bottles)} sub={`${t.locations} punktów`} />
        <KpiCard label="Śr. zapełnienie" value={`${t.avgFill}%`} />
        <KpiCard label="Urządzenia" value={t.devices} sub="w moich punktach" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="font-semibold text-sm mb-3">Butelki per punkt (top 10)</h3>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th>Punkt</th><th className="text-right">Butelki</th><th className="text-right">Odbiory</th><th className="text-right">Ostatni</th></tr></thead>
            <tbody>
              {dash.bottlesPerPoint.slice(0, 10).map((b: any) => (
                <tr key={b.point_id} className="border-t border-gray-100">
                  <td className="py-1">{b.point_id}</td>
                  <td className="text-right">{fmtInt(b.packages)}</td>
                  <td className="text-right">{b.pickups}</td>
                  <td className="text-right">{b.last_at ? new Date(b.last_at).toLocaleDateString("pl-PL") : "—"}</td>
                </tr>
              ))}
              {dash.bottlesPerPoint.length === 0 && <tr><td colSpan={4} className="py-2 text-gray-500">Brak odbiorów</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="font-semibold text-sm mb-3">Przychód wg typu pozycji</h3>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-500"><th>Typ</th><th>Kierunek</th><th className="text-right">Netto</th></tr></thead>
            <tbody>
              {dash.revenueByType.map((r: any, i: number) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-1">{r.entry_type}</td>
                  <td>{r.direction === "credit" ? "uznanie" : "obciążenie"}</td>
                  <td className="text-right">{fmt(r.net_grosze)}</td>
                </tr>
              ))}
              {dash.revenueByType.length === 0 && <tr><td colSpan={3} className="py-2 text-gray-500">Brak pozycji w ledgerze — przychód pojawi się po zamknięciu cyklu</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-4 mt-4">
        <h3 className="font-semibold text-sm mb-3">Urządzenia i telemetria</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th>Serial</th><th>Model</th><th>Punkt</th><th>Status</th><th className="text-right">Ostatni heartbeat</th></tr></thead>
          <tbody>
            {dash.devices.map((d: any) => (
              <tr key={d.id} className="border-t border-gray-100">
                <td className="py-1">{d.serial}</td>
                <td>{d.manufacturer} {d.model}</td>
                <td>{d.location_id ?? "—"}</td>
                <td>{d.status === "active" ? "aktywne" : d.status}</td>
                <td className="text-right">{d.last_heartbeat ? new Date(d.last_heartbeat).toLocaleString("pl-PL") : "—"}</td>
              </tr>
            ))}
            {dash.devices.length === 0 && <tr><td colSpan={5} className="py-2 text-gray-500">Brak urządzeń przypisanych do Twoich punktów</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvestorPunkty({ dash }: { dash: any }) {
  if (!dash) return <Loading />;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-gray-500 text-xs"><th>ID</th><th>Adres</th><th>Dzielnica</th><th className="text-right">Zapełnienie</th><th>Status</th><th className="text-right">Ostatni odbiór</th></tr></thead>
        <tbody>
          {dash.locations.map((l: any) => (
            <tr key={l.id} className="border-t border-gray-100">
              <td className="py-1.5 font-medium">{l.id}</td>
              <td>{l.address}</td>
              <td>{l.district ?? "—"}</td>
              <td className="text-right">{l.fill_level}%</td>
              <td>{l.status}</td>
              <td className="text-right">{l.last_collection_at ? new Date(l.last_collection_at).toLocaleDateString("pl-PL") : "—"}</td>
            </tr>
          ))}
          {dash.locations.length === 0 && <tr><td colSpan={6} className="py-2 text-gray-500">Brak punktów</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function InvestorOdbiory() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api("/api/investor/collections").then((d) => setRows(d.collections)).catch(() => setRows([])); }, []);
  if (!rows) return <Loading />;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-gray-500 text-xs"><th>Punkt</th><th className="text-right">Opakowania</th><th>Kierowca</th><th className="text-right">Data</th></tr></thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.id} className="border-t border-gray-100">
              <td className="py-1.5">{r.point_id}</td>
              <td className="text-right">{fmtInt(r.packages ?? 0)}</td>
              <td>{r.driver_name ?? "—"}</td>
              <td className="text-right">{r.collected_at ? new Date(r.collected_at).toLocaleString("pl-PL") : "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} className="py-2 text-gray-500">Brak odbiorów</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function InvestorRozliczenia({ overview }: { overview: any }) {
  if (!overview) return <Loading />;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-gray-500 text-xs"><th>Pozycja</th><th className="text-right">Ilość</th><th>Stawka</th><th className="text-right">Netto</th><th className="text-right">Brutto</th></tr></thead>
        <tbody>
          {overview.settlements.map((s: any, i: number) => (
            <tr key={i} className="border-t border-gray-100">
              <td className="py-1.5">{s.party}</td>
              <td className="text-right">{s.count}</td>
              <td>{s.rate_label}</td>
              <td className="text-right">{fmt(s.net_grosze)}</td>
              <td className="text-right">{fmt(s.gross_grosze)}</td>
            </tr>
          ))}
          {overview.settlements.length === 0 && <tr><td colSpan={5} className="py-2 text-gray-500">Brak rozliczeń</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function InvestorFaktury() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api("/api/investor/invoices").then((d) => setRows(d.invoices)).catch(() => setRows([])); }, []);
  if (!rows) return <Loading />;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-gray-500 text-xs"><th>KSeF</th><th>Tytuł</th><th className="text-right">Kwota</th><th>Data</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((f: any) => (
            <tr key={f.id} className="border-t border-gray-100">
              <td className="py-1.5">{f.ksef_number}</td>
              <td>{f.title}</td>
              <td className="text-right">{fmt(f.amount_grosze)}</td>
              <td>{f.issue_date}</td>
              <td>{f.status}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-2 text-gray-500">Brak faktur</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function DriverApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [points, setPoints] = useState<any[]>([]);
  useEffect(() => { api("/api/driver/overview").then((d) => setPoints(d.points)).catch(() => {}); }, []);
  return (
    <div className="max-w-md mx-auto pb-12 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Zlecenia</h2>
        <button onClick={onLogout} className="p-2 hover:bg-gray-100 rounded-md"><Icon d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></button>
      </div>
      <div className="space-y-3">
        {points.map((p) => (
          <div key={p.id} className="bg-white border rounded-lg p-4">
            <div className="font-medium">{p.id} · {p.district}</div>
            <div className="text-sm text-gray-600">Zapełnienie: {p.fill_level}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── PROMPT 9/10: Finanse inwestora (saldo, netting, płatność PolCard sandbox) ─
function InvestorFinanse() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setError(null); setData(await api("/api/investor/finance")); }
    catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Loading />;
  const bal = data.balance;
  const due = bal.grossGrosze < 0 ? -bal.grossGrosze : 0;
  const pay = async () => {
    if (!window.confirm(`Zapłacić ${fmt(due)} przez PolCard (sandbox)?`)) return;
    setBusy(true); setInfo(null);
    try {
      const p: any = await api("/api/investor/payments", { method: "POST" });
      await api(`/api/investor/payments/${p.id}/confirm`, { method: "POST" });
      setInfo(`Płatność ${fmt(p.amountGrosze)} zaksięgowana (PolCard sandbox).`);
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  return (
    <div>
      {error && <ErrorBox message={error} />}
      {info && <div className="mb-4 text-sm bg-green-50 border border-green-200 text-green-800 rounded-lg p-3">{info}</div>}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <KpiCard label="Saldo netto" value={fmt(bal.netGrosze)} sub={bal.netGrosze >= 0 ? "do wypłaty" : "do zapłaty"} />
        <KpiCard label="Saldo brutto" value={fmt(bal.grossGrosze)} sub="uznania − obciążenia" />
        <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col justify-between">
          <div className="text-xs text-gray-500 mb-1">Płatność</div>
          {due > 0 ? (
            <button onClick={pay} disabled={busy} className="text-sm px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-50">
              {busy ? "Przetwarzam…" : `Zapłać ${fmt(due)} (PolCard)`}
            </button>
          ) : (
            <div className="text-sm text-gray-600">Brak zaległości — netting pokrywa opłaty z przychodów kaucyjnych.</div>
          )}
          <div className="text-[10px] text-gray-400 mt-2">Tryb sandbox. Produkcyjnie: PolCard/Fiserv po umowie PSP.</div>
        </div>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-sm mb-3">Wyciąg (ostatnie pozycje)</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th>Typ</th><th>Cykl</th><th>Kierunek</th><th className="text-right">Netto</th><th className="text-right">VAT</th><th className="text-right">Brutto</th><th className="text-right">Data</th></tr></thead>
          <tbody>
            {data.statement.map((s: any) => (
              <tr key={s.id} className="border-t border-gray-100">
                <td className="py-1">{s.entry_type}</td>
                <td>{s.cycle_label ?? "—"}</td>
                <td className={s.direction === "credit" ? "text-green-700" : "text-red-700"}>{s.direction === "credit" ? "uznanie" : "obciążenie"}</td>
                <td className="text-right">{fmt(s.amount_net)}</td>
                <td className="text-right">{fmt(s.vat_amount)}</td>
                <td className="text-right">{fmt(s.amount_gross)}</td>
                <td className="text-right">{new Date(s.booking_date ?? s.created_at).toLocaleDateString("pl-PL")}</td>
              </tr>
            ))}
            {data.statement.length === 0 && <tr><td colSpan={7} className="py-2 text-gray-500">Brak pozycji — naliczenia pojawią się po wygenerowaniu opłat miesięcznych</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-sm mb-3">Historia płatności</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th>ID</th><th className="text-right">Kwota</th><th>Status</th><th>Dostawca</th><th className="text-right">Utworzona</th><th className="text-right">Opłacona</th></tr></thead>
          <tbody>
            {data.payments.map((p: any) => (
              <tr key={p.id} className="border-t border-gray-100">
                <td className="py-1">#{p.id}</td>
                <td className="text-right">{fmt(p.amount_grosze)}</td>
                <td>{p.status === "paid" ? "opłacona" : p.status}</td>
                <td>{p.provider}</td>
                <td className="text-right">{new Date(p.created_at).toLocaleString("pl-PL")}</td>
                <td className="text-right">{p.paid_at ? new Date(p.paid_at).toLocaleString("pl-PL") : "—"}</td>
              </tr>
            ))}
            {data.payments.length === 0 && <tr><td colSpan={6} className="py-2 text-gray-500">Brak płatności</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── PROMPT 9: Umowy inwestora ────────────────────────────────────────────────
function InvestorUmowy() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api("/api/investor/contracts").then(setData).catch(() => setData({ contracts: [], rates: [] })); }, []);
  if (!data) return <Loading />;
  const CONTRACT_TYPES: Record<string, string> = { lease: "Dzierżawa urządzeń", implementation: "Wdrożenie", ipz_operator: "Operator IPZ", service: "Serwis", carrier: "Transport", acquirer: "Płatności" };
  return (
    <div>
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-sm mb-3">Umowy</h3>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500 text-xs"><th>Typ</th><th>Druga strona</th><th>Od</th><th>Do</th><th className="text-right">Okres wypow.</th><th>Status</th></tr></thead>
          <tbody>
            {data.contracts.map((ct: any) => (
              <tr key={ct.id} className="border-t border-gray-100">
                <td className="py-1.5 font-medium">{CONTRACT_TYPES[ct.type] ?? ct.type}</td>
                <td>{ct.party_a_name}</td>
                <td>{new Date(ct.valid_from).toLocaleDateString("pl-PL")}</td>
                <td>{ct.valid_to ? new Date(ct.valid_to).toLocaleDateString("pl-PL") : "bezterminowa"}</td>
                <td className="text-right">{ct.notice_period_days} dni</td>
                <td>{ct.status === "active" ? "aktywna" : ct.status}</td>
              </tr>
            ))}
            {data.contracts.length === 0 && <tr><td colSpan={6} className="py-2 text-gray-500">Brak umów</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-sm mb-3">Stawki (rate cards)</h3>
        <table className="w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th>Umowa</th><th>Pozycja</th><th>Model</th><th className="text-right">Stawka</th><th>Jednostka</th></tr></thead>
          <tbody>
            {data.rates.map((r: any, i: number) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="py-1">#{r.contract_id}</td>
                <td>{r.fraction}</td>
                <td>{r.collection_model}</td>
                <td className="text-right">{r.rate_value}</td>
                <td>{r.rate_unit}</td>
              </tr>
            ))}
            {data.rates.length === 0 && <tr><td colSpan={5} className="py-2 text-gray-500">Brak stawek</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── PROMPT 11: Wiadomości (wspólny wątek per org) ───────────────────────────
function MessageThread({ fetchPath, postPath, postExtra }: { fetchPath: string; postPath: string; postExtra?: any }) {
  const [msgs, setMsgs] = useState<any[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const d: any = await api(fetchPath); setMsgs(d.messages); } catch { setMsgs([]); }
  }, [fetchPath]);
  useEffect(() => { load(); }, [load]);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try { await api(postPath, { method: "POST", body: JSON.stringify({ body, ...(postExtra ?? {}) }) }); setBody(""); await load(); } catch {}
    setBusy(false);
  };
  if (!msgs) return <Loading />;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col" style={{ minHeight: 360 }}>
      <div className="flex-1 space-y-2 mb-3 overflow-y-auto" style={{ maxHeight: 420 }}>
        {msgs.map((m: any) => (
          <div key={m.id} className={`max-w-[75%] rounded-lg p-2.5 text-sm ${m.sender_role === "master" ? "bg-gray-100" : "bg-blue-50 ml-auto"}`}>
            <div className="text-[10px] text-gray-500 mb-0.5">{m.sender_role === "master" ? "Operator" : "Inwestor"} · {new Date(m.created_at).toLocaleString("pl-PL")}</div>
            <div>{m.body}</div>
          </div>
        ))}
        {msgs.length === 0 && <div className="text-sm text-gray-500">Brak wiadomości — napisz pierwszą.</div>}
      </div>
      <div className="flex gap-2">
        <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Napisz wiadomość…" className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm" />
        <button onClick={send} disabled={busy || !body.trim()} className="px-4 py-2 bg-gray-900 text-white rounded-md text-sm hover:bg-gray-700 disabled:opacity-50">Wyślij</button>
      </div>
    </div>
  );
}

function InvestorWiadomosci() {
  return <MessageThread fetchPath="/api/investor/messages" postPath="/api/investor/messages" />;
}

function MasterWiadomosci() {
  const [threads, setThreads] = useState<any[] | null>(null);
  const [orgId, setOrgId] = useState<number | null>(null);
  useEffect(() => { api("/api/admin/messages").then((d: any) => setThreads(d.threads)).catch(() => setThreads([])); }, []);
  if (!threads) return <Loading />;
  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="bg-white border border-gray-200 rounded-lg p-3">
        <h3 className="font-semibold text-sm mb-2">Wątki (inwestorzy)</h3>
        {threads.map((t: any) => (
          <button key={t.org_id} onClick={() => setOrgId(t.org_id)} className={`w-full text-left p-2 rounded-md text-sm mb-1 ${orgId === t.org_id ? "bg-gray-900 text-white" : "hover:bg-gray-50"}`}>
            <div className="font-medium">{t.name}</div>
            <div className={`text-xs ${orgId === t.org_id ? "text-gray-300" : "text-gray-500"}`}>{t.total} wiad.{Number(t.unread) > 0 ? ` · ${t.unread} nieprzecz.` : ""}</div>
          </button>
        ))}
      </div>
      <div className="col-span-2">
        {orgId ? (
          <MessageThread key={orgId} fetchPath={`/api/admin/messages?orgId=${orgId}`} postPath="/api/admin/messages" postExtra={{ orgId }} />
        ) : (
          <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg p-6 text-center">Wybierz wątek</div>
        )}
      </div>
    </div>
  );
}


// ─── PROMPT 12: Dokumenty (archiwum, wzór eMieszkaniec) ──────────────────────
const DOC_CAT_LABELS: Record<string, string> = { umowa: "Umowa", protokol: "Protokół", regulamin: "Regulamin", sprawozdanie: "Sprawozdanie", inne: "Inne" };
const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function DocTable({ docs, showOrg, onDelete }: { docs: any[]; showOrg?: boolean; onDelete?: (id: number) => void }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-gray-500 text-xs"><th>Tytuł</th><th>Kategoria</th>{showOrg && <th>Odbiorca</th>}<th>Plik</th><th className="text-right">Rozmiar</th><th className="text-right">Data</th><th></th></tr></thead>
      <tbody>
        {docs.map((d: any) => (
          <tr key={d.id} className="border-t border-gray-100">
            <td className="py-1.5 font-medium">{d.title}</td>
            <td>{DOC_CAT_LABELS[d.category] ?? d.category}</td>
            {showOrg && <td>{d.org_name ?? "Wszyscy inwestorzy"}</td>}
            <td><a href={`/api/documents/${d.id}/download`} target="_blank" className="text-brand-blue hover:underline">{d.filename}</a></td>
            <td className="text-right">{fmtBytes(Number(d.size_bytes))}</td>
            <td className="text-right">{new Date(d.created_at).toLocaleDateString("pl-PL")}</td>
            <td className="text-right">{onDelete && <button onClick={() => onDelete(d.id)} className="text-xs text-red-600 hover:underline">Usuń</button>}</td>
          </tr>
        ))}
        {docs.length === 0 && <tr><td colSpan={showOrg ? 7 : 6} className="py-2 text-gray-500">Brak dokumentów</td></tr>}
      </tbody>
    </table>
  );
}

function MasterDokumenty() {
  const [docs, setDocs] = useState<any[] | null>(null);
  const [orgs, setOrgs] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("umowa");
  const [orgId, setOrgId] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [d, t]: any[] = await Promise.all([api("/api/admin/documents"), api("/api/admin/messages")]);
      setDocs(d.documents); setOrgs(t.threads);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const upload = async () => {
    if (!file || !title.trim()) { setError("Podaj tytuł i wybierz plik."); return; }
    if (file.size > 6_000_000) { setError("Plik przekracza limit 6 MB."); return; }
    setBusy(true); setError(null); setInfo(null);
    try {
      const buf = await file.arrayBuffer();
      let bin = ""; const arr = new Uint8Array(buf);
      for (let i = 0; i < arr.length; i += 32768) bin += String.fromCharCode(...arr.subarray(i, i + 32768));
      await api("/api/admin/documents", {
        method: "POST",
        body: JSON.stringify({ orgId: orgId ? Number(orgId) : null, title, category, filename: file.name, mimeType: file.type || "application/octet-stream", contentBase64: btoa(bin) }),
      });
      setInfo(`Dokument „${title}” zapisany.`); setTitle(""); setFile(null);
      await load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const remove = async (id: number) => {
    if (!window.confirm("Usunąć dokument?")) return;
    try { await api(`/api/admin/documents/${id}`, { method: "DELETE" }); await load(); } catch (e: any) { setError(e.message); }
  };
  if (!docs) return <Loading />;
  return (
    <div>
      {error && <ErrorBox message={error} />}
      {info && <div className="mb-4 text-sm bg-green-50 border border-green-200 text-green-800 rounded-lg p-3">{info}</div>}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-sm mb-3">Dodaj dokument (max 6 MB)</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tytuł dokumentu" className="border border-gray-300 rounded-md px-3 py-2 text-sm" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="border border-gray-300 rounded-md px-3 py-2 text-sm">
            {Object.entries(DOC_CAT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="border border-gray-300 rounded-md px-3 py-2 text-sm">
            <option value="">Wszyscy inwestorzy</option>
            {orgs.map((o: any) => <option key={o.org_id} value={o.org_id}>{o.name}</option>)}
          </select>
          <input type="file" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} className="text-sm" />
        </div>
        <button onClick={upload} disabled={busy} className="mt-3 px-4 py-2 bg-gray-900 text-white rounded-md text-sm hover:bg-gray-700 disabled:opacity-50">{busy ? "Wysyłam…" : "Zapisz dokument"}</button>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-sm mb-3">Archiwum</h3>
        <DocTable docs={docs} showOrg onDelete={remove} />
      </div>
    </div>
  );
}

function InvestorDokumenty() {
  const [docs, setDocs] = useState<any[] | null>(null);
  useEffect(() => { api("/api/investor/documents").then((d: any) => setDocs(d.documents)).catch(() => setDocs([])); }, []);
  if (!docs) return <Loading />;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="font-semibold text-sm mb-3">Dokumenty (Twoje + ogólne)</h3>
      <DocTable docs={docs} />
    </div>
  );
}

// ─── PROMPT 12: Sprawozdania miesięczne ──────────────────────────────────────
function InvestorSprawozdania() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const d: any = await api("/api/investor/statements"); setRows(d.periods); } catch (e: any) { setError(e.message); setRows([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const accept = async (period: string) => {
    if (!window.confirm(`Akceptujesz rozliczenie za ${period}?`)) return;
    try { await api(`/api/investor/statements/${period}/accept`, { method: "POST" }); await load(); } catch (e: any) { setError(e.message); }
  };
  if (!rows) return <Loading />;
  return (
    <div>
      {error && <ErrorBox message={error} />}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-semibold text-sm mb-3">Rozliczenia miesięczne</h3>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500 text-xs"><th>Okres</th><th className="text-right">Pozycje</th><th className="text-right">Saldo netto</th><th>Status</th><th className="text-right">Akcje</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.period} className="border-t border-gray-100">
                <td className="py-1.5 font-medium">{r.period}</td>
                <td className="text-right">{r.entries}</td>
                <td className={`text-right ${Number(r.net) >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(Number(r.net))}</td>
                <td>{r.accepted_at ? <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">zaakceptowane</span> : <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full">oczekuje</span>}</td>
                <td className="text-right space-x-2">
                  <a href={`/api/investor/statements/${r.period}/html`} target="_blank" className="text-brand-blue hover:underline text-xs">Otwórz</a>
                  {!r.accepted_at && <button onClick={() => accept(r.period)} className="text-xs px-2 py-1 bg-gray-900 text-white rounded hover:bg-gray-700">Akceptuję</button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="py-2 text-gray-500">Brak rozliczeń — pojawią się po naliczeniach lub zamknięciu cyklu</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MasterSprawozdania() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api("/api/admin/statements").then((d: any) => setRows(d.statements)).catch(() => setRows([])); }, []);
  if (!rows) return <Loading />;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="font-semibold text-sm mb-3">Sprawozdania inwestorów (status akceptacji)</h3>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-gray-500 text-xs"><th>Okres</th><th>Inwestor</th><th className="text-right">Pozycje</th><th className="text-right">Saldo netto</th><th>Status</th><th className="text-right">Podgląd</th></tr></thead>
        <tbody>
          {rows.map((r: any, i: number) => (
            <tr key={i} className="border-t border-gray-100">
              <td className="py-1.5 font-medium">{r.period}</td>
              <td>{r.org_name}</td>
              <td className="text-right">{r.entries}</td>
              <td className={`text-right ${Number(r.net) >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(Number(r.net))}</td>
              <td>{r.accepted_at ? <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">zaakceptowane {new Date(Number(r.accepted_at)).toLocaleDateString("pl-PL")}</span> : <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full">oczekuje</span>}</td>
              <td className="text-right"><a href={`/api/admin/statements/${r.org_id}/${r.period}/html`} target="_blank" className="text-brand-blue hover:underline text-xs">Otwórz</a></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="py-2 text-gray-500">Brak danych</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
