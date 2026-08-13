// Sprint 2 PROMPT 0 — handler module.
// Differences from edrs-mvp:
//   - All routes wrapped in `createApp()` so tests can instantiate fresh with a mock env.
//   - Auth helpers imported from lib/auth (PROMPT 0: no query param, idle timeout, cookie helpers).
//   - Session INSERT includes `last_activity_at` for 12h idle clock.
//   - Default export wraps createApp() with Cloudflare env binding.
//   - Business logic and pricing constants unchanged (PROMPT 1 will refactor those to rate_cards).

import type { AppHandler, AppCtx } from "@sauna/apps-runtime";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  verifyPassword, newToken, hashPassword,
  SESSION_COOKIE, SESSION_DAYS, APP_USER_KEY, AppUser, requireRole,
  resolveSession, setSessionCookie, clearSessionCookie,
} from "./lib/auth";
import { ensureSeeded, reseed } from "./lib/seed";
import { parseCsv, validateCredits, validateReceipts, validateCollections } from "./lib/csv";
import { runSettlementEngine, approveCycle, reopenCycle, getLedgerForCycle, insertLedgerEntry } from "./lib/settlement";
import { runFullReconciliation, transitionDisputeState, executeDefaultAction, getAlertLevel, isOverdue, businessDaysBetween } from "./lib/reconciliation";
import { buildEventStream, mapSnapshot, parseCats, resolveCursor, emitEvent as emitRealtimeEvent, emitLocationUpdate } from "./lib/realtime";
import { runAllAgents } from "./lib/agents";
import { investorBalance, investorStatement, paymentsFor, createPayment, confirmPayment, generateMonthlyCharges } from "./lib/finance";
import { saveDocument, readDocument, listDocuments, statementPeriods, renderStatementHtml, acceptStatement, DOC_CATEGORIES, MAX_DOC_BYTES } from "./lib/documents";
import { renderRegulamin, renderPolitykaPrywatnosci } from "./lib/legal";
import { getSettlementManifest, bankDataRoomPackage, recordDriverJobEvent } from "./lib/mvp";
import { energyDashboard, validateEnergyInvoice, seedEnergyDemo } from "./lib/energy";

type Bindings = { sql: any; websocket: any; ctx: AppCtx };


// PROMPT 6.4 — pagination helpers (limit/offset/sort + standard {items,total,hasMore} response).
// Backward-compat: stare endpointy bez ?limit=&offset=&sort= dalej zwracają pełne listy.
function parsePagination(c: any): { limit: number; offset: number; sort: string | null } {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
  return {
    limit: Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200),
    offset: Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
    sort: c.req.query("sort") || null,
  };
}
function paginatedResponse(items: any[], total: number, limit: number, offset: number) {
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

// NOTE: PROMPT 0 scope = auth fix only. These pricing constants will move to
// rate_cards in PROMPT 1. Do not touch in this commit.
const PLATFORM_FEE_PER_POINT_GROSZE = 50000;
const DRIVER_MODULE_PER_VEHICLE_GROSZE = 22000;
const RECONCILIATION_THRESHOLD_PCT = 2.0;

export function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>();

  function logEvent(env: any, ev: { cycleId?: number | null; pointId?: string | null; eventType: string; payload?: any; actorId?: number | null }) {
    env.sql.exec(
      "INSERT INTO event_log (cycle_id, point_id, event_type, payload_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [ev.cycleId ?? null, ev.pointId ?? null, ev.eventType, ev.payload ? JSON.stringify(ev.payload) : null, ev.actorId ?? null, Date.now()]
    );
  }

  app.use("/api/*", async (c, next) => {
    // PROMPT 7: bypass ensureSeeded na hot path SSE. Co 3 s EventSource reconnect
    // odpalałby 7 backfill probes per otwarta zakładka — czysty facet load dla niczego.
    if (c.req.path === "/api/admin/events/stream") return next();
    await ensureSeeded(c.env);
    await next();
  });

  const ANON_PATHS = new Set(["/api/me", "/api/auth/login", "/api/auth/signup"]);
  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    const isAnon = ANON_PATHS.has(path) || path.startsWith("/api/invites/");
    if (isAnon) return next();
    const user = await resolveSession(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set(APP_USER_KEY, user);
    await next();
  });

  app.get("/api/me", async (c) => {
    const user = c.get(APP_USER_KEY);
    if (!user) return c.json({ user: null });
    return c.json({ user });
  });

  app.post("/api/auth/login", async (c) => {
    const { email, password } = await c.req.json<{ email: string; password: string }>();
    if (!email || !password) return c.json({ error: "missing_fields" }, 400);
    const rows = c.env.sql.query<{ id: number; email: string; name: string; role: string; investor_id: number | null; driver_id: number | null; password_hash: string; salt: string }>(
      "SELECT id, email, name, role, investor_id, driver_id, password_hash, salt FROM users WHERE email = ?",
      [email.toLowerCase()]
    );
    if (rows.length === 0) return c.json({ error: "invalid_credentials" }, 401);
    const u = rows[0];
    const ok = await verifyPassword(password, u.salt, u.password_hash);
    if (!ok) return c.json({ error: "invalid_credentials" }, 401);
    // PROMPT 0: token rotation. Fresh token per login — no reuse of any prior session.
    const token = newToken();
    const now = Date.now();
    const expires = now + SESSION_DAYS * 86400000;
    // last_activity_at set to `now` — idle clock starts here.
    c.env.sql.exec(
      "INSERT INTO sessions (token, user_id, expires_at, last_activity_at, created_at) VALUES (?, ?, ?, ?, ?)",
      [token, u.id, expires, now, now]
    );
    // PROMPT 0: httpOnly + Secure + SameSite=Lax. NO query param fallback (see auth.ts).
    setSessionCookie(c, token);
    return c.json({
      user: { id: u.id, email: u.email, name: u.name, role: u.role, investorId: u.investor_id, driverId: u.driver_id }
    });
  });

  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) c.env.sql.exec("DELETE FROM sessions WHERE token = ?", [token]);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/api/invites/:token", async (c) => {
    const token = c.req.param("token");
    const rows = c.env.sql.query<{ role: string; label: string; status: string }>(
      "SELECT role, label, status FROM invites WHERE token = ?",
      [token]
    );
    if (rows.length === 0) return c.json({ error: "not_found" }, 404);
    const inv = rows[0];
    if (inv.status !== "pending") return c.json({ error: "already_used" }, 410);
    return c.json({ role: inv.role, label: inv.label });
  });

  app.post("/api/auth/signup", async (c) => {
    const { token, email, name, password } = await c.req.json<{ token: string; email: string; name: string; password: string }>();
    if (!token || !email || !name || !password) return c.json({ error: "missing_fields" }, 400);
    if (password.length < 6) return c.json({ error: "password_too_short" }, 400);
    const invRows = c.env.sql.query<{ id: number; role: string; label: string; status: string; investor_id: number | null; driver_id: number | null }>(
      "SELECT id, role, label, status, investor_id, driver_id FROM invites WHERE token = ?",
      [token]
    );
    if (invRows.length === 0) return c.json({ error: "invalid_invite" }, 400);
    const inv = invRows[0];
    if (inv.status !== "pending") return c.json({ error: "invalid_invite" }, 400);
    const exists = c.env.sql.query<{ id: number }>("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
    if (exists.length > 0) return c.json({ error: "email_taken" }, 409);
    const pwd = await hashPassword(password);
    c.env.sql.exec(
      "INSERT INTO users (email, name, role, password_hash, salt, investor_id, driver_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [email.toLowerCase(), name, inv.role, pwd.hash, pwd.salt, inv.investor_id, inv.driver_id, "active", Date.now()]
    );
    const userId = Number(c.env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
    if (inv.role === "investor" && inv.investor_id) c.env.sql.exec("UPDATE investors SET status='active' WHERE id = ?", [inv.investor_id]);
    if (inv.role === "driver" && inv.driver_id) c.env.sql.exec("UPDATE drivers SET status='active' WHERE id = ?", [inv.driver_id]);
    c.env.sql.exec("UPDATE invites SET status='used', used_at=? WHERE id = ?", [Date.now(), inv.id]);
    const sessionToken = newToken();
    const now = Date.now();
    const expires = now + SESSION_DAYS * 86400000;
    c.env.sql.exec(
      "INSERT INTO sessions (token, user_id, expires_at, last_activity_at, created_at) VALUES (?, ?, ?, ?, ?)",
      [sessionToken, userId, expires, now, now]
    );
    setSessionCookie(c, sessionToken);
    return c.json({
      user: { id: userId, email: email.toLowerCase(), name, role: inv.role, investorId: inv.investor_id, driverId: inv.driver_id }
    });
  });

  const requireMaster = requireRole("master");
  const requireInvestor = requireRole("investor");
  const requireDriver = requireRole("driver");
  const requireMasterOrInvestor = requireRole("master", "investor");

  // PROMPT 8: mapowanie legacy investors.id → organizations.id. Seed PROMPT 1 celowo
  // trzyma IDENTYCZNE nazwy w obu tabelach — join po nazwie, bez magic numbers.
  function investorOrgIdOf(env: any, investorId: number | null): number | null {
    if (!investorId) return null;
    const r = env.sql.query<{ id: number }>(
      "SELECT o.id FROM organizations o JOIN investors i ON i.name = o.name WHERE i.id = ? LIMIT 1",
      [investorId]
    );
    return r[0]?.id ?? null;
  }

  app.get("/api/admin/overview", requireMaster, async (c) => {
    const investorCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM investors WHERE status='active'")[0].n);
    const driverCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM drivers WHERE status='active'")[0].n);
    const pointCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM points")[0].n);
    const packagesMonth = Number(c.env.sql.query<{ value: string }>("SELECT value FROM meta WHERE key='packagesMonth'")[0].value);
    const collectionsMonth = Number(c.env.sql.query<{ value: string }>("SELECT value FROM meta WHERE key='collectionsMonth'")[0].value);
    const platformFee = pointCount * PLATFORM_FEE_PER_POINT_GROSZE;
    const driverModuleFee = driverCount * DRIVER_MODULE_PER_VEHICLE_GROSZE;
    const monthlyRecurring = platformFee + driverModuleFee;
    return c.json({
      investorsCount: investorCount,
      driversCount: driverCount,
      pointsCount: pointCount,
      packagesMonth,
      collectionsMonth,
      platformFeeGrosze: platformFee,
      driverModuleFeeGrosze: driverModuleFee,
      monthlyRecurringGrosze: monthlyRecurring,
      arrEstimateGrosze: monthlyRecurring * 12
    });
  });

  app.get("/api/admin/investors", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      "SELECT i.id, i.name, i.type, i.status, (SELECT COUNT(*) FROM points WHERE investor_id = i.id) AS point_count FROM investors i ORDER BY i.id"
    );
    return c.json({ investors: rows });
  });

  app.get("/api/admin/drivers", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      "SELECT d.id, d.name, d.type, d.company, d.bdo_number, d.bdo_verified, d.gps_id, d.status, " +
      "(SELECT COUNT(*) FROM collections WHERE driver_id = d.id AND status='completed') AS collection_count " +
      "FROM drivers d ORDER BY d.id"
    );
    return c.json({ drivers: rows });
  });

  app.get("/api/admin/points", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      "SELECT p.id, p.address, p.district, p.fill_level, p.status, p.last_collection_at, p.monthly_packages, i.name AS investor_name " +
      "FROM points p JOIN investors i ON i.id = p.investor_id ORDER BY p.id"
    );
    return c.json({ points: rows });
  });

  app.get("/api/admin/invites", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>("SELECT id, token, role, label, status, created_at FROM invites ORDER BY created_at DESC");
    return c.json({ invites: rows });
  });

  app.post("/api/admin/invites", requireMaster, async (c) => {
    const { role, label, type } = await c.req.json<{ role: "investor" | "driver"; label: string; type?: string }>();
    if (!role || !label) return c.json({ error: "missing_fields" }, 400);
    if (role !== "investor" && role !== "driver") return c.json({ error: "invalid_role" }, 400);
    const me = c.get(APP_USER_KEY);
    const now = Date.now();
    let investorId: number | null = null;
    let driverId: number | null = null;
    if (role === "investor") {
      const invType = type || "wspolnota";
      c.env.sql.exec("INSERT INTO investors (name, type, status, created_at) VALUES (?, ?, ?, ?)", [label, invType, "pending", now]);
      investorId = Number(c.env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
    } else {
      c.env.sql.exec("INSERT INTO drivers (name, type, company, status, created_at) VALUES (?, ?, ?, ?, ?)", [label, "firma", null, "pending", now]);
      driverId = Number(c.env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
    }
    const token = newToken(24);
    c.env.sql.exec(
      "INSERT INTO invites (token, role, label, investor_id, driver_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [token, role, label, investorId, driverId, "pending", me.id, now]
    );
    const url = `${new URL(c.req.url).origin}/?invite=${token}`;
    return c.json({ token, url, role, label });
  });

  app.get("/api/admin/cycles", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      "SELECT id, label, period_start, period_end, status, closed_at, created_at FROM settlement_cycles ORDER BY period_start DESC"
    );
    return c.json({ cycles: rows });
  });

  app.post("/api/admin/cycles", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const body = await c.req.json<{ label: string; periodStart: number; periodEnd: number }>();
    if (!body.label || !body.periodStart || !body.periodEnd) return c.json({ error: "missing_fields" }, 400);
    try {
      c.env.sql.exec(
        "INSERT INTO settlement_cycles (label, period_start, period_end, status, created_at, created_by) VALUES (?, ?, ?, 'open', ?, ?)",
        [body.label, body.periodStart, body.periodEnd, Date.now(), me.id]
      );
    } catch (e: any) {
      return c.json({ error: "duplicate_label" }, 400);
    }
    const id = Number(c.env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
    logEvent(c.env, { cycleId: id, eventType: "cycle_created", payload: { label: body.label }, actorId: me.id });
    return c.json({ ok: true, id });
  });

  type ReconcileRow = {
    point_id: string; address: string; district: string;
    investor_id: number; investor_name: string;
    device_count: number; sorter_count: number; operator_count: number;
    variance_pct: number; sources_present: number;
    status: "reconciled" | "disputed" | "incomplete";
    amount_grosze: number;
  };

  function runReconciliation(env: any, cycleId: number, cycle: any): ReconcileRow[] {
    const points = env.sql.query<any>("SELECT p.id, p.address, p.district, p.investor_id, i.name AS investor_name FROM points p JOIN investors i ON i.id = p.investor_id");
    const out: ReconcileRow[] = [];
    for (const p of points) {
      const dc = env.sql.query<{ n: number }>(
        "SELECT COALESCE(SUM(packages), 0) AS n FROM collections WHERE point_id = ? AND status='completed' AND collected_at BETWEEN ? AND ?",
        [p.id, cycle.period_start, cycle.period_end]
      );
      const sc = env.sql.query<{ n: number }>(
        "SELECT COALESCE(SUM(packages), 0) AS n FROM sorter_receipts WHERE cycle_id = ? AND point_id = ?",
        [cycleId, p.id]
      );
      const oc = env.sql.query<{ n: number; amount: number }>(
        "SELECT COALESCE(SUM(packages), 0) AS n, COALESCE(SUM(amount_grosze), 0) AS amount FROM operator_credits WHERE cycle_id = ? AND point_id = ?",
        [cycleId, p.id]
      );
      const device = Number(dc[0]?.n ?? 0);
      const sorter = Number(sc[0]?.n ?? 0);
      const operator = Number(oc[0]?.n ?? 0);
      const operatorAmount = Number(oc[0]?.amount ?? 0);
      const sourcesPresent = (device > 0 ? 1 : 0) + (sorter > 0 ? 1 : 0) + (operator > 0 ? 1 : 0);
      let status: "reconciled" | "disputed" | "incomplete" = "incomplete";
      let variancePct = 0;
      if (sourcesPresent === 3) {
        const vals = [device, sorter, operator];
        const max = Math.max(...vals);
        const min = Math.min(...vals);
        const avg = vals.reduce((a, b) => a + b, 0) / 3;
        variancePct = avg > 0 ? ((max - min) / avg) * 100 : 0;
        status = variancePct > RECONCILIATION_THRESHOLD_PCT ? "disputed" : "reconciled";
      }
      out.push({
        point_id: p.id, address: p.address, district: p.district,
        investor_id: p.investor_id, investor_name: p.investor_name,
        device_count: device, sorter_count: sorter, operator_count: operator,
        variance_pct: Math.round(variancePct * 100) / 100,
        sources_present: sourcesPresent, status, amount_grosze: operatorAmount
      });
    }
    return out;
  }

  app.get("/api/admin/cycles/:id", requireMaster, async (c) => {
    const id = Number(c.req.param("id"));
    const cycles = c.env.sql.query<any>("SELECT id, label, period_start, period_end, status, closed_at, created_at FROM settlement_cycles WHERE id = ?", [id]);
    if (cycles.length === 0) return c.json({ error: "not_found" }, 404);
    const cycle = cycles[0];
    const recon = runReconciliation(c.env, id, cycle);
    const hasDisputed = recon.some((r) => r.status === "disputed");
    const hasIncomplete = recon.some((r) => r.status === "incomplete");
    let computedStatus = cycle.status;
    if (hasDisputed) computedStatus = "disputed";
    else if (hasIncomplete) computedStatus = "reconciling";
    else if (recon.length > 0) computedStatus = "reconciled";
    const events = c.env.sql.query<any>(
      "SELECT id, point_id, event_type, payload_json, actor_id, created_at FROM event_log WHERE cycle_id = ? ORDER BY created_at ASC",
      [id]
    );
    return c.json({ cycle: { ...cycle, status: computedStatus }, points: recon, events });
  });

  app.post("/api/admin/cycles/:id/reconcile", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const cycles = c.env.sql.query<any>("SELECT id, period_start, period_end, status FROM settlement_cycles WHERE id = ?", [id]);
    if (cycles.length === 0) return c.json({ error: "not_found" }, 404);
    const cycle = cycles[0];
    const recon = runReconciliation(c.env, id, cycle);
    const disputed = recon.filter((r) => r.status === "disputed");
    const reconciled = recon.filter((r) => r.status === "reconciled");
    const incomplete = recon.filter((r) => r.status === "incomplete");
    let newStatus = "reconciling";
    if (disputed.length > 0) newStatus = "disputed";
    else if (incomplete.length === 0 && recon.length > 0) newStatus = "reconciled";
    c.env.sql.exec("UPDATE settlement_cycles SET status = ? WHERE id = ?", [newStatus, id]);
    logEvent(c.env, { cycleId: id, eventType: "reconciliation_run", payload: { reconciled: reconciled.length, disputed: disputed.length, incomplete: incomplete.length }, actorId: me.id });
    for (const r of disputed) {
      logEvent(c.env, { cycleId: id, pointId: r.point_id, eventType: "ticket_opened", payload: { variance_pct: r.variance_pct, device: r.device_count, sorter: r.sorter_count, operator: r.operator_count }, actorId: me.id });
    }
    for (const r of reconciled) {
      logEvent(c.env, { cycleId: id, pointId: r.point_id, eventType: "reconciled", payload: { device: r.device_count, sorter: r.sorter_count, operator: r.operator_count }, actorId: me.id });
    }
    return c.json({ ok: true, status: newStatus, reconciled: reconciled.length, disputed: disputed.length, incomplete: incomplete.length });
  });

  app.post("/api/admin/cycles/:id/close", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const cycles = c.env.sql.query<any>("SELECT id, status FROM settlement_cycles WHERE id = ?", [id]);
    if (cycles.length === 0) return c.json({ error: "not_found" }, 404);
    c.env.sql.exec("UPDATE settlement_cycles SET status = 'closed', closed_at = ? WHERE id = ?", [Date.now(), id]);
    logEvent(c.env, { cycleId: id, eventType: "cycle_closed", actorId: me.id });
    return c.json({ ok: true });
  });

  app.post("/api/admin/cycles/:id/ticket/:pointId/resolve", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const pointId = c.req.param("pointId");
    const body = await c.req.json<{ note?: string }>().catch(() => ({} as any));
    logEvent(c.env, { cycleId: id, pointId, eventType: "ticket_resolved", payload: { note: body.note ?? "" }, actorId: me.id });
    const cycles = c.env.sql.query<any>("SELECT id, period_start, period_end, status FROM settlement_cycles WHERE id = ?", [id]);
    if (cycles.length > 0) {
      const recon = runReconciliation(c.env, id, cycles[0]);
      const stillDisputed = recon.filter((r) => r.status === "disputed");
      if (stillDisputed.length === 0) {
        const incomplete = recon.filter((r) => r.status === "incomplete");
        c.env.sql.exec("UPDATE settlement_cycles SET status = ? WHERE id = ?", [incomplete.length > 0 ? "reconciling" : "reconciled", id]);
      }
    }
    return c.json({ ok: true });
  });

  // ─── PROMPT 3: Settlement engine + ledger endpoints ──────────────────────────────

  app.post("/api/admin/cycles/:id/run-engine", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const cycles = c.env.sql.query<any>("SELECT id, label, period_start, period_end, status FROM settlement_cycles WHERE id = ?", [id]);
    if (cycles.length === 0) return c.json({ error: "not_found" }, 404);
    const cycle = cycles[0];

    // Set status to draft if it's open/reconciling/reconciled (can recompute in draft)
    if (cycle.status === "open" || cycle.status === "reconciling" || cycle.status === "reconciled" || cycle.status === "reopened") {
      c.env.sql.exec("UPDATE settlement_cycles SET status = 'draft' WHERE id = ?", [id]);
    }

    const result = await runSettlementEngine(c.env, id, cycle);
    logEvent(c.env, { cycleId: id, eventType: "settlement_engine_run", payload: { entriesCreated: result.entriesCreated, partySummary: result.partySummary, errors: result.errors }, actorId: me.id });
    // PROMPT 7: per-party emit "cycle.credit_posted" — toast na mapie gdy engine
    // rozlicza kaucję. Defensive shape: partySummary może być array albo object.
    try {
      const ps: any = (result as any)?.partySummary;
      if (ps && typeof ps === "object") {
        const entries: any[] = Array.isArray(ps)
          ? ps
          : Object.entries(ps).map(([party, v]: any) => ({ party, ...(v as any) }));
        for (const p of entries) {
          emitRealtimeEvent(c.env, {
            eventType: "cycle.credit_posted",
            cycleId: id,
            payload: {
              party: String(p.orgName ?? p.party ?? p.name ?? "—"),
              amountNetGrosze: Number(p.netGrosze ?? p.amountNet ?? 0),
              cycleLabel: cycle.label,
            },
            actorId: me.id,
          });
        }
      }
    } catch (e: any) {
      console.error("[run-engine] credit emit failed:", e?.message ?? String(e));
    }
    return c.json({ ok: true, ...result });
  });

  app.post("/api/admin/cycles/:id/approve", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const result = approveCycle(c.env, id, me.id);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.post("/api/admin/cycles/:id/reopen", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const result = reopenCycle(c.env, id, me.id);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true, reversalsCreated: result.reversalsCreated });
  });

  app.get("/api/admin/cycles/:id/ledger", requireMaster, async (c) => {
    const id = Number(c.req.param("id"));
    const result = getLedgerForCycle(c.env, id);
    return c.json(result);
  });

  // ─── PROMPT 4: Reconciliation + Disputes endpoints ───────────────────────────────

  app.post("/api/admin/cycles/:id/run-reconciliation", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const cycles = c.env.sql.query<any>("SELECT id, label, period_start, period_end, status FROM settlement_cycles WHERE id = ?", [id]);
    if (cycles.length === 0) return c.json({ error: "not_found" }, 404);
    const cycle = cycles[0];

    // Próg 2% — w przyszłości z rate_cards per kontrakt. Na teraz hardcoded w reconciliation.ts (zmienna, nie stała w logice rozliczeń).
    const thresholdPct = RECONCILIATION_THRESHOLD_PCT;

    // Wyczyść stare rekoncyliacje dla tego cyklu
    c.env.sql.exec("DELETE FROM disputes WHERE reconciliation_id IN (SELECT id FROM reconciliations WHERE cycle_id = ?)", [id]);
    c.env.sql.exec("DELETE FROM reconciliations WHERE cycle_id = ?", [id]);

    const result = runFullReconciliation(c.env, id, cycle, thresholdPct);
    logEvent(c.env, { cycleId: id, eventType: "reconciliation_3source_run", payload: result, actorId: me.id });
    return c.json({ ok: true, ...result });
  });

  app.get("/api/admin/cycles/:id/reconciliations", requireMaster, async (c) => {
    const id = Number(c.req.param("id"));
    const rows = c.env.sql.query<any>(
      "SELECT r.id, r.cycle_id, r.scope_type, r.scope_ref, r.source_a_json, r.source_b_json, r.source_c_json, " +
      "r.delta_ab, r.delta_bc, r.delta_ac, r.delta_pct, r.status, r.created_at " +
      "FROM reconciliations r WHERE r.cycle_id = ? ORDER BY r.delta_pct DESC",
      [id]
    );
    return c.json({ reconciliations: rows });
  });

  app.get("/api/admin/disputes", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      "SELECT d.id, d.reconciliation_id, d.state, d.due_at, d.evidence_json, d.disputed_amount_grosze, " +
      "d.outcome, d.default_action_taken, d.created_at, d.updated_at, " +
      "r.scope_ref, r.delta_pct, r.status AS recon_status, " +
      "c.label AS cycle_label " +
      "FROM disputes d " +
      "JOIN reconciliations r ON r.id = d.reconciliation_id " +
      "LEFT JOIN settlement_cycles c ON c.id = r.cycle_id " +
      "ORDER BY d.due_at ASC"
    );
    // Dodaj alertLevel per dispute
    const enriched = rows.map((d: any) => {
      const dueAt = new Date(d.due_at);
      const alertLevel = getAlertLevel(dueAt);
      const remainingDays = businessDaysBetween(new Date(), dueAt);
      return { ...d, alertLevel, remainingDays: Math.max(0, remainingDays), isOverdue: isOverdue(dueAt) };
    });
    return c.json({ disputes: enriched });
  });

  app.post("/api/admin/disputes/:id/transition", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const { newState, evidence } = await c.req.json<{ newState: string; evidence?: string }>();
    if (!newState) return c.json({ error: "missing_new_state" }, 400);
    const result = transitionDisputeState(c.env, id, newState, me.id, evidence);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.post("/api/admin/disputes/:id/default-action", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    const result = executeDefaultAction(c.env, id, me.id);
    if (!result.ok) return c.json({ error: result.action }, 400);
    return c.json({ ok: true, action: result.action });
  });

  app.get("/api/admin/events", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      "SELECT e.id, e.cycle_id, e.point_id, e.event_type, e.payload_json, e.actor_id, e.created_at, " +
      "c.label AS cycle_label FROM event_log e LEFT JOIN settlement_cycles c ON c.id = e.cycle_id " +
      "ORDER BY e.created_at DESC LIMIT 200"
    );
    return c.json({ events: rows });
  });

  // ─── PROMPT 8: agenci wewnętrzni ────────────────────────────────────────
  // Deterministyczna automatyzacja (zero LLM w pętli): health check, data quality
  // (hash chain ledgera), dispute deadlines. Cron co godzinę (onSchedule) + ręczny
  // trigger na demo/debug. Każdy run audytowalny w event_log (agent.run_completed).
  app.post("/api/admin/agents/run", requireMaster, async (c) => {
    const { results, bucket } = await runAllAgents(c.env, { force: true });
    return c.json({ ok: true, bucket, results });
  });

  app.get("/api/admin/agents/status", requireMaster, async (c) => {
    const runs = c.env.sql.query<any>(
      "SELECT id, payload_json, source, created_at FROM event_log WHERE event_type = 'agent.run_completed' ORDER BY id DESC LIMIT 30"
    );
    const metaRows = c.env.sql.query<any>("SELECT key, value FROM meta WHERE key LIKE 'agent:%'");
    return c.json({ runs, meta: metaRows });
  });

  // ─── PROMPT 7: Realtime (SSE) ───────────────────────────────────────────────
  // Micro-burst SSE: jedno połączenie = jeden query + flush + close. EventSource
  // sam się reconnectuje po `retry: 3000` ms z Last-Event-ID. Bez setTimeout/setInterval
  // (banned w runtime, patrz references/handler-runtime.md).
  // PROMPT 8: requireMasterOrInvestor + scoping per investor_org_id. Master widzi
  // wszystko; inwestor wyłącznie eventy własnych punktów (point_id IN własne locations).
  // Eventy globalne bez point_id (cykle) nie są streamowane do inwestora — przychód
  // inwestor czyta z REST /api/investor/dashboard, nie ze streamu.
  app.get("/api/admin/events/stream", requireMasterOrInvestor, async (c) => {
    try {
      const me = c.get(APP_USER_KEY);
      const orgId = me.role === "investor" ? investorOrgIdOf(c.env, me.investorId) : null;
      if (me.role === "investor" && !orgId) return c.json({ error: "no_org_mapping" }, 403);
      const cats = parseCats(c.req.query("type"));
      const replayRaw = parseInt(c.req.query("replay") ?? "0", 10);
      const replay = Number.isFinite(replayRaw) && replayRaw > 0 ? Math.min(replayRaw, 500) : 0;
      const cursor = resolveCursor(c.env, {
        lastEventId: c.req.header("last-event-id"),
        sinceId: c.req.query("sinceId"),
        since: c.req.query("since"),
      });
      return buildEventStream(c.env, { cursor, cats, replay, orgId });
    } catch (e: any) {
      // L7: ensureSeeded bypass znaczy że event_log może nie istnieć na świeżym DO.
      console.error("[events/stream]", e?.message ?? String(e));
      return c.json({ error: "stream_unavailable", message: e?.message }, 503);
    }
  });

  // Snapshot mapy — jeden GET zwraca 2000+ pkt + cursor, potem tylko delty przez SSE.
  app.get("/api/admin/map/snapshot", requireMasterOrInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = me.role === "investor" ? investorOrgIdOf(c.env, me.investorId) : null;
    if (me.role === "investor" && !orgId) return c.json({ error: "no_org_mapping" }, 403);
    return c.json(mapSnapshot(c.env, orgId));
  });

  // DEV: seed syntetycznych lokalizacji rozsianych po 16 miastach (load test 2000+ markerów).
  app.post("/api/admin/dev/seed-locations", requireMaster, async (c) => {
    const body = await c.req.json<{ count?: number }>().catch(() => ({} as any));
    const target = Math.min(Math.max(Number(body.count ?? 2000), 1), 5000);
    const have = Number(
      c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM locations WHERE id LIKE 'SYN-%'")[0].n
    );
    if (have >= target) {
      const total = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM locations")[0].n);
      return c.json({ ok: true, created: 0, total, note: "already_seeded" });
    }
    const CITIES = [
      ["Warszawa", 52.2297, 21.0122], ["Kraków", 50.0647, 19.9450], ["Łódź", 51.7592, 19.4560],
      ["Wrocław", 51.1079, 17.0385], ["Poznań", 52.4064, 16.9252], ["Gdańsk", 54.3520, 18.6466],
      ["Szczecin", 53.4285, 14.5528], ["Bydgoszcz", 53.1235, 18.0084], ["Lublin", 51.2465, 22.5684],
      ["Katowice", 50.2649, 19.0238], ["Białystok", 53.1325, 23.1688], ["Rzeszów", 50.0412, 21.9991],
      ["Olsztyn", 53.7784, 20.4801], ["Kielce", 50.8661, 20.6286], ["Opole", 50.6751, 17.9213],
      ["Zielona Góra", 51.9356, 15.5062],
    ] as const;
    const now = Date.now();
    // M6: bounded batch — max 500 insertów per call (skill rule: resumable batches).
    // Klient woła ponownie aż remaining === 0.
    const batchEnd = Math.min(target, have + 500);
    // DO SQLite zakazuje SQL BEGIN TRANSACTION — atomowość per request daje auto-coalescing DO.
    // INSERT OR IGNORE + licznik z COUNT czynią seed resumable po częściowym failu.
    try {
      for (let i = have; i < batchEnd; i++) {
        const [city, clat, clng] = CITIES[i % CITIES.length];
        const lat = (clat as number) + (Math.random() - 0.5) * 0.28;
        const lng = (clng as number) + (Math.random() - 0.5) * 0.42;
        const fill = Math.floor(Math.random() * 100);
        const id = `SYN-${String(i + 1).padStart(4, "0")}`;
        c.env.sql.exec(
          "INSERT OR IGNORE INTO locations (id, address, district, lat, lng, region_id, investor_org_id, fill_level, status, monthly_packages, created_at, updated_at, version) " +
            "VALUES (?, ?, ?, ?, ?, 1, 2, ?, 'online', ?, ?, ?, 1)",
          [id, `${city}, punkt syntetyczny ${i + 1}`, city, lat, lng, fill, 1000 + Math.floor(Math.random() * 6000), now, now]
        );
      }
    } catch (e: any) {
      console.error("[dev/seed-locations]", e?.message ?? String(e));
      return c.json({ error: "seed_failed", message: e?.message }, 500);
    }
    // L8: uczciwy licznik — realna delta z COUNT, nie licznik pętli (INSERT OR IGNORE może pominąć).
    const nowHave = Number(
      c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM locations WHERE id LIKE 'SYN-%'")[0].n
    );
    const total = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM locations")[0].n);
    const remaining = Math.max(0, target - nowHave);
    return c.json({ ok: true, created: nowHave - have, total, remaining });
  });

  // DEV: M7 — czyszczenie syntetycznych punktów (SYN-%) zanim zanieczyszczą real engine runs.
  app.post("/api/admin/dev/purge-locations", requireMaster, async (c) => {
    const before = Number(
      c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM locations WHERE id LIKE 'SYN-%'")[0].n
    );
    c.env.sql.exec("DELETE FROM locations WHERE id LIKE 'SYN-%'");
    c.env.sql.exec("DELETE FROM event_log WHERE point_id LIKE 'SYN-%'");
    return c.json({ ok: true, purged: before });
  });

  // DEV: symulator ruchu — podnosi fill na N losowych punktach + opcjonalnie zdarzenia cycle/dispute.
  app.post("/api/admin/dev/simulate", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const b = await c.req.json<{ locations?: number; credits?: number; disputes?: number }>().catch(() => ({} as any));
    const nLoc = Math.min(Math.max(Number(b.locations ?? 25), 0), 200);
    const nCred = Math.min(Math.max(Number(b.credits ?? 2), 0), 20);
    const nDisp = Math.min(Math.max(Number(b.disputes ?? 1), 0), 20);
    const now = Date.now();
    const picks = c.env.sql.query<any>(
      "SELECT id, fill_level FROM locations WHERE deleted_at IS NULL AND lat IS NOT NULL ORDER BY RANDOM() LIMIT ?",
      [nLoc]
    );
    for (const p of picks) {
      const next = Math.min(100, Number(p.fill_level) + 3 + Math.floor(Math.random() * 25));
      c.env.sql.exec("UPDATE locations SET fill_level = ?, updated_at = ? WHERE id = ?", [next, now, p.id]);
      emitLocationUpdate(c.env, p.id, { simulated: true });
    }
    for (let i = 0; i < nCred; i++) {
      const p = picks[i % Math.max(picks.length, 1)];
      const amountNet = 50000 + Math.floor(Math.random() * 450000);
      emitRealtimeEvent(c.env, {
        eventType: "cycle.credit_posted",
        pointId: p?.id ?? null,
        payload: {
          amountNetGrosze: amountNet,
          packages: 400 + Math.floor(Math.random() * 3000),
          party: "Operator kaucyjny",
          simulated: true,
        },
        actorId: me.id,
      });
    }
    for (let i = 0; i < nDisp; i++) {
      const p = picks[(i + 3) % Math.max(picks.length, 1)];
      emitRealtimeEvent(c.env, {
        eventType: "dispute_created",
        pointId: p?.id ?? null,
        payload: {
          deltaPct: 2 + Math.random() * 8,
          alertLevel: i % 2 === 0 ? "T-3" : "T-1",
          disputedAmountGrosze: 20000 + Math.floor(Math.random() * 180000),
          simulated: true,
        },
        actorId: me.id,
      });
    }
    return c.json({ ok: true, locations: picks.length, credits: nCred, disputes: nDisp });
  });


  app.get("/api/admin/csv/profiles", requireMaster, async (c) => {
    // List saved mapping profiles
    const rows = c.env.sql.query<any>(
      "SELECT ip.id, ip.name, ip.org_id, ip.kind, ip.mapping_json, ip.created_at, " +
      "o.name AS org_name FROM import_profiles ip JOIN organizations o ON o.id = ip.org_id ORDER BY ip.created_at DESC"
    );
    return c.json({ profiles: rows });
  });

  app.post("/api/admin/csv/profiles", requireMaster, async (c) => {
    // Create/update profile
    const body = await c.req.json<{ name: string; orgId: number; kind: string; mapping: any }>();
    if (!body.name || !body.orgId || !body.kind || !body.mapping) {
      return c.json({ error: "missing_fields" }, 400);
    }
    const now = Date.now();
    c.env.sql.exec(
      "INSERT INTO import_profiles (name, org_id, kind, mapping_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [body.name, body.orgId, body.kind, JSON.stringify(body.mapping), now, now]
    );
    const id = Number(c.env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
    return c.json({ ok: true, id });
  });

  app.post("/api/admin/csv/dry-run", requireMaster, async (c) => {
    // Dry-run simulator. Validation: types, required fields, duplicates, overrides.
    // Calculates weight_from_catalog from product card total weight.
    const { kind, csv, mapping, cycleId } = await c.req.json<{
      kind: "telemetry" | "credits" | "pickups";
      csv: string;
      mapping: Record<string, string>;
      cycleId: number;
    }>();
    if (!kind || !csv || !mapping || !cycleId) return c.json({ error: "missing_fields" }, 400);

    const parsed = parseCsv(csv, true);
    if (parsed.errors.length > 0) return c.json({ error: "parse_failed", errors: parsed.errors });

    const headers = parsed.headers;
    const csvRows = parsed.rows;
    const validationErrors: string[] = [];
    const mappedRows: any[] = [];
    let insertedEvents = 0;
    let duplicatedKeys = 0;
    let checksumSum = 0;

    const knownDevices = new Set(c.env.sql.query<{ serial: string }>("SELECT serial FROM devices").map(r => r.serial.toLowerCase()));
    const knownLocations = new Set(c.env.sql.query<{ id: string }>("SELECT id FROM locations").map(r => r.id.toLowerCase()));
    const knownDrivers = new Set(c.env.sql.query<{ id: number }>("SELECT id FROM drivers").map(r => r.id));
    const knownDriversBdo = new Set(c.env.sql.query<{ bdo: string }>("SELECT bdo_number AS bdo FROM drivers WHERE bdo_number IS NOT NULL").map(r => r.bdo.toLowerCase()));

    const packagingItemsRows = c.env.sql.query<any>("SELECT ean, weight_total_g, is_deleted FROM packaging_items");
    const packagingItemsMap = new Map<string, { weightTotalG: number; isDeleted: number }>();
    for (const p of packagingItemsRows) {
      packagingItemsMap.set(p.ean.toLowerCase(), { weightTotalG: p.weight_total_g, isDeleted: p.is_deleted });
    }

    const overridesRows = c.env.sql.query<any>("SELECT ean, scope, scope_id, action FROM catalog_overrides");
    const overridesMap = new Map<string, Map<string, string>>();
    for (const ov of overridesRows) {
      const eanLower = ov.ean.toLowerCase();
      if (!overridesMap.has(eanLower)) overridesMap.set(eanLower, new Map());
      const scopeKey = ov.scope + (ov.scope_id ? ":" + ov.scope_id : "");
      overridesMap.get(eanLower)!.set(scopeKey.toLowerCase(), ov.action);
    }

    const isEanBlocked = (ean: string, locationId?: string, deviceId?: string): boolean => {
      const eanLower = ean.toLowerCase();
      const ovs = overridesMap.get(eanLower);
      if (ovs) {
        if (deviceId && ovs.has("device:" + deviceId.toLowerCase())) {
          return ovs.get("device:" + deviceId.toLowerCase()) === "block";
        }
        if (locationId && ovs.has("location:" + locationId.toLowerCase())) {
          return ovs.get("location:" + locationId.toLowerCase()) === "block";
        }
        if (ovs.has("global")) return ovs.get("global") === "block";
      }
      const cat = packagingItemsMap.get(eanLower);
      return cat ? cat.isDeleted === 1 : true;
    };

    csvRows.forEach((row, idx) => {
      const rowNum = idx + 2;
      const mapped: any = {};
      let hasError = false;

      if (kind === "telemetry") {
        const serialHeader = mapping["device_serial"];
        const tsHeader = mapping["ts"];
        const sessionHeader = mapping["session_id"];
        const eanHeader = mapping["ean"];
        const fractionHeader = mapping["fraction"];
        const acceptedHeader = mapping["accepted"];
        const rejectHeader = mapping["reject_reason"];

        const serial = (row[serialHeader?.toLowerCase()] ?? "").trim();
        const tsRaw = (row[tsHeader?.toLowerCase()] ?? "").trim();
        const session = (row[sessionHeader?.toLowerCase()] ?? "").trim();
        const ean = (row[eanHeader?.toLowerCase()] ?? "").trim();
        const fraction = (row[fractionHeader?.toLowerCase()] ?? "").trim();
        const accepted = (row[acceptedHeader?.toLowerCase()] ?? "").trim();
        const reject = (row[rejectHeader?.toLowerCase()] ?? "").trim();

        if (!serial) { validationErrors.push(`Wiersz ${rowNum}: brak device_serial`); hasError = true; }
        else if (!knownDevices.has(serial.toLowerCase())) { validationErrors.push(`Wiersz ${rowNum}: nieznana maszyna (${serial})`); hasError = true; }

        let ts = Date.parse(tsRaw);
        if (!tsRaw) { validationErrors.push(`Wiersz ${rowNum}: brak ts`); hasError = true; }
        else if (isNaN(ts)) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowy format ts (${tsRaw})`); hasError = true; }

        if (!session) { validationErrors.push(`Wiersz ${rowNum}: brak session_id`); hasError = true; }

        if (!ean) { validationErrors.push(`Wiersz ${rowNum}: brak ean`); hasError = true; }
        else {
          let locId: string | undefined;
          if (serial) {
            const devRows = c.env.sql.query<{ location_id: string }>("SELECT location_id FROM devices WHERE serial = ? LIMIT 1", [serial]);
            if (devRows.length > 0) locId = devRows[0].location_id;
          }
          if (isEanBlocked(ean, locId, serial)) {
            validationErrors.push(`Wiersz ${rowNum}: kod EAN (${ean}) zablokowany blokadą (override) lub brak w katalogu`);
            hasError = true;
          }
        }

        if (!hasError) {
          const cat = packagingItemsMap.get(ean.toLowerCase());
          const itemWeightG = cat ? cat.weightTotalG : 0;
          const isAcc = accepted === "1" || accepted.toLowerCase() === "true" || accepted.toLowerCase() === "yes";
          const weight = isAcc ? itemWeightG : 0;

          mapped.device_serial = serial;
          mapped.ts = ts;
          mapped.session_id = session;
          mapped.ean = ean;
          mapped.fraction = fraction;
          mapped.accepted = isAcc ? 1 : 0;
          mapped.reject_reason = reject || null;
          mapped.weight_from_catalog = weight;

          mappedRows.push(mapped);
          insertedEvents++;
          if (isAcc) checksumSum++;

          const key = `telemetry:${session}`;
          const dup = c.env.sql.query<{ id: number }>("SELECT id FROM event_log WHERE idempotency_key = ? LIMIT 1", [key]);
          if (dup.length > 0) duplicatedKeys++;
        }
      } else if (kind === "credits") {
        const fromHeader = mapping["period_from"];
        const toHeader = mapping["period_to"];
        const locHeader = mapping["location_ref"];
        const fracHeader = mapping["fraction"];
        const confirmedHeader = mapping["units_confirmed"];
        const massHeader = mapping["mass_kg"];
        const depositHeader = mapping["deposit_value"];
        const feeHeader = mapping["handling_fee_value"];

        const fromRaw = (row[fromHeader?.toLowerCase()] ?? "").trim();
        const toRaw = (row[toHeader?.toLowerCase()] ?? "").trim();
        const locRef = (row[locHeader?.toLowerCase()] ?? "").trim();
        const fraction = (row[fracHeader?.toLowerCase()] ?? "").trim();
        const confirmed = Number((row[confirmedHeader?.toLowerCase()] ?? "").replace(",", "."));
        const mass = Number((row[massHeader?.toLowerCase()] ?? "").replace(",", "."));
        const deposit = Number((row[depositHeader?.toLowerCase()] ?? "").replace(",", "."));
        const fee = Number((row[feeHeader?.toLowerCase()] ?? "").replace(",", "."));

        let from = Date.parse(fromRaw);
        if (!fromRaw) { validationErrors.push(`Wiersz ${rowNum}: brak period_from`); hasError = true; }
        else if (isNaN(from)) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowy format period_from (${fromRaw})`); hasError = true; }

        let to = Date.parse(toRaw);
        if (!toRaw) { validationErrors.push(`Wiersz ${rowNum}: brak period_to`); hasError = true; }
        else if (isNaN(to)) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowy format period_to (${toRaw})`); hasError = true; }

        if (!locRef) { validationErrors.push(`Wiersz ${rowNum}: brak location_ref`); hasError = true; }
        else if (!knownLocations.has(locRef.toLowerCase())) { validationErrors.push(`Wiersz ${rowNum}: nieznana lokalizacja (${locRef})`); hasError = true; }

        if (!fraction) { validationErrors.push(`Wiersz ${rowNum}: brak fraction`); hasError = true; }
        if (isNaN(confirmed) || confirmed < 0) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowa liczba units_confirmed`); hasError = true; }
        if (isNaN(mass) || mass < 0) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowa masa mass_kg`); hasError = true; }
        if (isNaN(deposit) || deposit < 0) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowy depozyt deposit_value`); hasError = true; }
        if (isNaN(fee) || fee < 0) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowa opłata handling_fee_value`); hasError = true; }

        if (!hasError) {
          mapped.period_from = from;
          mapped.period_to = to;
          mapped.location_ref = locRef;
          mapped.fraction = fraction;
          mapped.units_confirmed = confirmed;
          mapped.mass_kg = mass;
          mapped.deposit_value_grosze = Math.round(deposit * 100);
          mapped.handling_fee_grosze = Math.round(fee * 100);

          mappedRows.push(mapped);
          insertedEvents++;
          checksumSum += confirmed;

          const key = `operator.receipt:${locRef}:${to}`;
          const dup = c.env.sql.query<{ id: number }>("SELECT id FROM event_log WHERE idempotency_key = ? LIMIT 1", [key]);
          if (dup.length > 0) duplicatedKeys++;
        }
      } else {
        const tsHeader = mapping["pickup_ts"];
        const serialHeader = mapping["device_serial"];
        const driverHeader = mapping["driver_ref"];
        const sealsHeader = mapping["bale_seals"];
        const unitsHeader = mapping["units_per_bale"];
        const latHeader = mapping["gps_lat"];
        const lngHeader = mapping["gps_lng"];

        const tsRaw = (row[tsHeader?.toLowerCase()] ?? "").trim();
        const serial = (row[serialHeader?.toLowerCase()] ?? "").trim();
        const driverRef = (row[driverHeader?.toLowerCase()] ?? "").trim();
        const seals = (row[sealsHeader?.toLowerCase()] ?? "").trim();
        const units = Number((row[unitsHeader?.toLowerCase()] ?? "").replace(",", "."));
        const lat = Number((row[latHeader?.toLowerCase()] ?? "").replace(",", "."));
        const lng = Number((row[lngHeader?.toLowerCase()] ?? "").replace(",", "."));

        let ts = Date.parse(tsRaw);
        if (!tsRaw) { validationErrors.push(`Wiersz ${rowNum}: brak pickup_ts`); hasError = true; }
        else if (isNaN(ts)) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowy format pickup_ts (${tsRaw})`); hasError = true; }

        if (!serial) { validationErrors.push(`Wiersz ${rowNum}: brak device_serial`); hasError = true; }
        else if (!knownDevices.has(serial.toLowerCase())) { validationErrors.push(`Wiersz ${rowNum}: nieznana maszyna (${serial})`); hasError = true; }

        if (!driverRef) { validationErrors.push(`Wiersz ${rowNum}: brak driver_ref`); hasError = true; }
        else {
          const isNum = !isNaN(Number(driverRef));
          const exists = isNum ? knownDrivers.has(Number(driverRef)) : knownDriversBdo.has(driverRef.toLowerCase());
          if (!exists) { validationErrors.push(`Wiersz ${rowNum}: nieznany kierowca (${driverRef})`); hasError = true; }
        }

        if (isNaN(units) || units < 0) { validationErrors.push(`Wiersz ${rowNum}: nieprawidłowa liczba units_per_bale`); hasError = true; }

        if (!hasError) {
          mapped.pickup_ts = ts;
          mapped.device_serial = serial;
          mapped.driver_ref = driverRef;
          mapped.bale_seals = seals ? seals.split(",").map(s => s.trim()) : [];
          mapped.units_per_bale = units;
          mapped.gps_lat = isNaN(lat) ? null : lat;
          mapped.gps_lng = isNaN(lng) ? null : lng;

          mappedRows.push(mapped);
          insertedEvents++;
          checksumSum += units;

          const key = `pickup.completed:${serial}:${ts}`;
          const dup = c.env.sql.query<{ id: number }>("SELECT id FROM event_log WHERE idempotency_key = ? LIMIT 1", [key]);
          if (dup.length > 0) duplicatedKeys++;
        }
      }
    });

    return c.json({
      ok: true,
      headers,
      previewRows: csvRows.slice(0, 20),
      mappedRows,
      validationErrors: validationErrors.slice(0, 50),
      errorCount: validationErrors.length,
      deltas: { insertedEvents, duplicatedKeys, checksumSum }
    });
  });

  app.post("/api/admin/csv/commit", requireMaster, async (c) => {
    // Transactional commit. Enforces UNIQUE idempotency_key. Duplicate = silent skip + warning.
    const me = c.get(APP_USER_KEY);
    const { kind, rows, cycleId, filename } = await c.req.json<{
      kind: "telemetry" | "credits" | "pickups";
      rows: any[];
      cycleId: number;
      filename?: string;
    }>();
    if (!kind || !rows || !cycleId) return c.json({ error: "missing_fields" }, 400);

    const now = Date.now();
    let imported = 0;
    let skippedDuplicates = 0;
    const correlationId = newToken(16);

    // DO SQLite zakazuje SQL BEGIN TRANSACTION (use state.storage.transaction()).
    // Atomowość per request daje auto-coalescing DO; idempotency keys czynią import resumable po częściowym failu.
    try {
      for (const row of rows) {
        let eventType = "";
        let idempotencyKey = "";
        if (kind === "telemetry") {
          eventType = "session.closed";
          idempotencyKey = `telemetry:${row.session_id}`;
        } else if (kind === "credits") {
          eventType = "operator.receipt";
          idempotencyKey = `operator.receipt:${row.location_ref}:${row.period_to}`;
        } else {
          eventType = "pickup.completed";
          idempotencyKey = `pickup.completed:${row.device_serial}:${row.pickup_ts}`;
        }

        const dup = c.env.sql.query<{ id: number }>("SELECT id FROM event_log WHERE idempotency_key = ? LIMIT 1", [idempotencyKey]);
        if (dup.length > 0) {
          skippedDuplicates++;
          logEvent(c.env, {
            cycleId,
            eventType: "idempotency_warning",
            payload: { key: idempotencyKey, row, message: "Pominięto powtórzony import" },
            actorId: me.id
          });
          continue;
        }

        c.env.sql.exec(
          "INSERT INTO event_log (cycle_id, event_type, idempotency_key, payload_json, source, received_at, correlation_id, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [cycleId, eventType, idempotencyKey, JSON.stringify(row), filename ?? "universal_upload.csv", now, correlationId, now]
        );

        if (kind === "credits") {
          c.env.sql.exec(
            "INSERT INTO operator_credits (cycle_id, point_id, packages, amount_grosze, source_csv, source_row, source_reference, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [cycleId, row.location_ref, row.units_confirmed, row.handling_fee_grosze, filename ?? "upload.csv", 1, idempotencyKey, now]
          );
        } else if (kind === "telemetry" && row.accepted === 1) {
          let locId = "NET-001";
          const devRows = c.env.sql.query<{ location_id: string }>("SELECT location_id FROM devices WHERE serial = ? LIMIT 1", [row.device_serial]);
          if (devRows.length > 0) locId = devRows[0].location_id;
          c.env.sql.exec(
            "INSERT INTO collections (point_id, driver_id, status, packages, accepted_at, collected_at, cycle_id, created_at) " +
            "VALUES (?, 1, 'completed', ?, ?, ?, ?, ?)",
            [locId, 1, row.ts, row.ts, cycleId, now]
          );
        }
        imported++;
      }
    } catch (e: any) {
      return c.json({ error: "database_transaction_failed", message: e.message }, 500);
    }

    logEvent(c.env, {
      cycleId,
      eventType: `csv_imported_${kind}_batch`,
      payload: { filename: filename ?? "upload.csv", imported, skippedDuplicates, correlationId },
      actorId: me.id
    });

    try {
      const cycleData = c.env.sql.query<any>("SELECT id, period_start, period_end, status FROM settlement_cycles WHERE id = ?", [cycleId])[0];
      const recon = runReconciliation(c.env, cycleId, cycleData);
      const disputed = recon.filter((r) => r.status === "disputed");
      const incomplete = recon.filter((r) => r.status === "incomplete");
      let newStatus = "reconciling";
      if (disputed.length > 0) newStatus = "disputed";
      else if (incomplete.length === 0 && recon.length > 0) newStatus = "reconciled";
      c.env.sql.exec("UPDATE settlement_cycles SET status = ? WHERE id = ?", [newStatus, cycleId]);
    } catch (err) {}

    return c.json({ ok: true, imported, skippedDuplicates, correlationId });
  });

  app.get("/api/admin/catalog", requireMaster, async (c) => {
    // EAN Catalog list with search, pagination, and overrides joined
    const q = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? "50");
    const offset = Number(c.req.query("offset") ?? "0");

    let rows: any[];
    if (q) {
      rows = c.env.sql.query<any>(
        "SELECT pi.*, co.action AS override_action FROM packaging_items pi " +
        "LEFT JOIN catalog_overrides co ON co.ean = pi.ean " +
        "WHERE pi.ean LIKE ? OR pi.product_name LIKE ? OR pi.producer LIKE ? " +
        "ORDER BY pi.ean LIMIT ? OFFSET ?",
        [`%${q}%`, `%${q}%`, `%${q}%`, limit, offset]
      );
    } else {
      rows = c.env.sql.query<any>(
        "SELECT pi.*, co.action AS override_action FROM packaging_items pi " +
        "LEFT JOIN catalog_overrides co ON co.ean = pi.ean " +
        "ORDER BY pi.ean LIMIT ? OFFSET ?",
        [limit, offset]
      );
    }
    return c.json({ items: rows });
  });

  app.post("/api/admin/catalog/overrides", requireMaster, async (c) => {
    // Save manual EAN override block/allow (has priority over catalog reimports)
    const { ean, scope, scopeId, action, reason } = await c.req.json<{
      ean: string; scope: string; scopeId?: string; action: "block" | "allow"; reason?: string;
    }>();
    if (!ean || !scope || !action) return c.json({ error: "missing_fields" }, 400);

    const now = Date.now();
    // delete pre-existing overrides for the same ean-scope-scopeId to maintain unique constraint
    c.env.sql.exec(
      "DELETE FROM catalog_overrides WHERE ean = ? AND scope = ? AND (scope_id = ? OR (scope_id IS NULL AND ? IS NULL))",
      [ean, scope, scopeId ?? null, scopeId ?? null]
    );
    c.env.sql.exec(
      "INSERT INTO catalog_overrides (ean, scope, scope_id, action, reason, author, valid_from, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 'master', ?, ?)",
      [ean, scope, scopeId ?? null, action, reason ?? null, now, now]
    );
    logEvent(c.env, { eventType: "catalog_override_saved", payload: { ean, scope, scopeId, action, reason } });
    return c.json({ ok: true });
  });


  app.get("/api/investor/overview", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const pointsRows = c.env.sql.query<any>(
      "SELECT id, address, district, fill_level, status, last_collection_at, monthly_packages FROM points WHERE investor_id = ? ORDER BY fill_level DESC",
      [me.investorId]
    );
    const collectionsCount = Number(c.env.sql.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM collections c JOIN points p ON p.id = c.point_id WHERE p.investor_id = ? AND c.status='completed'",
      [me.investorId]
    )[0].n);
    const platformFeeGrosze = pointsRows.length * PLATFORM_FEE_PER_POINT_GROSZE;
    const settlementRows = c.env.sql.query<any>(
      "SELECT party, count, rate_label, net_grosze, vat_grosze, gross_grosze FROM settlements WHERE investor_id = ?",
      [me.investorId]
    );
    return c.json({ points: pointsRows, collectionsCount, platformFeeGrosze, settlements: settlementRows });
  });

  app.get("/api/investor/points", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const rows = c.env.sql.query<any>(
      "SELECT id, address, district, fill_level, status, last_collection_at, monthly_packages FROM points WHERE investor_id = ? ORDER BY id",
      [me.investorId]
    );
    return c.json({ points: rows });
  });

  app.post("/api/investor/points", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const { id, address, district, lat, lng } = await c.req.json<{ id: string; address: string; district: string; lat?: number; lng?: number }>();
    if (!id || !address || !district) return c.json({ error: "missing_fields" }, 400);
    const exists = c.env.sql.query<{ id: string }>("SELECT id FROM points WHERE id = ?", [id]);
    if (exists.length > 0) return c.json({ error: "duplicate_id" }, 400);
    c.env.sql.exec(
      "INSERT INTO points (id, address, district, investor_id, lat, lng, fill_level, status, monthly_packages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, address, district, me.investorId, lat ?? null, lng ?? null, 0, "online", 0, Date.now()]
    );
    // PROMPT 8: dual-write do kanonicznej tabeli locations (mapa live + scoping czytają stąd).
    const newOrgId = investorOrgIdOf(c.env, me.investorId);
    c.env.sql.exec(
      "INSERT OR IGNORE INTO locations (id, address, district, lat, lng, investor_org_id, fill_level, status, monthly_packages, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 0, 'online', 0, ?, ?, 1)",
      [id, address, district, lat ?? null, lng ?? null, newOrgId, Date.now(), Date.now()]
    );
    return c.json({ ok: true, id });
  });

  app.get("/api/investor/collections", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const rows = c.env.sql.query<any>(
      "SELECT c.id, c.point_id, c.packages, c.weight_kg, c.collected_at, c.cycle_id, d.name AS driver_name " +
      "FROM collections c JOIN points p ON p.id = c.point_id LEFT JOIN drivers d ON d.id = c.driver_id " +
      "WHERE p.investor_id = ? AND c.status='completed' ORDER BY c.collected_at DESC LIMIT 50",
      [me.investorId]
    );
    return c.json({ collections: rows });
  });

  app.get("/api/investor/settlements", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const rows = c.env.sql.query<any>(
      "SELECT party, count, rate_label, net_grosze, vat_grosze, gross_grosze FROM settlements WHERE investor_id = ?",
      [me.investorId]
    );
    return c.json({ settlements: rows });
  });

  app.get("/api/investor/cycles", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const rows = c.env.sql.query<any>(
      "SELECT DISTINCT sc.id, sc.label, sc.period_start, sc.period_end, sc.status, sc.closed_at, sc.created_at " +
      "FROM settlement_cycles sc " +
      "WHERE sc.id IN (SELECT cycle_id FROM operator_credits WHERE point_id IN (SELECT id FROM points WHERE investor_id = ?) " +
      "UNION SELECT cycle_id FROM sorter_receipts WHERE point_id IN (SELECT id FROM points WHERE investor_id = ?) " +
      "UNION SELECT cycle_id FROM collections WHERE point_id IN (SELECT id FROM points WHERE investor_id = ?)) " +
      "ORDER BY sc.period_start DESC",
      [me.investorId, me.investorId, me.investorId]
    );
    const enriched: any[] = [];
    for (const cy of rows) {
      const points = c.env.sql.query<any>("SELECT id, address, district FROM points WHERE investor_id = ?", [me.investorId]);
      const summary = { pointsCount: points.length, device: 0, sorter: 0, operator: 0, disputed: 0, reconciled: 0, amountGrosze: 0 };
      for (const p of points) {
        const dc = c.env.sql.query<{ n: number }>("SELECT COALESCE(SUM(packages),0) AS n FROM collections WHERE point_id = ? AND status='completed' AND collected_at BETWEEN ? AND ?", [p.id, cy.period_start, cy.period_end]);
        const sc = c.env.sql.query<{ n: number }>("SELECT COALESCE(SUM(packages),0) AS n FROM sorter_receipts WHERE cycle_id = ? AND point_id = ?", [cy.id, p.id]);
        const oc = c.env.sql.query<{ n: number; amount: number }>("SELECT COALESCE(SUM(packages),0) AS n, COALESCE(SUM(amount_grosze),0) AS amount FROM operator_credits WHERE cycle_id = ? AND point_id = ?", [cy.id, p.id]);
        const d = Number(dc[0]?.n ?? 0), s = Number(sc[0]?.n ?? 0), o = Number(oc[0]?.n ?? 0);
        summary.device += d; summary.sorter += s; summary.operator += o; summary.amountGrosze += Number(oc[0]?.amount ?? 0);
        const sources = (d > 0 ? 1 : 0) + (s > 0 ? 1 : 0) + (o > 0 ? 1 : 0);
        if (sources === 3) {
          const mx = Math.max(d, s, o), mn = Math.min(d, s, o), avg = (d + s + o) / 3;
          const vp = avg > 0 ? ((mx - mn) / avg) * 100 : 0;
          if (vp > RECONCILIATION_THRESHOLD_PCT) summary.disputed++; else summary.reconciled++;
        }
      }
      enriched.push({ ...cy, summary });
    }
    return c.json({ cycles: enriched });
  });

  app.get("/api/investor/invoices", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const rows = c.env.sql.query<any>(
      "SELECT id, ksef_number, recipient, title, amount_grosze, issue_date, status FROM invoices WHERE investor_id = ? ORDER BY issue_date DESC",
      [me.investorId]
    );
    return c.json({ invoices: rows });
  });

  // PROMPT 8: pulpit inwestora — przychód z ledgera (party_org_id), butelki per punkt,
  // urządzenia + telemetria. Model zarządcy wspólnot: „konto lokalu” per inwestor.
  app.get("/api/investor/dashboard", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const locs = c.env.sql.query<any>(
      "SELECT id, address, district, lat, lng, fill_level, status, last_collection_at, monthly_packages FROM locations WHERE deleted_at IS NULL AND investor_org_id = ? ORDER BY fill_level DESC",
      [orgId]
    );
    const revenueByType = c.env.sql.query<any>(
      "SELECT entry_type, direction, COUNT(*) AS entries, SUM(amount_net) AS net_grosze FROM ledger_entries WHERE party_org_id = ? GROUP BY entry_type, direction ORDER BY net_grosze DESC",
      [orgId]
    );
    const revenueNetGrosze = revenueByType.reduce(
      (s: number, r: any) => s + (r.direction === "credit" ? Number(r.net_grosze) : -Number(r.net_grosze)),
      0
    );
    const bottlesPerPoint = c.env.sql.query<any>(
      "SELECT c2.point_id, COALESCE(SUM(c2.packages),0) AS packages, COUNT(*) AS pickups, MAX(c2.collected_at) AS last_at " +
        "FROM collections c2 JOIN locations l ON l.id = c2.point_id " +
        "WHERE l.investor_org_id = ? AND c2.status = 'completed' GROUP BY c2.point_id ORDER BY packages DESC",
      [orgId]
    );
    const devices = c.env.sql.query<any>(
      "SELECT d.id, d.serial, d.manufacturer, d.model, d.status, d.location_id, MAX(h.ts) AS last_heartbeat " +
        "FROM devices d JOIN locations l ON l.id = d.location_id LEFT JOIN device_heartbeats h ON h.device_id = d.id " +
        "WHERE l.investor_org_id = ? AND d.deleted_at IS NULL GROUP BY d.id ORDER BY d.id",
      [orgId]
    );
    const totalBottles = bottlesPerPoint.reduce((s: number, b: any) => s + Number(b.packages ?? 0), 0);
    const avgFill = locs.length
      ? Math.round(locs.reduce((s: number, l: any) => s + Number(l.fill_level ?? 0), 0) / locs.length)
      : 0;
    return c.json({
      orgId,
      totals: { locations: locs.length, bottles: totalBottles, revenueNetGrosze, avgFill, devices: devices.length },
      locations: locs,
      revenueByType,
      bottlesPerPoint,
      devices,
    });
  });

  // ── PROMPT 18: settlement manifest, bank evidence pack, driver outbox ─────
  app.get("/api/admin/cycles/:id/manifest", requireMaster, async (c) => {
    const result = getSettlementManifest(c.env, Number(c.req.param("id")));
    if ((result as any).error) return c.json(result, 404);
    return c.json(result);
  });

  app.get("/api/admin/bank-data-room", requireMaster, async (c) => {
    return c.json(await bankDataRoomPackage(c.env));
  });

  app.get("/api/admin/driver-events", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>("SELECT e.*, d.name AS driver_name FROM driver_job_events e LEFT JOIN drivers d ON d.id=e.driver_id ORDER BY e.occurred_at DESC LIMIT 200");
    return c.json({ events: rows });
  });

  app.post("/api/driver/jobs/sync", requireDriver, async (c) => {
    const me = c.get(APP_USER_KEY);
    const body = await c.req.json<{ events: any[] }>();
    if (!Array.isArray(body.events) || body.events.length > 100) return c.json({ error: "invalid_batch" }, 400);
    const results: any[] = [];
    for (const ev of body.events) {
      const point = c.env.sql.query<{ id: string }>("SELECT id FROM points WHERE id=?", [ev.pointId]);
      if (!point.length) { results.push({ clientEventId: ev.clientEventId, error: "point_not_found" }); continue; }
      const r: any = recordDriverJobEvent(c.env, Number(me.driverId), ev);
      if (!r.error && !r.duplicate) {
        const now = Date.now();
        if (ev.action === "ACCEPTED") c.env.sql.exec("INSERT INTO collections (point_id,driver_id,status,accepted_at,created_at) VALUES (?,?, 'accepted',?,?)", [ev.pointId,me.driverId,ev.occurredAt||now,now]);
        if (ev.action === "COMPLETED") {
          c.env.sql.exec("INSERT INTO collections (point_id,driver_id,status,packages,weight_kg,accepted_at,collected_at,created_at) VALUES (?,?, 'completed',?,?,?,?,?)", [ev.pointId,me.driverId,Number(ev.packages||0),ev.weightKg??null,ev.occurredAt||now,ev.occurredAt||now,now]);
          c.env.sql.exec("UPDATE points SET fill_level=5,last_collection_at=? WHERE id=?", [ev.occurredAt||now,ev.pointId]);
          c.env.sql.exec("UPDATE locations SET fill_level=5,last_collection_at=?,updated_at=? WHERE id=?", [ev.occurredAt||now,now,ev.pointId]);
          emitLocationUpdate(c.env, ev.pointId, { reason: "collection", packages: Number(ev.packages||0) });
        }
      }
      results.push({ clientEventId: ev.clientEventId, ...r });
    }
    return c.json({ ok: results.every(r => !r.error), results });
  });

  app.get("/api/driver/overview", requireDriver, async (c) => {
    const me = c.get(APP_USER_KEY);
    const allPoints = c.env.sql.query<any>(
      "SELECT p.id, p.address, p.district, p.fill_level, p.status, i.name AS investor_name FROM points p JOIN investors i ON i.id = p.investor_id ORDER BY p.fill_level DESC"
    );
    const myCollections = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM collections WHERE driver_id = ? AND status='completed'", [me.driverId])[0].n);
    return c.json({ points: allPoints, myCollections });
  });

  app.get("/api/driver/points", requireDriver, async (c) => {
    const rows = c.env.sql.query<any>(
      "SELECT p.id, p.address, p.district, p.fill_level, p.status, i.name AS investor_name FROM points p JOIN investors i ON i.id = p.investor_id ORDER BY p.fill_level DESC"
    );
    return c.json({ points: rows });
  });

  app.post("/api/driver/jobs/:pointId/accept", requireDriver, async (c) => {
    const me = c.get(APP_USER_KEY);
    const pointId = c.req.param("pointId");
    const existing = c.env.sql.query<{ id: number }>("SELECT id FROM collections WHERE point_id = ? AND status = 'accepted'", [pointId]);
    if (existing.length > 0) return c.json({ error: "already_accepted" }, 409);
    c.env.sql.exec("INSERT INTO collections (point_id, driver_id, status, accepted_at, created_at) VALUES (?, ?, 'accepted', ?, ?)", [pointId, me.driverId, Date.now(), Date.now()]);
    return c.json({ ok: true });
  });

  app.post("/api/driver/jobs/:pointId/complete", requireDriver, async (c) => {
    const me = c.get(APP_USER_KEY);
    const pointId = c.req.param("pointId");
    const { packages, weightKg } = await c.req.json<{ packages: number; weightKg?: number }>();
    if (!packages || packages < 1) return c.json({ error: "invalid_packages" }, 400);
    const now = Date.now();
    c.env.sql.exec(
      "INSERT INTO collections (point_id, driver_id, status, packages, weight_kg, accepted_at, collected_at, created_at) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)",
      [pointId, me.driverId, packages, weightKg ?? null, now, now, now]
    );
    c.env.sql.exec("UPDATE points SET fill_level = 5, last_collection_at = ? WHERE id = ?", [now, pointId]);
    // PROMPT 7: zapis do locations (mapa live czyta stąd, nie z points) + emit eventu na SSE.
    c.env.sql.exec("UPDATE locations SET fill_level = 5, last_collection_at = ?, updated_at = ? WHERE id = ?", [now, now, pointId]);
    emitLocationUpdate(c.env, pointId, { reason: "collection", packages });
    return c.json({ ok: true });
  });

  app.get("/api/driver/collections", requireDriver, async (c) => {
    const me = c.get(APP_USER_KEY);
    const rows = c.env.sql.query<any>(
      "SELECT c.id, c.point_id, c.packages, c.weight_kg, c.collected_at, c.cycle_id FROM collections c WHERE c.driver_id = ? AND c.status='completed' ORDER BY c.collected_at DESC LIMIT 50",
      [me.driverId]
    );
    return c.json({ collections: rows, totalPackages: rows.reduce((sum: number, r: any) => sum + (r.packages ?? 0), 0) });
  });

  // ─── PROMPT 9/10/11: finanse inwestora, płatności (PolCard sandbox), wiadomości ───
  app.get("/api/investor/finance", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    return c.json({
      orgId,
      balance: investorBalance(c.env, orgId),
      statement: investorStatement(c.env, orgId, 100),
      payments: paymentsFor(c.env, orgId, 50),
    });
  });

  app.post("/api/investor/payments", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const r = createPayment(c.env, orgId, me.id);
    if ("error" in r) return c.json(r, 400);
    logEvent(c.env, { eventType: "payment_created", payload: { paymentId: r.id, orgId, amountGrosze: r.amountGrosze, provider: "polcard_sandbox" }, actorId: me.id });
    return c.json({ ok: true, ...r });
  });

  app.post("/api/investor/payments/:id/confirm", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const pid = Number(c.req.param("id"));
    const r = await confirmPayment(c.env, orgId, pid);
    if (!r.ok) return c.json(r, 400);
    logEvent(c.env, { eventType: "payment_confirmed", payload: { paymentId: pid, orgId, provider: "polcard_sandbox" }, actorId: me.id });
    return c.json(r);
  });

  app.get("/api/investor/contracts", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const contractRows = c.env.sql.query<any>(
      "SELECT ct.id, ct.type, ct.valid_from, ct.valid_to, ct.notice_period_days, ct.status, oa.name AS party_a_name " +
      "FROM contracts ct JOIN organizations oa ON oa.id = ct.party_a_org_id WHERE ct.party_b_org_id = ? AND ct.deleted_at IS NULL ORDER BY ct.id",
      [orgId]
    );
    const rateRows = c.env.sql.query<any>(
      "SELECT rc.contract_id, rc.fraction, rc.collection_model, rc.rate_value, rc.rate_unit, rc.valid_from, rc.valid_to FROM rate_cards rc " +
      "JOIN contracts ct ON ct.id = rc.contract_id WHERE ct.party_b_org_id = ? AND rc.deleted_at IS NULL ORDER BY rc.contract_id, rc.id",
      [orgId]
    );
    return c.json({ contracts: contractRows, rates: rateRows });
  });

  app.get("/api/investor/messages", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const rows = c.env.sql.query<any>("SELECT id, sender_role, body, created_at, read_at FROM messages WHERE org_id = ? ORDER BY id ASC LIMIT 200", [orgId]);
    c.env.sql.exec("UPDATE messages SET read_at = ? WHERE org_id = ? AND sender_role = 'master' AND read_at IS NULL", [Date.now(), orgId]);
    return c.json({ messages: rows });
  });

  app.post("/api/investor/messages", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const { body } = await c.req.json<{ body: string }>();
    if (!body?.trim()) return c.json({ error: "empty" }, 400);
    c.env.sql.exec("INSERT INTO messages (org_id, sender_user_id, sender_role, body, created_at) VALUES (?, ?, 'investor', ?, ?)", [orgId, me.id, body.trim().slice(0, 4000), Date.now()]);
    return c.json({ ok: true });
  });

  app.get("/api/admin/messages", requireMaster, async (c) => {
    const orgIdParam = c.req.query("orgId");
    if (orgIdParam) {
      const orgId = Number(orgIdParam);
      const rows = c.env.sql.query<any>("SELECT id, sender_role, body, created_at, read_at FROM messages WHERE org_id = ? ORDER BY id ASC LIMIT 200", [orgId]);
      c.env.sql.exec("UPDATE messages SET read_at = ? WHERE org_id = ? AND sender_role = 'investor' AND read_at IS NULL", [Date.now(), orgId]);
      return c.json({ messages: rows });
    }
    const threads = c.env.sql.query<any>(
      "SELECT o.id AS org_id, o.name, COUNT(m.id) AS total, COALESCE(SUM(CASE WHEN m.sender_role='investor' AND m.read_at IS NULL THEN 1 ELSE 0 END),0) AS unread, MAX(m.created_at) AS last_at " +
      "FROM organizations o LEFT JOIN messages m ON m.org_id = o.id WHERE o.type = 'investor' GROUP BY o.id ORDER BY last_at DESC"
    );
    return c.json({ threads });
  });

  app.post("/api/admin/messages", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const { orgId, body } = await c.req.json<{ orgId: number; body: string }>();
    if (!orgId || !body?.trim()) return c.json({ error: "missing_fields" }, 400);
    c.env.sql.exec("INSERT INTO messages (org_id, sender_user_id, sender_role, body, created_at) VALUES (?, ?, 'master', ?, ?)", [orgId, me.id, body.trim().slice(0, 4000), Date.now()]);
    return c.json({ ok: true });
  });

  // DEV: seed finansów demo — kontrakty lease + stawki monthly_fixed (stawki w DB,
  // nie w kodzie, zgodnie z regułą #1) + naliczenia bieżącego miesiąca. Idempotentne.
  app.post("/api/admin/dev/seed-finance", requireMaster, async (c) => {
    const now = Date.now();
    const validFrom = Date.UTC(2026, 0, 1);
    const invOrgs = c.env.sql.query<{ id: number }>("SELECT id FROM organizations WHERE type = 'investor'");
    let contractsCreated = 0, ratesCreated = 0;
    for (const o of invOrgs) {
      const ex = c.env.sql.query<{ id: number }>("SELECT id FROM contracts WHERE type = 'lease' AND party_b_org_id = ? AND status = 'active'", [o.id]);
      let contractId: number;
      if (ex.length > 0) { contractId = Number(ex[0].id); }
      else {
        c.env.sql.exec("INSERT INTO contracts (type, party_a_org_id, party_b_org_id, valid_from, notice_period_days, status, created_at, updated_at, version) VALUES ('lease', 1, ?, ?, 30, 'active', ?, ?, 1)", [o.id, validFrom, now, now]);
        contractId = Number(c.env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
        contractsCreated++;
      }
      const demoRates: Array<[string, number]> = [["LEASE", 400], ["SERVICE", 60], ["ELECTRICITY", 45]];
      for (const [fraction, value] of demoRates) {
        const rex = c.env.sql.query<{ id: number }>("SELECT id FROM rate_cards WHERE contract_id = ? AND fraction = ? AND collection_model = 'monthly_fixed'", [contractId, fraction]);
        if (rex.length > 0) continue;
        c.env.sql.exec("INSERT INTO rate_cards (contract_id, valid_from, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, description, created_at, updated_at, version) VALUES (?, ?, ?, 'monthly_fixed', 'n/a', ?, 'PLN_PER_POINT_MONTH', 'PLN', 'Opłata miesięczna per punkt (demo)', ?, ?, 1)", [contractId, validFrom, fraction, value, now, now]);
        ratesCreated++;
      }
    }
    const charges = await generateMonthlyCharges(c.env);
    return c.json({ ok: true, contractsCreated, ratesCreated, charges });
  });

  // ─── PROMPT 12: dokumenty (archiwum) + sprawozdania miesięczne ─────────────
  app.post("/api/admin/documents", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const { orgId, title, category, filename, mimeType, contentBase64 } = await c.req.json<{
      orgId?: number | null; title: string; category: string; filename: string; mimeType: string; contentBase64: string;
    }>();
    if (!title?.trim() || !filename || !contentBase64) return c.json({ error: "missing_fields" }, 400);
    const cat = DOC_CATEGORIES.includes(category as any) ? category : "inne";
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(contentBase64), (ch) => ch.charCodeAt(0)); }
    catch { return c.json({ error: "bad_base64" }, 400); }
    if (bytes.byteLength === 0) return c.json({ error: "empty_file" }, 400);
    if (bytes.byteLength > MAX_DOC_BYTES) return c.json({ error: "too_large", maxBytes: MAX_DOC_BYTES }, 413);
    const r = saveDocument(c.env, { orgId: orgId ?? null, title: title.trim(), category: cat, filename, mimeType: mimeType || "application/octet-stream", bytes, uploadedBy: me.id });
    logEvent(c.env, { eventType: "document_uploaded", payload: { docId: r.id, orgId: orgId ?? null, filename, sizeBytes: bytes.byteLength }, actorId: me.id });
    return c.json({ ok: true, id: r.id, shards: r.shards });
  });

  app.get("/api/admin/documents", requireMaster, async (c) => {
    return c.json({ documents: listDocuments(c.env, null) });
  });

  app.delete("/api/admin/documents/:id", requireMaster, async (c) => {
    const me = c.get(APP_USER_KEY);
    const id = Number(c.req.param("id"));
    c.env.sql.exec("UPDATE documents SET deleted_at = ? WHERE id = ?", [Date.now(), id]);
    logEvent(c.env, { eventType: "document_deleted", payload: { docId: id }, actorId: me.id });
    return c.json({ ok: true });
  });

  app.get("/api/investor/documents", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    return c.json({ documents: listDocuments(c.env, orgId) });
  });

  // Pobranie bajtów: master — wszystko; inwestor — własne org + globalne.
  app.get("/api/documents/:id/download", requireMasterOrInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const doc = readDocument(c.env, Number(c.req.param("id")));
    if (!doc) return c.json({ error: "not_found" }, 404);
    if (me.role === "investor") {
      const orgId = investorOrgIdOf(c.env, me.investorId);
      if (doc.meta.org_id !== null && doc.meta.org_id !== orgId) return c.json({ error: "forbidden" }, 403);
    }
    return c.body(doc.bytes as any, 200, {
      "content-type": String(doc.meta.mime_type),
      "content-length": String(doc.bytes.byteLength),
      "content-disposition": `inline; filename="${String(doc.meta.filename).replace(/[^\w.\- ]/g, "_")}"`,
      "cache-control": "private, no-store",
    });
  });

  app.get("/api/investor/statements", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    return c.json({ periods: statementPeriods(c.env, orgId) });
  });

  app.get("/api/investor/statements/:period/html", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const period = c.req.param("period");
    if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: "bad_period" }, 400);
    const html = renderStatementHtml(c.env, orgId, period);
    if (!html) return c.json({ error: "not_found" }, 404);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  });

  app.post("/api/investor/statements/:period/accept", requireInvestor, async (c) => {
    const me = c.get(APP_USER_KEY);
    const orgId = investorOrgIdOf(c.env, me.investorId);
    if (!orgId) return c.json({ error: "no_org_mapping" }, 403);
    const period = c.req.param("period");
    if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: "bad_period" }, 400);
    return c.json(acceptStatement(c.env, orgId, period, me.id));
  });

  app.get("/api/admin/statements", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      `SELECT le.party_org_id AS org_id, o.name AS org_name,
              strftime('%Y-%m', COALESCE(le.booking_date, le.created_at) / 1000, 'unixepoch') AS period,
              COUNT(*) AS entries,
              SUM(CASE WHEN le.direction = 'credit' THEN le.amount_net ELSE -le.amount_net END) AS net,
              (SELECT sa.accepted_at FROM statement_acceptances sa WHERE sa.org_id = le.party_org_id
                 AND sa.period = strftime('%Y-%m', COALESCE(le.booking_date, le.created_at) / 1000, 'unixepoch')) AS accepted_at
         FROM ledger_entries le JOIN organizations o ON o.id = le.party_org_id
        WHERE le.party_org_id IS NOT NULL AND o.type = 'investor'
        GROUP BY org_id, period ORDER BY period DESC, org_id`
    );
    return c.json({ statements: rows });
  });

  app.get("/api/admin/statements/:orgId/:period/html", requireMaster, async (c) => {
    const period = c.req.param("period");
    if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: "bad_period" }, 400);
    const html = renderStatementHtml(c.env, Number(c.req.param("orgId")), period);
    if (!html) return c.json({ error: "not_found" }, 404);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  });

  // ─── PROMPT 13: publiczne strony prawne (warstwa zaufania) ──────────────────
  app.get("/regulamin", async (c) =>
    new Response(renderRegulamin(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } }));
  app.get("/polityka-prywatnosci", async (c) =>
    new Response(renderPolitykaPrywatnosci(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } }));

  // ── PROMPT 15: ewidencja punktow (CRUD) + edytor stawek (wersjonowanie) ────
  app.get("/api/admin/locations", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      `SELECT l.id, l.address, l.district, l.lat, l.lng, l.investor_org_id, o.name AS investor_name,
              l.monthly_rent_grosze, l.fill_level, l.status, l.launch_date, l.created_at
         FROM locations l LEFT JOIN organizations o ON o.id = l.investor_org_id
        WHERE l.deleted_at IS NULL AND l.id NOT LIKE 'SYN-%'
        ORDER BY l.id`
    );
    const synCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM locations WHERE id LIKE 'SYN-%' AND deleted_at IS NULL")[0].n);
    const orgs = c.env.sql.query<any>("SELECT id, name FROM organizations WHERE type = 'investor' ORDER BY name");
    const ids = c.env.sql.query<{ id: string }>("SELECT id FROM locations WHERE id LIKE 'NET-%'");
    let maxN = 0;
    for (const r of ids) { const m = /^NET-(\d+)/.exec(r.id); if (m) maxN = Math.max(maxN, Number(m[1])); }
    const nextId = `NET-${String(maxN + 1).padStart(3, "0")}`;
    return c.json({ locations: rows, synCount, orgs, nextId });
  });

  app.post("/api/admin/locations", requireMaster, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const id = String(b.id || "").trim().toUpperCase();
    const address = String(b.address || "").trim();
    const lat = b.lat == null ? null : Number(b.lat);
    const lng = b.lng == null ? null : Number(b.lng);
    if (!/^[A-Z0-9-]{3,24}$/.test(id)) return c.json({ error: "Nieprawid\u0142owy identyfikator punktu (A-Z, 0-9, my\u015blnik)" }, 400);
    if (address.length < 5) return c.json({ error: "Adres jest wymagany (min. 5 znak\u00f3w)" }, 400);
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return c.json({ error: "Brak wsp\u00f3\u0142rz\u0119dnych \u2014 u\u017cyj geokodowania lub ustaw pinezk\u0119 na mapie" }, 400);
    if (lat < 48.9 || lat > 55.1 || lng < 13.9 || lng > 24.2) return c.json({ error: "Wsp\u00f3\u0142rz\u0119dne poza granicami Polski" }, 400);
    const dup = c.env.sql.query<{ id: string }>("SELECT id FROM locations WHERE id = ? LIMIT 1", [id]);
    if (dup.length > 0) return c.json({ error: `Punkt ${id} ju\u017c istnieje` }, 409);
    const investorOrgId = b.investorOrgId ? Number(b.investorOrgId) : null;
    if (investorOrgId != null) {
      const org = c.env.sql.query<{ id: number }>("SELECT id FROM organizations WHERE id = ? AND type = 'investor'", [investorOrgId]);
      if (org.length === 0) return c.json({ error: "Wskazany inwestor nie istnieje" }, 400);
    }
    if (!b.force) {
      const near = c.env.sql.query<any>("SELECT id, address, lat, lng FROM locations WHERE deleted_at IS NULL AND lat IS NOT NULL AND id NOT LIKE 'SYN-%'");
      for (const p of near) {
        const dM = 111320 * Math.sqrt(Math.pow(p.lat - lat, 2) + Math.pow((p.lng - lng) * Math.cos((lat * Math.PI) / 180), 2));
        if (dM < 150) return c.json({ error: `BLISKO: ${p.id} (${p.address}) jest ~${Math.round(dM)} m od nowego punktu.` }, 409);
      }
    }
    const now = Date.now();
    c.env.sql.exec(
      `INSERT INTO locations (id, address, district, lat, lng, investor_org_id, monthly_rent_grosze, launch_date, fill_level, status, monthly_packages, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'online', 0, ?, ?, 1)`,
      [id, address, b.district ? String(b.district) : null, lat, lng, investorOrgId, b.monthlyRentGrosze ? Math.round(Number(b.monthlyRentGrosze)) : null, b.launchDate ? String(b.launchDate) : null, now, now]
    );
    c.env.sql.exec(
      "INSERT INTO event_log (point_id, event_type, idempotency_key, payload_json, source, created_at) VALUES (?, 'location.created', ?, ?, 'admin_ui', ?)",
      [id, `location:${id}:created`, JSON.stringify({ id, address, lat, lng, investorOrgId }), now]
    );
    return c.json({ ok: true, id });
  });

  app.patch("/api/admin/locations/:id", requireMaster, async (c) => {
    const id = c.req.param("id");
    const row = c.env.sql.query<any>("SELECT id FROM locations WHERE id = ? AND deleted_at IS NULL", [id]);
    if (row.length === 0) return c.json({ error: "Punkt nie istnieje" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const now = Date.now();
    if (b.deactivate === true) {
      c.env.sql.exec("UPDATE locations SET status = 'offline', deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", [now, now, id]);
      c.env.sql.exec("INSERT INTO event_log (point_id, event_type, idempotency_key, payload_json, source, created_at) VALUES (?, 'location.deactivated', ?, ?, 'admin_ui', ?)", [id, `location:${id}:deactivated:${now}`, JSON.stringify({ id }), now]);
      return c.json({ ok: true });
    }
    const sets: string[] = []; const vals: any[] = [];
    if (b.address != null) { sets.push("address = ?"); vals.push(String(b.address)); }
    if (b.district !== undefined) { sets.push("district = ?"); vals.push(b.district ? String(b.district) : null); }
    if (b.lat != null && b.lng != null) { sets.push("lat = ?", "lng = ?"); vals.push(Number(b.lat), Number(b.lng)); }
    if (b.investorOrgId !== undefined) { sets.push("investor_org_id = ?"); vals.push(b.investorOrgId ? Number(b.investorOrgId) : null); }
    if (b.monthlyRentGrosze !== undefined) { sets.push("monthly_rent_grosze = ?"); vals.push(b.monthlyRentGrosze ? Math.round(Number(b.monthlyRentGrosze)) : null); }
    if (sets.length === 0) return c.json({ error: "Brak zmian" }, 400);
    sets.push("updated_at = ?"); vals.push(now);
    vals.push(id);
    c.env.sql.exec(`UPDATE locations SET ${sets.join(", ")}, version = version + 1 WHERE id = ?`, vals);
    c.env.sql.exec("INSERT INTO event_log (point_id, event_type, payload_json, source, created_at) VALUES (?, 'location.updated', ?, 'admin_ui', ?)", [id, JSON.stringify(b), now]);
    return c.json({ ok: true });
  });

  app.get("/api/admin/rate-cards", requireMaster, async (c) => {
    const rows = c.env.sql.query<any>(
      `SELECT rc.id, rc.contract_id, rc.fraction, rc.collection_model, rc.packaging_type, rc.rate_value, rc.rate_unit, rc.currency, rc.description, rc.valid_from, rc.valid_to,
              ct.type AS contract_type, oa.name AS party_a, ob.name AS party_b
         FROM rate_cards rc
         JOIN contracts ct ON ct.id = rc.contract_id
         JOIN organizations oa ON oa.id = ct.party_a_org_id
         JOIN organizations ob ON ob.id = ct.party_b_org_id
        WHERE rc.deleted_at IS NULL
        ORDER BY rc.contract_id, rc.fraction, rc.valid_from DESC`
    );
    const contracts = c.env.sql.query<any>(
      `SELECT ct.id, ct.type, oa.name AS party_a, ob.name AS party_b, ct.status
         FROM contracts ct JOIN organizations oa ON oa.id = ct.party_a_org_id JOIN organizations ob ON ob.id = ct.party_b_org_id
        WHERE ct.deleted_at IS NULL AND ct.status = 'active' ORDER BY ct.id`
    );
    return c.json({ rateCards: rows, contracts });
  });

  app.post("/api/admin/rate-cards", requireMaster, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const contractId = Number(b.contractId);
    const fraction = String(b.fraction || "").toUpperCase();
    const collectionModel = String(b.collectionModel || "monthly_fixed");
    const packagingType = String(b.packagingType || "n/a");
    const rateValue = Number(b.rateValue);
    const rateUnit = String(b.rateUnit || "PLN_PER_POINT_MONTH");
    const ALLOWED = ["LEASE", "SERVICE", "ELECTRICITY", "PET", "ALU", "GLASS"];
    if (!contractId || !ALLOWED.includes(fraction)) return c.json({ error: "Nieprawid\u0142owy kontrakt lub frakcja" }, 400);
    if (!isFinite(rateValue) || rateValue < 0 || rateValue > 100000) return c.json({ error: "Nieprawid\u0142owa stawka" }, 400);
    const ct = c.env.sql.query<{ id: number }>("SELECT id FROM contracts WHERE id = ? AND status = 'active' AND deleted_at IS NULL", [contractId]);
    if (ct.length === 0) return c.json({ error: "Kontrakt nie istnieje lub jest nieaktywny" }, 400);
    const validFrom = b.validFrom ? Date.parse(String(b.validFrom)) : Date.now();
    if (!isFinite(validFrom)) return c.json({ error: "Nieprawid\u0142owa data pocz\u0105tku obowi\u0105zywania" }, 400);
    const now = Date.now();
    c.env.sql.exec(
      `UPDATE rate_cards SET valid_to = ?, updated_at = ?, version = version + 1
        WHERE contract_id = ? AND fraction = ? AND collection_model = ? AND packaging_type = ? AND valid_to IS NULL AND deleted_at IS NULL AND valid_from < ?`,
      [validFrom, now, contractId, fraction, collectionModel, packagingType, validFrom]
    );
    c.env.sql.exec(
      `INSERT INTO rate_cards (contract_id, valid_from, fraction, collection_model, packaging_type, rate_value, rate_unit, currency, description, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PLN', ?, ?, ?, 1)`,
      [contractId, validFrom, fraction, collectionModel, packagingType, rateValue, rateUnit, b.description ? String(b.description) : null, now, now]
    );
    c.env.sql.exec("INSERT INTO event_log (event_type, payload_json, source, created_at) VALUES ('rate_card.created', ?, 'admin_ui', ?)", [JSON.stringify({ contractId, fraction, collectionModel, rateValue, rateUnit, validFrom }), now]);
    return c.json({ ok: true });
  });

  // ── PROMPT 16: dane pokazowe (dokumenty, wiadomosci, heartbeaty) — idempotentne, v2 z polska ortografia ──
  const SEED_DOCS: [number | null, string, string, string, string][] = [
    [null, "Cennik usług edrs.io 2026", "inne", "cennik-2026.txt",
      "CENNIK USŁUG edrs.io — obowiązuje od 01.01.2026\n\n1. Abonament platformy: 500 zł netto / punkt / miesiąc.\n   Obejmuje: ewidencję punktów i urządzeń, mapę live, dziennik księgowy, panel inwestora,\n   sprawozdania miesięczne, archiwum dokumentów, komunikację oraz agentów kontroli jakości danych.\n\n2. Moduł kierowcy: 220 zł netto / pojazd / miesiąc.\n   Obejmuje zlecenia, reason codes, dowody odbioru i synchronizację zdarzeń.\n\n3. Bank Data Room: 0 zł — w cenie platformy.\n\n4. Wdrożenie i szkolenie zespołu: 0 zł w programie pilotażowym.\n\n5. Faktury ustrukturyzowane (KSeF): w cenie platformy, bez dodatkowych modułów.\n\nWszystkie kwoty netto, VAT 23%. Faktury wystawiane automatycznie z dziennika księgowego.\nCennik nie stanowi oferty w rozumieniu art. 66 § 1 Kodeksu cywilnego."],
    [null, "Wzór umowy najmu powierzchni pod recyklomat", "umowa", "wzor-umowa-najmu-rvm.txt",
      "WZÓR UMOWY NAJMU POWIERZCHNI POD URZĄDZENIE RVM\n\n§1 Przedmiot umowy\nWynajmujący oddaje w najem 2 m² powierzchni pod urządzenie do zbiórki opakowań (recyklomat)\nwraz z dostępem do przyłącza elektrycznego 230 V.\n\n§2 Czynsz\nCzynsz najmu ustalany jest zgodnie z kartoteką stawek (rate card) przypisaną do punktu\ni podlega wersjonowaniu — zmiana stawki nie wymaga aneksu, a naliczenia historyczne pozostają niezmienione.\n\n§3 Okres obowiązywania\nUmowa na 36 miesięcy, z możliwością wypowiedzenia z zachowaniem 30-dniowego okresu wypowiedzenia.\n\n§4 Obowiązki operatora\nOperator zapewnia montaż, serwis, odbiory opakowań oraz rozliczenie kaucji.\n\n§5 Rozliczenia\nRozliczenie miesięczne, netting: opłaty potrącane są z przychodów kaucyjnych punktu.\n\nDokument wzorcowy — wersja 1.0, do przeglądu prawnego."],
    [null, "Instrukcja obsługi recyklomatu R1", "inne", "instrukcja-r1.txt",
      "INSTRUKCJA OBSŁUGI RECYKLOMATU R1 (skrót operacyjny)\n\n1. Urządzenie przyjmuje butelki PET do 3 l, puszki aluminiowe oraz butelki szklane objęte kaucją.\n2. Opakowanie musi być puste, nieuszkodzone i mieć czytelny kod EAN.\n3. Zwrot kaucji: voucher do realizacji w punkcie lub przelew po zeskanowaniu kodu w aplikacji.\n4. Alarm zapełnienia wysyłany jest automatycznie przy 80% pojemności komory.\n5. Przy 95% i braku odbioru powyżej 48 godzin agent health-check podnosi alert do operatora.\n6. Zgłoszenia serwisowe: kontakt@edrs.io — czas reakcji 24 godziny w dni robocze.\n7. Nie wolno otwierać obudowy urządzenia bez zgody serwisu — plombowanie jest kontrolowane."],
    [null, "Instrukcja BHP przy odbiorze opakowań", "inne", "instrukcja-bhp-odbior.txt",
      "INSTRUKCJA BHP — ODBIÓR OPAKOWAŃ Z PUNKTU ZBIÓRKI\n\n1. Kierowca używa rękawic ochronnych oraz obuwia z podeszwą antypoślizgową.\n2. Worki są plombowane — numer plomby skanowany jest do systemu przed załadunkiem.\n3. Maksymalna masa jednego worka: 15 kg. Cięższe worki należy podzielić.\n4. Przy uszkodzonym opakowaniu szklanym: zamknąć worek, oznaczyć jako STŁUCZKA, nie przesypywać.\n5. Pojazd zabezpieczony podczas załadunku: hamulec postojowy, światła awaryjne, kamizelka odblaskowa.\n6. Po załadunku kierowca potwierdza odbiór w aplikacji — zdarzenie trafia do dziennika operacyjnego.\n7. W razie wypadku lub zdarzenia potencjalnie wypadkowego: natychmiastowe zgłoszenie do dyspozytora."],
    [null, "Karta lokalizacji punktu zbiórki (formularz)", "protokol", "karta-lokalizacji-formularz.txt",
      "KARTA LOKALIZACJI PUNKTU ZBIÓRKI — FORMULARZ\n\nIdentyfikator punktu: ......................\nAdres (ulica, numer, miasto): ......................\nDzielnica / gmina: ......................\nWspółrzędne geograficzne: ............ , ............\nWłaściciel lub zarządca terenu: ......................\nPrzyłącze elektryczne (napięcie / zabezpieczenie): ......................\nDostęp dla pojazdu odbiorczego (tak/nie, ograniczenia): ......................\nSzacowane natężenie ruchu pieszego (osób/dzień): ......................\nOdległość od najbliższego punktu sieci (m): ......................\nCzynsz najmu (zł netto/miesiąc): ......................\nPlanowana data uruchomienia: ......................\nUwagi: ......................\n\nPodpisy stron: ......................"],
    [null, "Procedura reklamacji i sporów rozliczeniowych", "regulamin", "procedura-reklamacji.txt",
      "PROCEDURA REKLAMACJI I SPORÓW ROZLICZENIOWYCH\n\n1. Zgłoszenie\nInwestor zgłasza rozbieżność przez panel (zakładka Wiadomości), podając identyfikator punktu i okres rozliczeniowy.\n\n2. Rejestracja\nSystem tworzy spór z terminem na przedstawienie dowodów — 5 dni roboczych.\n\n3. Dowody\nTelemetria urządzenia, masa z katalogu opakowań, potwierdzenie odbioru kierowcy, zapisy dziennika księgowego.\n\n4. Próg tolerancji\nRozbieżność do 2% masy uznaje się za mieszczącą się w błędzie pomiarowym i nie stanowi podstawy korekty.\n\n5. Brak dowodów w terminie\nSystem wykonuje działanie domyślne (agent dispute_deadline) i zamyka spór z uzasadnieniem.\n\n6. Wynik\nWON / LOST / ACCEPTED — każdy wynik zapisywany jest w niezmienialnym dzienniku księgowym.\n\n7. Odwołanie\nStronom przysługuje jedno odwołanie w terminie 14 dni od zamknięcia sporu."],
    [null, "Umowa powierzenia przetwarzania danych (RODO)", "umowa", "umowa-powierzenia-rodo.txt",
      "UMOWA POWIERZENIA PRZETWARZANIA DANYCH OSOBOWYCH (WZÓR)\n\n§1 Przedmiot\nPowierzenie przetwarzania danych osób kontaktowych inwestora oraz personelu punktu zbiórki.\n\n§2 Zakres danych\nImię, nazwisko, adres e-mail, numer telefonu, rola w organizacji.\n\n§3 Cel przetwarzania\nObsługa rozliczeń, komunikacja operacyjna oraz realizacja umowy głównej.\n\n§4 Podpowierzenie\nDostawca infrastruktury chmurowej oraz licencjonowany operator usług płatniczych.\n\n§5 Bezpieczeństwo\nSzyfrowanie transmisji, rozdział ról i uprawnień (RBAC), rejestr operacji w dzienniku zdarzeń.\n\n§6 Czas przetwarzania\nDo zakończenia umowy głównej; retencja zgodna z polityką prywatności platformy.\n\n§7 Prawa podmiotu danych\nDostęp, sprostowanie, usunięcie, ograniczenie przetwarzania, sprzeciw, przenoszenie danych.\n\nWzór — wersja 1.0, do przeglądu prawnego."],
    [2, "Protokół montażu NET-011 Marszałkowska", "protokol", "protokol-montazu-net-011.txt",
      "PROTOKÓŁ MONTAŻU URZĄDZENIA\n\nPunkt: NET-011, ul. Marszałkowska 100, Warszawa (Śródmieście).\nData montażu: 11.08.2026.\nUrządzenie: recyklomat R1, numer seryjny R1-2026-0111.\nPrzyłącze elektryczne: sprawne, pomiar napięcia 231 V, zabezpieczenie 16 A.\nPoziomowanie i mocowanie: wykonane, urządzenie stabilne.\nTest przyjęcia opakowań: PET — poprawnie, aluminium — poprawnie, szkło — poprawnie.\nTest komunikacji: heartbeat dotarł do platformy, punkt widoczny na mapie live.\nSzkolenie personelu punktu: przeprowadzone, 2 osoby.\nUwagi: brak.\n\nProtokół podpisany elektronicznie przez przedstawicieli stron."],
    [2, "Umowa inwestorska — pakiet 6 punktów", "umowa", "umowa-inwestorska-a.txt",
      "UMOWA INWESTORSKA (WYCIĄG)\n\nInwestor: Inwestor A.\nPakiet: 6 punktów zbiórki na terenie Warszawy.\nModel współpracy: operatorski — edrs.io/NET4ZERO prowadzi integrację urządzeń, montaż,\nodbiory, rozliczenia oraz serwis; inwestor finansuje urządzenia i pobiera przychód kaucyjny.\n\nStawki: zgodnie z kartoteką stawek widoczną w panelu (zakładka Stawki) — leasing, serwis, energia.\nRozliczenie: miesięczne, netting opłat z przychodów kaucyjnych, sprawozdanie do akceptacji w panelu.\nOkres inwestycji: 36 miesięcy. Wyłączność terytorialna: promień 300 m od punktu.\nPróg efektywności: 1 200 opakowań miesięcznie na punkt.\n\nWyciąg poglądowy — pełna treść w archiwum operatora."],
    [3, "Umowa inwestorska — pakiet 4 punktów", "umowa", "umowa-inwestorska-b.txt",
      "UMOWA INWESTORSKA (WYCIĄG)\n\nInwestor: Inwestor B.\nPakiet: 4 punkty zbiórki na terenie Warszawy.\nModel współpracy: operatorski — edrs.io/NET4ZERO prowadzi integrację urządzeń, montaż,\nodbiory, rozliczenia oraz serwis; inwestor finansuje urządzenia i pobiera przychód kaucyjny.\n\nStawki: zgodnie z kartoteką stawek widoczną w panelu (zakładka Stawki) — leasing, serwis, energia.\nRozliczenie: miesięczne, netting opłat z przychodów kaucyjnych, sprawozdanie do akceptacji w panelu.\nOkres inwestycji: 36 miesięcy. Wyłączność terytorialna: promień 300 m od punktu.\nPróg efektywności: 1 200 opakowań miesięcznie na punkt.\n\nWyciąg poglądowy — pełna treść w archiwum operatora."],
  ];

  app.get("/api/admin/dev/seed-demo-content", requireMaster, async (c) => {
    const done = c.env.sql.query<{ id: number }>("SELECT id FROM event_log WHERE idempotency_key = 'seed:demo-content:v2' LIMIT 1");
    if (done.length > 0) return c.json({ ok: true, already: true });
    const now = Date.now();
    const H = 3600_000, D = 24 * H;
    const enc = new TextEncoder();
    const me = c.get(APP_USER_KEY);

    // 1) Dokumenty — usun wersje v1 (bez polskich znakow) i wstaw na nowo
    let nDocs = 0;
    for (const [orgId, title, cat, filename, body] of SEED_DOCS) {
      const old = c.env.sql.query<{ id: number }>("SELECT id FROM documents WHERE filename = ?", [filename]);
      for (const row of old) {
        c.env.sql.exec("DELETE FROM doc_blobs WHERE doc_id = ?", [row.id]);
        c.env.sql.exec("DELETE FROM documents WHERE id = ?", [row.id]);
      }
      saveDocument(c.env, { orgId, title, category: cat, filename, mimeType: "text/plain; charset=utf-8", bytes: enc.encode(body), uploadedBy: me.id });
      nDocs++;
    }

    // 2) Wiadomosci — czysty zestaw demonstracyjny
    const uid = (email: string) => { const r = c.env.sql.query<{ id: number }>("SELECT id FROM users WHERE email = ? LIMIT 1", [email]); return r.length ? r[0].id : me.id; };
    const uA = uid("inwestor.a@net4zero.pl"), uB = uid("inwestor.b@net4zero.pl");
    c.env.sql.exec("DELETE FROM messages");
    const msgs: [number, number, string, string, number, number | null][] = [
      [2, uA, "investor", "Dzień dobry, czy montaż nowego punktu przy Marszałkowskiej odbędzie się zgodnie z planem w tym tygodniu?", now - 4 * D - 3 * H, now - 4 * D - 2 * H],
      [2, me.id, "master", "Tak, ekipa jest potwierdzona na wtorek rano. Protokół montażu pojawi się w zakładce Dokumenty tego samego dnia.", now - 4 * D - 1 * H, now - 4 * D],
      [2, uA, "investor", "Widzę na pulpicie, że NET-003 Ursynów ma 94% zapełnienia. Kiedy planowany jest odbiór?", now - 2 * D - 5 * H, now - 2 * D - 4 * H],
      [2, me.id, "master", "Odbiór zaplanowany na jutro o 7:30 — kierowca ma ten punkt na trasie. Alert podniósł też nasz agent health-check.", now - 2 * D - 3 * H, now - 2 * D - 2 * H],
      [2, uA, "investor", "Sprawozdanie za lipiec zaakceptowane. Proszę o fakturę za abonament w formacie KSeF.", now - 1 * D - 6 * H, now - 1 * D - 5 * H],
      [2, me.id, "master", "Dziękuję. Faktura zostanie wystawiona automatycznie z dziennika księgowego — będzie widoczna w zakładce Faktury.", now - 1 * D - 4 * H, null],
      [3, uB, "investor", "Dzień dobry, proszę o aktualny wyciąg operacji — domykamy księgowość za lipiec.", now - 3 * D - 2 * H, now - 3 * D - 1 * H],
      [3, me.id, "master", "Wyciąg jest dostępny w zakładce Finanse, a sprawozdanie lipcowe w zakładce Sprawozdania — oba generowane z dziennika księgowego.", now - 3 * D, now - 2 * D - 20 * H],
      [3, uB, "investor", "Dziękuję. Czy możemy dołożyć jeszcze jeden punkt na Pradze w czwartym kwartale?", now - 1 * D - 2 * H, now - 1 * D - 1 * H],
      [3, me.id, "master", "Tak — przygotuję propozycję lokalizacji wraz z analizą natężenia ruchu i wrócę z konkretami do końca tygodnia.", now - 20 * H, null],
    ];
    for (const [orgId, senderId, role, body, ts, readAt] of msgs) {
      c.env.sql.exec("INSERT INTO messages (org_id, sender_user_id, sender_role, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?)", [orgId, senderId, role, body, ts, readAt]);
    }

    // 3) Heartbeaty — tylko jesli brak
    let nHb = 0;
    const hbCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM device_heartbeats")[0].n);
    if (hbCount === 0) {
      const devs = c.env.sql.query<{ id: string }>("SELECT id FROM devices LIMIT 40");
      for (let di = 0; di < devs.length; di++) {
        const offline = di === devs.length - 1;
        for (let k = 12; k >= 0; k--) {
          const ts = now - k * 2 * H;
          const fill = Math.min(97, 15 + ((di * 13 + (12 - k) * 6) % 80));
          c.env.sql.exec(
            "INSERT INTO device_heartbeats (device_id, ts, online, fill_pct_json) VALUES (?, ?, ?, ?)",
            [devs[di].id, ts, offline && k < 4 ? 0 : 1, JSON.stringify({ PET: fill, ALU: Math.max(5, fill - 12), GLASS: Math.max(3, fill - 20) })]
          );
          nHb++;
        }
      }
    }

    c.env.sql.exec(
      "INSERT INTO event_log (event_type, idempotency_key, payload_json, source, created_at) VALUES ('seed.demo_content', 'seed:demo-content:v2', ?, 'admin_ui', ?)",
      [JSON.stringify({ nDocs, nMsgs: msgs.length, nHb }), now]
    );
    return c.json({ ok: true, docs: nDocs, messages: msgs.length, heartbeats: nHb, heartbeatsExisting: hbCount });
  });

  // ── PROMPT 20: centralne formularze danych operacyjnych ──────────────────
  app.get("/api/admin/data-entry/options", requireMaster, async (c) => c.json({
    organizations: c.env.sql.query<any>("SELECT id,name,type FROM organizations WHERE deleted_at IS NULL ORDER BY type,name"),
    locations: c.env.sql.query<any>("SELECT id,address,district FROM locations WHERE deleted_at IS NULL AND id NOT LIKE 'SYN-%' ORDER BY id"),
    drivers: c.env.sql.query<any>("SELECT id,name,company,bdo_number,status FROM drivers ORDER BY name"),
    cycles: c.env.sql.query<any>("SELECT id,label,status,period_start,period_end FROM settlement_cycles ORDER BY id DESC"),
    investors: c.env.sql.query<any>("SELECT id,name,status FROM investors ORDER BY name")
  }));

  const entryDuplicate = (env:any,key:string) => env.sql.query("SELECT id FROM event_log WHERE idempotency_key=? LIMIT 1",[key]).length>0;
  const entryLog = (env:any, me:any, key:string, eventType:string, payload:any, pointId?:string|null, cycleId?:number|null) => {
    try {
      const now=Date.now();
      env.sql.exec(
        "INSERT INTO event_log (cycle_id,point_id,event_type,idempotency_key,payload_json,source,actor_id,received_at,processed_at,created_at) VALUES (?,?,?,?,?,'admin_form',?,?,?,?)",
        [cycleId??null,pointId??null,eventType,key,JSON.stringify(payload),me.id,now,now,now]
      );
      return true;
    } catch (error:any) {
      console.error(`ENTRY_LOG_FAILED type=${eventType} key=${key}: ${error?.message||error}`);
      return false;
    }
  };

  app.post("/api/admin/data-entry/device", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");
    if(!key)return c.json({error:"missing_client_request_id"},400); if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const id=String(b.id||"").trim().toUpperCase(),serial=String(b.serial||"").trim(),manufacturer=String(b.manufacturer||"").trim(),model=String(b.model||"").trim();
    if(!/^[A-Z0-9_-]{3,40}$/.test(id)||serial.length<3||manufacturer.length<2||model.length<2)return c.json({error:"invalid_device_fields"},400);
    if(b.locationId&&!c.env.sql.query("SELECT id FROM locations WHERE id=? AND deleted_at IS NULL",[b.locationId]).length)return c.json({error:"location_not_found"},400);
    if(c.env.sql.query("SELECT id FROM devices WHERE id=? OR serial=?",[id,serial]).length)return c.json({error:"device_or_serial_exists"},409);
    const now=Date.now(),installed=b.installedAt?Date.parse(b.installedAt):null,warranty=b.warrantyUntil?Date.parse(b.warrantyUntil):null;
    c.env.sql.exec("INSERT INTO devices (id,serial,manufacturer,model,firmware_version,location_id,status,terminal_mid,terminal_tid,fraction_capacity_json,installed_at,warranty_until,created_at,updated_at,version) VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?,1)",[id,serial,manufacturer,model,b.firmwareVersion||null,b.locationId||null,b.terminalMid||null,b.terminalTid||null,JSON.stringify({PET:Number(b.petCapacity||0),ALU:Number(b.aluCapacity||0),GLASS:Number(b.glassCapacity||0)}),installed,warranty,now,now]);
    entryLog(c.env,me,key,"device.created",{id,serial,manufacturer,model,locationId:b.locationId},b.locationId); return c.json({ok:true,id});
  });

  app.post("/api/admin/data-entry/driver", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const name=String(b.name||"").trim(),type=String(b.type||"firma");if(name.length<3||!["firma","pracownik","podwykonawca"].includes(type))return c.json({error:"invalid_driver_fields"},400);
    if(b.bdoNumber&&c.env.sql.query("SELECT id FROM drivers WHERE bdo_number=?",[b.bdoNumber]).length)return c.json({error:"bdo_number_exists"},409);
    const now=Date.now();c.env.sql.exec("INSERT INTO drivers (name,type,company,bdo_number,bdo_verified,gps_id,status,created_at) VALUES (?,?,?,?,?,?, 'active',?)",[name,type,b.company||null,b.bdoNumber||null,b.bdoVerified?1:0,b.gpsId||null,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);entryLog(c.env,me,key,"driver.created",{id,name,type,company:b.company,bdoNumber:b.bdoNumber});return c.json({ok:true,id});
  });

  app.post("/api/admin/data-entry/contract", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const allowed=["lease","implementation","ipz_operator","acquirer","service","carrier"],a=Number(b.partyAOrgId),bb=Number(b.partyBOrgId),vf=Date.parse(b.validFrom),vt=b.validTo?Date.parse(b.validTo):null;
    if(!allowed.includes(b.type)||!a||!bb||a===bb||!Number.isFinite(vf)||(vt&&vt<=vf))return c.json({error:"invalid_contract_fields"},400);
    if(c.env.sql.query("SELECT COUNT(*) n FROM organizations WHERE id IN (?,?)",[a,bb])[0].n<2)return c.json({error:"organization_not_found"},400);
    const now=Date.now();c.env.sql.exec("INSERT INTO contracts (type,party_a_org_id,party_b_org_id,valid_from,valid_to,notice_period_days,file_ref,status,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,'active',?,?,1)",[b.type,a,bb,vf,vt,Math.max(0,Number(b.noticePeriodDays||30)),b.fileRef||null,now,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);entryLog(c.env,me,key,"contract.created",{id,...b});return c.json({ok:true,id});
  });

  app.post("/api/admin/data-entry/collection", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const point=String(b.pointId||""),driver=Number(b.driverId),packages=Number(b.packages),weight=Number(b.weightKg),ts=Date.parse(b.collectedAt);
    if(!point||!driver||packages<1||weight<=0||!Number.isFinite(ts))return c.json({error:"invalid_collection_fields"},400);
    if(!c.env.sql.query("SELECT id FROM locations WHERE id=? AND deleted_at IS NULL",[point]).length||!c.env.sql.query("SELECT id FROM drivers WHERE id=?",[driver]).length)return c.json({error:"point_or_driver_not_found"},400);
    const now=Date.now();c.env.sql.exec("INSERT INTO collections (point_id,driver_id,status,packages,weight_kg,accepted_at,collected_at,cycle_id,created_at) VALUES (?,?,'completed',?,?,?,?,?,?)",[point,driver,packages,weight,ts,ts,b.cycleId?Number(b.cycleId):null,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);c.env.sql.exec("UPDATE locations SET fill_level=5,last_collection_at=?,updated_at=? WHERE id=?",[ts,now,point]);entryLog(c.env,me,key,"collection.manual_created",{id,packages,weightKg:weight,seals:String(b.seals||"").split(/[;,]/).map((x:string)=>x.trim()).filter(Boolean),gps:{lat:b.gpsLat?Number(b.gpsLat):null,lng:b.gpsLng?Number(b.gpsLng):null}},point,b.cycleId?Number(b.cycleId):null);return c.json({ok:true,id});
  });

  app.post("/api/admin/data-entry/invoice", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const ksef=String(b.ksefNumber||"").trim(),title=String(b.title||"").trim(),recipient=String(b.recipient||"").trim(),amount=Math.round(Number(b.amountPln)*100);
    if(ksef.length<5||title.length<3||recipient.length<2||!Number.isFinite(amount)||!b.issueDate)return c.json({error:"invalid_invoice_fields"},400);if(c.env.sql.query("SELECT id FROM invoices WHERE ksef_number=?",[ksef]).length)return c.json({error:"ksef_number_exists"},409);
    const now=Date.now();c.env.sql.exec("INSERT INTO invoices (ksef_number,recipient,investor_id,driver_id,title,amount_grosze,issue_date,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)",[ksef,recipient,b.investorId?Number(b.investorId):null,b.driverId?Number(b.driverId):null,title,amount,b.issueDate,b.status||"robocza",now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);entryLog(c.env,me,key,"invoice.manual_created",{id,ksef,title,recipient,amount});return c.json({ok:true,id});
  });

  app.post("/api/admin/data-entry/dispute", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const cycle=Number(b.cycleId),point=String(b.pointId||""),amount=Math.round(Number(b.amountPln)*100),due=Date.parse(b.dueAt);if(!cycle||!point||amount<=0||!Number.isFinite(due)||String(b.reason||"").length<5)return c.json({error:"invalid_dispute_fields"},400);
    const now=Date.now(),evidence=[{type:"manual_note",value:String(b.evidence||b.reason),createdBy:me.id,createdAt:now}];c.env.sql.exec("INSERT INTO reconciliations (cycle_id,scope_type,scope_ref,source_a_json,source_b_json,source_c_json,delta_pct,status,created_at) VALUES (?,'location',?,?,?,?,?,'disputed',?)",[cycle,point,JSON.stringify({source:"manual",reason:b.reason}),null,null,Number(b.deltaPct||0),now]);const reconId=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);c.env.sql.exec("INSERT INTO disputes (reconciliation_id,state,due_at,evidence_json,disputed_amount_grosze,outcome,default_action_taken,created_at,updated_at) VALUES (?,'EVIDENCE_REQUIRED',?,?,?,NULL,0,?,?)",[reconId,due,JSON.stringify(evidence),amount,now,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);entryLog(c.env,me,key,"dispute.manual_created",{id,reconId,reason:b.reason,amount},point,cycle);return c.json({ok:true,id,reconciliationId:reconId});
  });

  // ── PROMPT 21: Energia — ERP workflow + pomiary + płatność ───────────────
  app.get("/api/admin/energy/dashboard", requireMaster, async (c) => c.json(energyDashboard(c.env)));
  app.get("/api/admin/energy/options", requireMaster, async (c) => c.json({
    suppliers:c.env.sql.query<any>("SELECT id,name,nip,bank_account,status FROM energy_suppliers ORDER BY name"),
    contracts:c.env.sql.query<any>("SELECT c.*,s.name supplier_name,l.address FROM energy_contracts c JOIN energy_suppliers s ON s.id=c.supplier_id JOIN locations l ON l.id=c.location_id ORDER BY c.id DESC"),
    meters:c.env.sql.query<any>("SELECT id,serial,location_id,contract_id,status FROM energy_meters ORDER BY id"),
    locations:c.env.sql.query<any>("SELECT id,address,district FROM locations WHERE deleted_at IS NULL AND id NOT LIKE 'SYN-%' ORDER BY id"),
    devices:c.env.sql.query<any>("SELECT id,serial,model,location_id FROM devices WHERE deleted_at IS NULL ORDER BY id")
  }));

  app.post("/api/admin/energy/suppliers", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const name=String(b.name||"").trim(),nip=String(b.nip||"").replace(/\D/g,"");if(name.length<3||(nip&&nip.length!==10))return c.json({error:"invalid_supplier_fields"},400);if(nip&&c.env.sql.query("SELECT id FROM energy_suppliers WHERE nip=?",[nip]).length)return c.json({error:"supplier_nip_exists"},409);
    const now=Date.now();c.env.sql.exec("INSERT INTO energy_suppliers (name,nip,contact_email,bank_account,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)",[name,nip||null,b.contactEmail||null,b.bankAccount||null,now,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);entryLog(c.env,me,key,"energy.supplier_created",{id,name,nip});return c.json({ok:true,id});
  });
  app.post("/api/admin/energy/contracts", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});
    const supplier=Number(b.supplierId),loc=String(b.locationId||""),price=Number(b.pricePerKwh),vf=Date.parse(b.validFrom),vt=b.validTo?Date.parse(b.validTo):null;if(!supplier||!loc||!b.ppe||!b.tariff||price<=0||!Number.isFinite(vf)||(vt&&vt<=vf))return c.json({error:"invalid_energy_contract"},400);if(!c.env.sql.query("SELECT id FROM energy_suppliers WHERE id=?",[supplier]).length||!c.env.sql.query("SELECT id FROM locations WHERE id=?",[loc]).length)return c.json({error:"supplier_or_location_not_found"},400);if(c.env.sql.query("SELECT id FROM energy_contracts WHERE ppe=?",[b.ppe]).length)return c.json({error:"ppe_exists"},409);
    const now=Date.now();c.env.sql.exec("INSERT INTO energy_contracts (supplier_id,location_id,ppe,tariff,contracted_power_kw,price_per_kwh,fixed_monthly_grosze,valid_from,valid_to,payment_days,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?)",[supplier,loc,String(b.ppe),String(b.tariff),b.contractedPowerKw?Number(b.contractedPowerKw):null,price,Math.round(Number(b.fixedMonthlyPln||0)*100),vf,vt,Math.max(1,Number(b.paymentDays||14)),now,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);entryLog(c.env,me,key,"energy.contract_created",{id,supplierId:supplier,locationId:loc,ppe:b.ppe,tariff:b.tariff,pricePerKwh:price},loc);return c.json({ok:true,id});
  });
  app.post("/api/admin/energy/meters", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});const id=String(b.id||"").trim().toUpperCase(),serial=String(b.serial||"").trim();if(!/^[A-Z0-9_-]{3,40}$/.test(id)||serial.length<3||!b.contractId||!b.locationId)return c.json({error:"invalid_meter_fields"},400);if(c.env.sql.query("SELECT id FROM energy_meters WHERE id=? OR serial=?",[id,serial]).length)return c.json({error:"meter_exists"},409);
    const now=Date.now();c.env.sql.exec("INSERT INTO energy_meters (id,contract_id,location_id,device_id,serial,model,unit,multiplier,source_type,status,installed_at,created_at,updated_at) VALUES (?,?,?,?,?,?, 'kWh',?,?, 'active',?,?,?)",[id,Number(b.contractId),String(b.locationId),b.deviceId||null,serial,b.model||null,Number(b.multiplier||1),b.sourceType||"manual",b.installedAt?Date.parse(b.installedAt):null,now,now]);entryLog(c.env,me,key,"energy.meter_created",{id,serial,contractId:b.contractId,locationId:b.locationId},b.locationId);return c.json({ok:true,id});
  });
  app.post("/api/admin/energy/readings", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});const meter=String(b.meterId||""),ts=Date.parse(b.readAt),value=Number(b.cumulativeKwh);if(!meter||!Number.isFinite(ts)||value<0)return c.json({error:"invalid_reading_fields"},400);const prev=c.env.sql.query<{cumulative_kwh:number}>("SELECT cumulative_kwh FROM energy_readings WHERE meter_id=? AND read_at<? ORDER BY read_at DESC LIMIT 1",[meter,ts])[0];const interval=prev?Math.round((value-Number(prev.cumulative_kwh))*1000)/1000:null;if(interval!=null&&interval<0)return c.json({error:"reading_lower_than_previous_requires_correction"},400);
    const now=Date.now();c.env.sql.exec("INSERT INTO energy_readings (meter_id,read_at,cumulative_kwh,interval_kwh,source,quality_status,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",[meter,ts,value,interval,b.source||"manual",b.qualityStatus||"valid",b.note||null,me.id,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);
    const baseline=c.env.sql.query<{avg_kwh:number|null}>("SELECT AVG(interval_kwh) avg_kwh FROM (SELECT interval_kwh FROM energy_readings WHERE meter_id=? AND id<>? AND interval_kwh IS NOT NULL ORDER BY read_at DESC LIMIT 7)",[meter,id])[0]?.avg_kwh;
    let alertId:number|null=null;if(interval!=null&&baseline&&interval>Number(baseline)*2){const m=c.env.sql.query<{location_id:string}>("SELECT location_id FROM energy_meters WHERE id=?",[meter])[0];const severity=interval>Number(baseline)*4?"critical":"warning";c.env.sql.exec("INSERT INTO energy_alerts (location_id,meter_id,alert_type,severity,message,status,detected_at) VALUES (?,?,'CONSUMPTION_SPIKE',?,?, 'OPEN',?)",[m?.location_id||null,meter,severity,`Odczyt ${interval} kWh przekracza ${Math.round(interval/Number(baseline)*100)/100}× średnią 7 ostatnich odczytów (${Math.round(Number(baseline)*100)/100} kWh).`,now]);alertId=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);}
    entryLog(c.env,me,key,"energy.reading_created",{id,meterId:meter,cumulativeKwh:value,intervalKwh:interval,baselineKwh:baseline??null,alertId});return c.json({ok:true,id,intervalKwh:interval,baselineKwh:baseline??null,alertId});
  });
  app.post("/api/admin/energy/invoices", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),b=await c.req.json<any>(),key=String(b.clientRequestId||"");if(!key)return c.json({error:"missing_client_request_id"},400);if(entryDuplicate(c.env,key))return c.json({ok:true,duplicate:true});const supplier=Number(b.supplierId),contract=Number(b.contractId),ps=Date.parse(b.periodStart),pe=Date.parse(b.periodEnd),due=Date.parse(b.dueAt),kwh=Number(b.consumptionKwh),net=Math.round(Number(b.netPln)*100);if(!supplier||!contract||!b.locationId||!b.invoiceNumber||!Number.isFinite(ps)||!Number.isFinite(pe)||pe<=ps||!Number.isFinite(due)||kwh<0||net<=0)return c.json({error:"invalid_energy_invoice"},400);if(c.env.sql.query("SELECT id FROM energy_invoices WHERE supplier_id=? AND invoice_number=?",[supplier,b.invoiceNumber]).length)return c.json({error:"energy_invoice_exists"},409);const vat=Math.round(net*Number(b.vatRate??23)/100),now=Date.now();c.env.sql.exec("INSERT INTO energy_invoices (supplier_id,contract_id,location_id,invoice_number,period_start,period_end,consumption_kwh,net_grosze,vat_grosze,gross_grosze,due_at,status,validation_status,document_id,bank_account,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'RECEIVED','PENDING',?,?,?,?)",[supplier,contract,b.locationId,b.invoiceNumber,ps,pe,kwh,net,vat,net+vat,due,b.documentId?Number(b.documentId):null,b.bankAccount||null,now,now]);const id=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);const validation=validateEnergyInvoice(c.env,id);entryLog(c.env,me,key,"energy.invoice_created",{id,invoiceNumber:b.invoiceNumber,validation},b.locationId);return c.json({ok:true,id,validation});
  });
  app.post("/api/admin/energy/invoices/:id/validate", requireMaster, async (c) => {const r=validateEnergyInvoice(c.env,Number(c.req.param("id")));return (r as any).error?c.json(r,404):c.json({ok:true,...r});});
  app.post("/api/admin/energy/invoices/:id/approve-payment", requireMaster, async (c) => {
    const me=c.get(APP_USER_KEY),id=Number(c.req.param("id")),inv=c.env.sql.query<any>("SELECT * FROM energy_invoices WHERE id=?",[id])[0];if(!inv)return c.json({error:"invoice_not_found"},404);if(inv.validation_status==='FAIL')return c.json({error:"invoice_validation_failed"},409);const now=Date.now(),status=inv.validation_status==='WARNING'?'ON_HOLD':'APPROVED_FOR_PAYMENT';if(!c.env.sql.query("SELECT id FROM energy_payment_orders WHERE invoice_id=?",[id]).length)c.env.sql.exec("INSERT INTO energy_payment_orders (invoice_id,amount_grosze,status,scheduled_at,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",[id,inv.gross_grosze,status,inv.due_at,me.id,now,now,now]);else c.env.sql.exec("UPDATE energy_payment_orders SET status=?,approved_by=?,approved_at=?,updated_at=? WHERE invoice_id=?",[status,me.id,now,now,id]);c.env.sql.exec("UPDATE energy_invoices SET status=?,updated_at=? WHERE id=?",[status,now,id]);return c.json({ok:true,status});
  });
  app.post("/api/admin/energy/payments/:id/mark-paid", requireMaster, async (c) => {const me=c.get(APP_USER_KEY),id=Number(c.req.param("id")),b=await c.req.json<any>();if(!b.confirmationRef)return c.json({error:"confirmation_reference_required"},400);const now=Date.now();const p=c.env.sql.query<any>("SELECT invoice_id FROM energy_payment_orders WHERE id=?",[id])[0];if(!p)return c.json({error:"payment_not_found"},404);c.env.sql.exec("UPDATE energy_payment_orders SET status='SETTLED',export_reference=?,paid_at=?,updated_at=? WHERE id=?",[b.confirmationRef,now,now,id]);c.env.sql.exec("UPDATE energy_invoices SET status='PAID_RECONCILED',updated_at=? WHERE id=?",[now,p.invoice_id]);entryLog(c.env,me,`energy:payment:${id}:${b.confirmationRef}`,"energy.payment_confirmed",{paymentId:id,confirmationRef:b.confirmationRef});return c.json({ok:true,status:"SETTLED"});});
  app.get("/api/admin/energy/payments/:id/export", requireMaster, async (c) => {const id=Number(c.req.param("id"));const p=c.env.sql.query<any>("SELECT p.id,p.amount_grosze,p.status,i.invoice_number,i.due_at,i.bank_account,s.name supplier_name,s.nip FROM energy_payment_orders p JOIN energy_invoices i ON i.id=p.invoice_id JOIN energy_suppliers s ON s.id=i.supplier_id WHERE p.id=?",[id])[0];if(!p)return c.json({error:"payment_not_found"},404);const body=`beneficiary,bank_account,amount_pln,title,due_date,status\n"${p.supplier_name}",${p.bank_account||""},${(p.amount_grosze/100).toFixed(2)},"Energia ${p.invoice_number}",${new Date(p.due_at).toISOString().slice(0,10)},${p.status}`;return new Response(body,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename=energy-payment-${id}.csv`}});});
  app.post("/api/admin/energy/alerts/:id/ack", requireMaster, async (c) => {const me=c.get(APP_USER_KEY),id=Number(c.req.param("id")),now=Date.now();c.env.sql.exec("UPDATE energy_alerts SET status='ACKNOWLEDGED',acknowledged_by=?,acknowledged_at=? WHERE id=?",[me.id,now,id]);return c.json({ok:true});});
  app.post("/api/admin/dev/seed-energy", requireMaster, async (c) => {const me=c.get(APP_USER_KEY);return c.json(seedEnergyDemo(c.env,me.id));});

  // ── PROMPT 19: pełne dane pokazowe modułów MVP (idempotentne) ───────────
  app.get("/api/admin/dev/seed-mvp-showcase", requireMaster, async (c) => {
    const seedKey = "seed:mvp-showcase:v1";
    const existingSeed = c.env.sql.query<{ id: number }>("SELECT id FROM event_log WHERE idempotency_key=? LIMIT 1", [seedKey]);
    if (existingSeed.length) {
      return c.json({ ok: true, already: true,
        reconciliations: Number(c.env.sql.query<{n:number}>("SELECT COUNT(*) n FROM reconciliations")[0].n),
        disputes: Number(c.env.sql.query<{n:number}>("SELECT COUNT(*) n FROM disputes")[0].n),
        invoices: Number(c.env.sql.query<{n:number}>("SELECT COUNT(*) n FROM invoices")[0].n),
        driverEvents: Number(c.env.sql.query<{n:number}>("SELECT COUNT(*) n FROM driver_job_events")[0].n)
      });
    }
    const me = c.get(APP_USER_KEY); const now = Date.now(); const D=86400000; const H=3600000;
    const cycle = c.env.sql.query<any>("SELECT id,period_start,period_end FROM settlement_cycles ORDER BY id DESC LIMIT 1")[0];
    if (!cycle) return c.json({ error: "no_cycle" }, 400);
    const scenarios = [
      ["NET-001", {device:12840,sorter:12760,operator:12730}, 0.86, "matched"],
      ["NET-002", {device:9840,sorter:9750,operator:9710}, 1.32, "matched"],
      ["NET-003", {device:15620,sorter:15110,operator:14860}, 4.87, "disputed"],
      ["NET-004", {device:7240,sorter:7110,operator:7090}, 2.07, "variance"],
      ["NET-005", {device:11200,sorter:11170,operator:11140}, 0.54, "matched"],
      ["NET-007", {device:13380,sorter:12810,operator:12740}, 4.78, "variance"]
    ];
    const reconIds: Record<string,number> = {};
    for (const [point,src,delta,status] of scenarios as any[]) {
      c.env.sql.exec("INSERT INTO reconciliations (cycle_id,scope_type,scope_ref,source_a_json,source_b_json,source_c_json,delta_ab,delta_bc,delta_ac,delta_pct,status,created_at) VALUES (?, 'location', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [cycle.id,point,JSON.stringify({source:"RVM",packages:src.device}),JSON.stringify({source:"hub_scale",packages:src.sorter}),JSON.stringify({source:"deposit_operator",packages:src.operator}),Math.abs(src.device-src.sorter),Math.abs(src.sorter-src.operator),Math.abs(src.device-src.operator),delta,status,now]);
      reconIds[point]=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);
    }
    const evidenceA = [{type:"device_snapshot",ref:"NET-003/RVM/2026-08",packages:15620},{type:"hub_weighing",ref:"HUB-WRO/PL-88421",packages:15110},{type:"operator_report",ref:"RESELEKT-2026-08-003",packages:14860}];
    c.env.sql.exec("INSERT INTO disputes (reconciliation_id,state,due_at,evidence_json,disputed_amount_grosze,outcome,default_action_taken,created_at,updated_at) VALUES (?, 'EVIDENCE_REQUIRED', ?, ?, 124500, NULL, 0, ?, ?)",[reconIds["NET-003"],now+5*D,JSON.stringify(evidenceA),now,now]);
    const disputeA=Number(c.env.sql.query<{id:number}>("SELECT last_insert_rowid() id")[0].id);
    const evidenceB = [{type:"driver_proof",ref:"COLL-NET-007-20260810",seal:"PL-99318",gps:[52.196,20.884]},{type:"photo",ref:"evidence://demo/net-007-bags"}];
    c.env.sql.exec("INSERT INTO disputes (reconciliation_id,state,due_at,evidence_json,disputed_amount_grosze,outcome,default_action_taken,created_at,updated_at) VALUES (?, 'INQUIRY_PROCESSING', ?, ?, 68900, NULL, 0, ?, ?)",[reconIds["NET-007"],now+3*D,JSON.stringify(evidenceB),now,now]);
    const org = c.env.sql.query<{investor_org_id:number}>("SELECT investor_org_id FROM locations WHERE id='NET-003'")[0];
    const holdKey=`demo:dispute-hold:${disputeA}`;
    if(org?.investor_org_id && !c.env.sql.query("SELECT id FROM ledger_entries WHERE end_to_end_id=?",[holdKey]).length){
      const net=124500,vat=Math.round(net*.23); await insertLedgerEntry(c.env,{cycleId:cycle.id,entryType:"DISPUTE_HOLD",partyOrgId:org.investor_org_id,direction:"debit",amountNet:net,vatRate:23,vatAmount:vat,amountGross:net+vat,locationId:"NET-003",eventDate:cycle.period_end,operationalDate:now,bookingDate:now,endToEndId:holdKey,author:"seed:showcase",source:`demo:dispute:${disputeA}`});
    }
    const invs=c.env.sql.query<any>("SELECT id,name FROM investors ORDER BY id LIMIT 2");
    const invoices = [
      ["KSeF-2026-08-000041", "Abonament platformy — 6 punktów", 369000, "2026-08-01", "zaakceptowana", invs[0]?.id],
      ["KSeF-2026-08-000042", "Moduł kierowcy — 3 pojazdy", 81180, "2026-08-01", "zaakceptowana", invs[0]?.id],
      ["KSeF-2026-08-000043", "Abonament platformy — 4 punkty", 246000, "2026-08-01", "wysłana", invs[1]?.id],
      ["KSeF-2026-07-000037", "Rozliczenie korekty NET-007", -68900, "2026-07-31", "korekta", invs[1]?.id]
    ];
    for(const [ksef,title,amount,date,status,investorId] of invoices as any[]){ if(!c.env.sql.query("SELECT id FROM invoices WHERE ksef_number=?",[ksef]).length)c.env.sql.exec("INSERT INTO invoices (ksef_number,recipient,investor_id,driver_id,title,amount_grosze,issue_date,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)",[ksef, investorId===invs[0]?.id?(invs[0]?.name||"Inwestor A"):(invs[1]?.name||"Inwestor B"),investorId,null,title,amount,date,status,now]); }
    const driver=c.env.sql.query<{id:number}>("SELECT id FROM drivers ORDER BY id LIMIT 1")[0];
    const devEvents=[
      ["NET-001","ACCEPTED",null,"Trasa poranna — potwierdzona",now-26*H],
      ["NET-001","COMPLETED",null,"Odebrano 8 worków, plomby PL-88001–PL-88008",now-24*H],
      ["NET-003","FAILED","BRAK_DOSTEPU","Brama techniczna zamknięta; kontakt z administracją",now-20*H],
      ["NET-005","COMPLETED",null,"Odebrano 5 worków; bez uwag",now-8*H],
      ["NET-007","FAILED","BRAK_MIEJSCA_W_POJEZDZIE","Pojazd osiągnął limit masy; punkt wraca do puli",now-4*H]
    ];
    if(driver) for(let i=0;i<devEvents.length;i++){const [point,action,reason,notes,ts]=devEvents[i] as any[];recordDriverJobEvent(c.env,driver.id,{clientEventId:`showcase:v1:driver:${i}`,pointId:point,action,reasonCode:reason,notes,occurredAt:ts,syncSource:i===4?"offline":"online",evidence:{gps:[52.2+i*.01,21.0-i*.01],timestamp:ts,photoRef:action==="FAILED"?`evidence://demo/${point.toLowerCase()}`:null}})}
    const manifest=getSettlementManifest(c.env,cycle.id);
    c.env.sql.exec("INSERT INTO event_log (cycle_id,event_type,idempotency_key,payload_json,source,actor_id,created_at) VALUES (?, 'seed.mvp_showcase', ?, ?, 'admin_ui', ?, ?)",[cycle.id,seedKey,JSON.stringify({scenarios:scenarios.length,disputes:2,invoices:invoices.length,driverEvents:devEvents.length,manifestGroups:(manifest as any).groups?.length||0}),me.id,now]);
    return c.json({ok:true,cycleId:cycle.id,reconciliations:scenarios.length,disputes:2,invoices:invoices.length,driverEvents:devEvents.length,manifestGroups:(manifest as any).groups?.length||0,manifestLegs:(manifest as any).legs?.length||0});
  });

  app.post("/admin/reseed", async (c) => {
    if (!c.env.ctx.session?.isOwner) return c.json({ error: "forbidden" }, 403);
    await reseed(c.env);
    return c.json({ ok: true });
  });

  // ─── PROMPT 5: execute-hold (Z1) + export (Z4) ─────────────────────────────────────

  // Z1: POST /api/admin/disputes/:id/execute-hold
  // Ręczne mrożenie kwoty spornej przy otwarciu sporu (alternatywa do automatycznego DISPUTE_HOLD przy runSettlementEngine).
  app.post("/api/admin/disputes/:id/execute-hold", requireMaster, async (c) => {
    const disputeId = Number(c.req.param("id"));
    const now = Date.now();

    // 1. Pobierz dispute
    const dispute = c.env.sql.query<{ id: number; state: string; reconciliation_id: number; disputed_amount_grosze: number | null }>(
      "SELECT id, state, reconciliation_id, disputed_amount_grosze FROM disputes WHERE id = ?",
      [disputeId]
    );
    if (dispute.length === 0) return c.json({ ok: false, error: "not_found" }, 404);

    // 2. Pobierz reconciliation (cycle_id + scope_ref = location_id)
    const recon = c.env.sql.query<{ cycle_id: number; scope_ref: string }>(
      "SELECT cycle_id, scope_ref FROM reconciliations WHERE id = ?",
      [dispute[0].reconciliation_id]
    );
    if (recon.length === 0) return c.json({ ok: false, error: "reconciliation_not_found" }, 404);

    const cycleId = recon[0].cycle_id;
    const locationId = recon[0].scope_ref;

    // 3. Pobierz investor_org_id z locations
    const loc = c.env.sql.query<{ investor_org_id: number | null }>(
      "SELECT investor_org_id FROM locations WHERE id = ?",
      [locationId]
    );
    if (loc.length === 0 || !loc[0].investor_org_id) {
      return c.json({ ok: false, error: "location_or_investor_not_found" }, 404);
    }
    const investorOrgId = loc[0].investor_org_id;

    // 4. Utwórz DISPUTE_HOLD ledger entry przez insertLedgerEntry (z hash chain + author/source)
    const amountNet = dispute[0].disputed_amount_grosze ?? 0;
    const vatAmount = Math.round(amountNet * 23 / 100);
    const amountGross = amountNet + vatAmount;

    await insertLedgerEntry(c.env, {
      cycleId, entryType: "DISPUTE_HOLD", partyOrgId: investorOrgId, direction: "debit",
      amountNet, vatRate: 23, vatAmount, amountGross,
      locationId, eventDate: now, operationalDate: now, bookingDate: now,
      rateCardId: null,
      author: `master:execute_hold:${disputeId}`,
      source: `manual:execute_hold:${disputeId}`,
    });

    // 5. Log event (audyt)
    c.env.sql.exec(
      "INSERT INTO event_log (event_type, payload_json, actor_id, created_at) VALUES ('dispute_hold_executed', ?, 1, ?)",
      [JSON.stringify({ disputeId, cycleId, locationId, amount: amountNet }), now]
    );

    return c.json({ ok: true, disputeId, cycleId, locationId, amount: amountNet });
  });

  // Z4: GET /api/admin/cycles/:id/export?format=csv|html
  // Eksport per-location dla inwestora. CSV = surowe dane, HTML = print-friendly (user drukuje do PDF).
  // Estetyka minimalna, poprawność absolutna — brak emoji, tylko kwoty grosze→zł.
  app.get("/api/admin/cycles/:id/export", requireMaster, async (c) => {
    const cycleId = Number(c.req.param("id"));
    const format = c.req.query("format") ?? "csv";

    const cycle = c.env.sql.query<{ id: number; label: string; period_start: number; period_end: number }>(
      "SELECT id, label, period_start, period_end FROM settlement_cycles WHERE id = ?",
      [cycleId]
    );
    if (cycle.length === 0) return c.json({ ok: false, error: "not_found" }, 404);

    // Per-location aggregation: packages + deposit + fee breakdown per entry_type
    const perLocation = c.env.sql.query<any>(
      "SELECT " +
      "  l.id AS point_id, " +
      "  l.address, " +
      "  COALESCE(SUM(oc.packages), 0) AS packages, " +
      "  COALESCE(SUM(oc.amount_grosze), 0) AS deposit_grosze, " +
      "  COALESCE(SUM(CASE WHEN le.entry_type = 'DRIVER_FEE' THEN le.amount_net ELSE 0 END), 0) AS driver_fee_net, " +
      "  COALESCE(SUM(CASE WHEN le.entry_type = 'CARRIER_FEE' THEN le.amount_net ELSE 0 END), 0) AS carrier_fee_net, " +
      "  COALESCE(SUM(CASE WHEN le.entry_type = 'DEPOSIT_REIMBURSEMENT' THEN le.amount_net ELSE 0 END), 0) AS deposit_reimbursement_net, " +
      "  COALESCE(SUM(CASE WHEN le.entry_type = 'DISPUTE_HOLD' THEN le.amount_net ELSE 0 END), 0) AS dispute_hold_net, " +
      "  COALESCE(SUM(CASE WHEN le.entry_type = 'HANDLING_FEE' THEN le.amount_net ELSE 0 END), 0) AS handling_fee_net, " +
      "  COALESCE(SUM(CASE WHEN le.entry_type = 'PLATFORM_SUBSCRIPTION' AND le.location_id = l.id THEN le.amount_net ELSE 0 END), 0) AS platform_fee_net " +
      "FROM operator_credits oc " +
      "LEFT JOIN locations l ON l.id = oc.point_id " +
      "LEFT JOIN ledger_entries le ON le.location_id = oc.point_id AND le.cycle_id = oc.cycle_id AND le.reversal_of_id IS NULL " +
      "WHERE oc.cycle_id = ? " +
      "GROUP BY l.id, l.address " +
      "ORDER BY l.id",
      [cycleId]
    );

    if (format === "csv") {
      const rows = ["point_id,address,packages,deposit_grosze,driver_fee_net,carrier_fee_net,deposit_reimbursement_net,dispute_hold_net,handling_fee_net,platform_fee_net"];
      for (const row of perLocation) {
        rows.push([
          row.point_id,
          `"${String(row.address).replace(/"/g, '""')}"`,
          row.packages,
          row.deposit_grosze,
          row.driver_fee_net,
          row.carrier_fee_net,
          row.deposit_reimbursement_net,
          row.dispute_hold_net,
          row.handling_fee_net,
          row.platform_fee_net,
        ].join(","));
      }
      return new Response(rows.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="cycle-${cycle[0].label}-${cycleId}.csv"`,
        },
      });
    }

    // HTML (print-friendly → user drukuje do PDF w przeglądarce)
    const htmlRows = perLocation.map(row => `
    <tr>
      <td>${row.point_id}</td>
      <td>${row.address}</td>
      <td style="text-align:right">${row.packages}</td>
      <td style="text-align:right">${(row.deposit_grosze / 100).toFixed(2)} zł</td>
      <td style="text-align:right">${(row.driver_fee_net / 100).toFixed(2)} zł</td>
      <td style="text-align:right">${(row.carrier_fee_net / 100).toFixed(2)} zł</td>
      <td style="text-align:right">${(row.deposit_reimbursement_net / 100).toFixed(2)} zł</td>
      <td style="text-align:right">${(row.dispute_hold_net / 100).toFixed(2)} zł</td>
      <td style="text-align:right">${(row.handling_fee_net / 100).toFixed(2)} zł</td>
      <td style="text-align:right">${(row.platform_fee_net / 100).toFixed(2)} zł</td>
    </tr>`).join("");

    const html = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Rozliczenie cyklu ${cycle[0].label}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1200px; margin: 2em auto; padding: 0 1em; color: #222; }
  h1 { font-size: 1.4em; margin-bottom: 0.2em; font-weight: 600; }
  .meta { color: #666; margin-bottom: 2em; font-size: 0.95em; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; }
  th { background: #f5f5f5; text-align: left; font-weight: 600; }
  @media print { body { margin: 1em; } }
  footer { margin-top: 2em; color: #666; font-size: 0.85em; }
</style>
</head>
<body>
<h1>Rozliczenie cyklu: ${cycle[0].label}</h1>
<div class="meta">Okres: ${new Date(cycle[0].period_start).toISOString().slice(0,10)} – ${new Date(cycle[0].period_end).toISOString().slice(0,10)}</div>
<table>
  <thead>
    <tr>
      <th>Punkt</th>
      <th>Adres</th>
      <th style="text-align:right">Opakowania</th>
      <th style="text-align:right">Kaucja</th>
      <th style="text-align:right">Kierowca</th>
      <th style="text-align:right">Transport</th>
      <th style="text-align:right">Inwestor</th>
      <th style="text-align:right">DISPUTE_HOLD</th>
      <th style="text-align:right">Handling</th>
      <th style="text-align:right">Platforma</th>
    </tr>
  </thead>
  <tbody>${htmlRows}</tbody>
</table>
<footer>Wygenerowano: ${new Date().toISOString()} | edrs.io MVP v2</footer>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="cycle-${cycle[0].label}-${cycleId}.html"`,
      },
    });
  });


  return app;
}

export default {
  fetch: async (req: Request, env: any, ctx: any) => {
    const app = createApp();
    return app.fetch(req, env, ctx);
  },
  // PROMPT 8: cron co godzinę (app.md triggers.schedule) — agenci wewnętrzni.
  // Hook MUSI nazywać się onSchedule (nie `scheduled`) — kontrakt Sauna Apps.
  async onSchedule(env: any, _ctx: any) {
    await ensureSeeded(env);
    await runAllAgents(env);
  },
} satisfies AppHandler;
