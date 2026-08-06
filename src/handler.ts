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

type Bindings = { sql: any; websocket: any; ctx: AppCtx };

// NOTE: PROMPT 0 scope = auth fix only. These pricing constants will move to
// rate_cards in PROMPT 1. Do not touch in this commit.
const PLATFORM_FEE_PER_POINT_GROSZE = 14900;
const SETTLEMENT_FEE_PER_PACKAGE_GROSZE = 0.25;
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

  app.get("/api/admin/overview", requireMaster, async (c) => {
    const investorCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM investors WHERE status='active'")[0].n);
    const driverCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM drivers WHERE status='active'")[0].n);
    const pointCount = Number(c.env.sql.query<{ n: number }>("SELECT COUNT(*) AS n FROM points")[0].n);
    const packagesMonth = Number(c.env.sql.query<{ value: string }>("SELECT value FROM meta WHERE key='packagesMonth'")[0].value);
    const collectionsMonth = Number(c.env.sql.query<{ value: string }>("SELECT value FROM meta WHERE key='collectionsMonth'")[0].value);
    const platformFee = pointCount * PLATFORM_FEE_PER_POINT_GROSZE;
    const settlementFee = Math.round(packagesMonth * SETTLEMENT_FEE_PER_PACKAGE_GROSZE);
    const monthlyRecurring = platformFee + settlementFee;
    return c.json({
      investorsCount: investorCount,
      driversCount: driverCount,
      pointsCount: pointCount,
      packagesMonth,
      collectionsMonth,
      platformFeeGrosze: platformFee,
      settlementFeeGrosze: settlementFee,
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

    const result = runSettlementEngine(c.env, id, cycle);
    logEvent(c.env, { cycleId: id, eventType: "settlement_engine_run", payload: { entriesCreated: result.entriesCreated, partySummary: result.partySummary, errors: result.errors }, actorId: me.id });
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

    c.env.sql.exec("BEGIN TRANSACTION");
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
      c.env.sql.exec("COMMIT");
    } catch (e: any) {
      c.env.sql.exec("ROLLBACK");
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
  }
} satisfies AppHandler;
