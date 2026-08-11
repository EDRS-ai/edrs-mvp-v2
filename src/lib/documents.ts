// PROMPT 12 — Archiwum dokumentów (wzór eMieszkaniec) + sprawozdania miesięczne.
//
// Dokumenty: bajty shardowane w doc_blobs po ≤1.8 MB (limit wiersza SQLite ~2 MB).
// Limit pliku: 6 MB (base64 upload przez JSON — bezpiecznie poniżej limitu dispatch).
// org_id NULL = dokument globalny (widoczny dla wszystkich inwestorów).
//
// Sprawozdania: HTML per inwestor per okres (YYYY-MM) renderowany z ledgera —
// widok, nie nowa logika księgowa. Akceptacja = wiersz w statement_acceptances
// (unique org+period) + event `statement_accepted` (ślad audytowy, odpowiednik
// „uchwały" u zarządcy wspólnot).

const SHARD_BYTES = 1_800_000;
export const MAX_DOC_BYTES = 6_000_000;
export const DOC_CATEGORIES = ["umowa", "protokol", "regulamin", "sprawozdanie", "inne"] as const;

export function saveDocument(
  env: any,
  doc: { orgId: number | null; title: string; category: string; filename: string; mimeType: string; bytes: Uint8Array; uploadedBy: number }
): { id: number; shards: number } {
  const now = Date.now();
  env.sql.exec(
    "INSERT INTO documents (org_id, title, category, filename, mime_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [doc.orgId, doc.title, doc.category, doc.filename, doc.mimeType, doc.bytes.byteLength, doc.uploadedBy, now]
  );
  const id = Number(env.sql.query<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id);
  let shards = 0;
  for (let off = 0; off < doc.bytes.byteLength; off += SHARD_BYTES) {
    const chunk = doc.bytes.slice(off, Math.min(off + SHARD_BYTES, doc.bytes.byteLength));
    env.sql.exec("INSERT INTO doc_blobs (doc_id, idx, bytes) VALUES (?, ?, ?)", [id, shards, chunk]);
    shards++;
  }
  return { id, shards };
}

export function readDocument(env: any, docId: number): { meta: any; bytes: Uint8Array } | null {
  const meta = env.sql.query<any>(
    "SELECT id, org_id, title, category, filename, mime_type, size_bytes, created_at FROM documents WHERE id = ? AND deleted_at IS NULL",
    [docId]
  )[0];
  if (!meta) return null;
  const rows = env.sql.query<any>("SELECT idx, bytes FROM doc_blobs WHERE doc_id = ? ORDER BY idx", [docId]);
  const out = new Uint8Array(Number(meta.size_bytes));
  let off = 0;
  for (const r of rows) {
    // BLOB wraca jako ArrayBuffer — wrap przed set (bare cast rzuca w runtime).
    const chunk = new Uint8Array(r.bytes as ArrayBuffer);
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  if (off !== Number(meta.size_bytes)) {
    console.error(`[documents] size mismatch doc=${docId} expected=${meta.size_bytes} got=${off}`);
    return null;
  }
  return { meta, bytes: out };
}

export function listDocuments(env: any, orgId: number | null): any[] {
  if (orgId === null) {
    // master: wszystkie
    return env.sql.query<any>(
      `SELECT d.id, d.org_id, o.name AS org_name, d.title, d.category, d.filename, d.mime_type, d.size_bytes, d.created_at
         FROM documents d LEFT JOIN organizations o ON o.id = d.org_id
        WHERE d.deleted_at IS NULL ORDER BY d.id DESC LIMIT 200`
    );
  }
  // inwestor: własne + globalne
  return env.sql.query<any>(
    `SELECT d.id, d.org_id, d.title, d.category, d.filename, d.mime_type, d.size_bytes, d.created_at
       FROM documents d WHERE d.deleted_at IS NULL AND (d.org_id = ? OR d.org_id IS NULL)
      ORDER BY d.id DESC LIMIT 200`,
    [orgId]
  );
}

// ── Sprawozdania miesięczne ──────────────────────────────────────────────────

const esc = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));
const pln = (grosze: number) =>
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(grosze / 100);

export function statementPeriods(env: any, orgId: number): { period: string; entries: number; net: number; accepted_at: number | null }[] {
  return env.sql.query<any>(
    `SELECT strftime('%Y-%m', COALESCE(le.booking_date, le.created_at) / 1000, 'unixepoch') AS period,
            COUNT(*) AS entries,
            SUM(CASE WHEN le.direction = 'credit' THEN le.amount_net ELSE -le.amount_net END) AS net,
            (SELECT accepted_at FROM statement_acceptances sa WHERE sa.org_id = ? AND sa.period = strftime('%Y-%m', COALESCE(le.booking_date, le.created_at) / 1000, 'unixepoch')) AS accepted_at
       FROM ledger_entries le WHERE le.party_org_id = ?
      GROUP BY period ORDER BY period DESC`,
    [orgId, orgId]
  );
}

export function renderStatementHtml(env: any, orgId: number, period: string): string | null {
  const org = env.sql.query<any>("SELECT id, name, nip FROM organizations WHERE id = ?", [orgId])[0];
  if (!org) return null;
  const entries = env.sql.query<any>(
    `SELECT le.id, le.entry_type, le.direction, le.amount_net, le.vat_amount, le.amount_gross, le.location_id,
            COALESCE(le.booking_date, le.created_at) AS at, le.source, sc.label AS cycle_label
       FROM ledger_entries le LEFT JOIN settlement_cycles sc ON sc.id = le.cycle_id
      WHERE le.party_org_id = ? AND strftime('%Y-%m', COALESCE(le.booking_date, le.created_at) / 1000, 'unixepoch') = ?
      ORDER BY le.id`,
    [orgId, period]
  );
  const credits = entries.filter((e: any) => e.direction === "credit");
  const debits = entries.filter((e: any) => e.direction === "debit");
  const sum = (rows: any[], f: string) => rows.reduce((s, r) => s + Number(r[f] ?? 0), 0);
  const netBalance = sum(credits, "amount_net") - sum(debits, "amount_net");
  const grossBalance = sum(credits, "amount_gross") - sum(debits, "amount_gross");
  const acceptance = env.sql.query<any>(
    "SELECT sa.accepted_at, u.name AS accepted_by_name FROM statement_acceptances sa LEFT JOIN users u ON u.id = sa.accepted_by WHERE sa.org_id = ? AND sa.period = ?",
    [orgId, period]
  )[0];

  const row = (e: any) =>
    `<tr><td>${esc(e.entry_type)}</td><td>${esc(e.cycle_label ?? "—")}</td><td>${esc(e.location_id ?? "—")}</td>` +
    `<td class="num">${esc(pln(e.amount_net))}</td><td class="num">${esc(pln(e.vat_amount))}</td><td class="num">${esc(pln(e.amount_gross))}</td>` +
    `<td>${esc(new Date(Number(e.at)).toLocaleDateString("pl-PL"))}</td></tr>`;

  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<title>Rozliczenie ${esc(period)} — ${esc(org.name)}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:40px auto;max-width:900px;color:#111827;font-size:13px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;margin:24px 0 8px;color:#374151}
  .meta{color:#6b7280;margin-bottom:24px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th{text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;padding:6px 8px;font-size:11px;text-transform:uppercase}
  td{border-bottom:1px solid #f3f4f6;padding:6px 8px}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .summary{display:flex;gap:16px;margin:16px 0}
  .card{border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;flex:1}
  .card .l{font-size:11px;color:#6b7280;text-transform:uppercase}
  .card .v{font-size:18px;font-weight:700;margin-top:2px}
  .pos{color:#047857}.neg{color:#b91c1c}
  .accept{margin-top:24px;padding:12px 16px;border-radius:8px;border:1px solid #d1fae5;background:#ecfdf5;color:#065f46}
  .pending{border-color:#fde68a;background:#fffbeb;color:#92400e}
  footer{margin-top:32px;color:#9ca3af;font-size:11px}
  .brand{display:flex;align-items:center;gap:8px;margin-bottom:24px}
  .logo{width:28px;height:28px;background:#059669;border-radius:8px}
</style></head><body>
<div class="brand"><div class="logo"></div><strong>edrs.io</strong> · rozliczenie miesięczne</div>
<h1>Rozliczenie za ${esc(period)}</h1>
<div class="meta">${esc(org.name)}${org.nip ? ` · NIP ${esc(org.nip)}` : ""} · wygenerowano ${esc(new Date().toLocaleString("pl-PL"))}</div>
<div class="summary">
  <div class="card"><div class="l">Uznania netto</div><div class="v pos">${esc(pln(sum(credits, "amount_net")))}</div></div>
  <div class="card"><div class="l">Obciążenia netto</div><div class="v neg">${esc(pln(sum(debits, "amount_net")))}</div></div>
  <div class="card"><div class="l">Saldo netto okresu</div><div class="v ${netBalance >= 0 ? "pos" : "neg"}">${esc(pln(netBalance))}</div></div>
  <div class="card"><div class="l">Saldo brutto okresu</div><div class="v ${grossBalance >= 0 ? "pos" : "neg"}">${esc(pln(grossBalance))}</div></div>
</div>
<h2>Uznania (${credits.length})</h2>
<table><thead><tr><th>Typ</th><th>Cykl</th><th>Punkt</th><th class="num">Netto</th><th class="num">VAT</th><th class="num">Brutto</th><th>Data</th></tr></thead>
<tbody>${credits.map(row).join("") || '<tr><td colspan="7">Brak</td></tr>'}</tbody></table>
<h2>Obciążenia (${debits.length})</h2>
<table><thead><tr><th>Typ</th><th>Cykl</th><th>Punkt</th><th class="num">Netto</th><th class="num">VAT</th><th class="num">Brutto</th><th>Data</th></tr></thead>
<tbody>${debits.map(row).join("") || '<tr><td colspan="7">Brak</td></tr>'}</tbody></table>
${acceptance
    ? `<div class="accept">Rozliczenie zaakceptowane ${esc(new Date(Number(acceptance.accepted_at)).toLocaleString("pl-PL"))} przez ${esc(acceptance.accepted_by_name ?? "inwestora")}.</div>`
    : `<div class="accept pending">Rozliczenie oczekuje na akceptację inwestora.</div>`}
<footer>edrs.io MVP v2 · ledger append-only z łańcuchem SHA-256 · dokument wygenerowany automatycznie</footer>
</body></html>`;
}

export function acceptStatement(env: any, orgId: number, period: string, userId: number): { ok: boolean; already?: boolean } {
  const ex = env.sql.query<{ id: number }>("SELECT id FROM statement_acceptances WHERE org_id = ? AND period = ?", [orgId, period]);
  if (ex.length > 0) return { ok: true, already: true };
  const now = Date.now();
  env.sql.exec("INSERT INTO statement_acceptances (org_id, period, accepted_by, accepted_at) VALUES (?, ?, ?, ?)", [orgId, period, userId, now]);
  env.sql.exec(
    "INSERT INTO event_log (event_type, payload_json, source, actor_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ["statement_accepted", JSON.stringify({ orgId, period }), "investor_panel", userId, now]
  );
  return { ok: true };
}
