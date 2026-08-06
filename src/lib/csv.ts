export type CsvParseResult = {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
};

export function parseCsv(text: string, hasHeader = true): CsvParseResult {
  const errors: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [], errors: ["Plik jest pusty"] };

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += ch;
      } else {
        if (ch === ",") { out.push(cur); cur = ""; }
        else if (ch === '"') inQuotes = true;
        else cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  let headers: string[];
  let bodyStart = 0;
  if (hasHeader) {
    headers = parseLine(lines[0]).map((h) => h.toLowerCase());
    bodyStart = 1;
  } else {
    errors.push("Wymagany nagłówek w pierwszej linii");
  }
  const rows: Record<string, string>[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    if (cells.length === 1 && cells[0] === "") continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cells[j] ?? "";
    rows.push(row);
  }
  return { headers, rows, errors };
}

export type ParsedCreditRow = { pointId: string; packages: number; amountGrosze: number; sourceReference?: string; raw: Record<string, string>; rowNum: number };
export type ParsedReceiptRow = { pointId: string; packages: number; sourceReference?: string; raw: Record<string, string>; rowNum: number };
export type ParsedCollectionRow = { pointId: string; packages: number; driverName?: string; collectedAt?: number; raw: Record<string, string>; rowNum: number };
export type ValidationResult<T> = { rows: T[]; errors: string[] };

export function validateCredits(rows: Record<string, string>[]): ValidationResult<ParsedCreditRow> {
  const errors: string[] = [];
  const ok: ParsedCreditRow[] = [];
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const pointId = (r["punkt_id"] ?? r["point_id"] ?? "").trim();
    const szt = Number((r["szt"] ?? r["packages"] ?? "").toString().replace(",", "."));
    const kwota = (r["kwota_pln"] ?? r["amount_pln"] ?? "").toString().replace(",", ".");
    if (!pointId) errors.push(`Wiersz ${rowNum}: brak punkt_id`);
    if (!Number.isFinite(szt) || szt < 0) errors.push(`Wiersz ${rowNum}: nieprawidłowa liczba opakowań`);
    const amountGrosze = Number.isFinite(parseFloat(kwota)) ? Math.round(parseFloat(kwota) * 100) : NaN;
    if (!Number.isFinite(amountGrosze) || amountGrosze < 0) errors.push(`Wiersz ${rowNum}: nieprawidłowa kwota PLN`);
    const ref = (r["referencja"] ?? r["reference"] ?? "").trim() || undefined;
    if (pointId && Number.isFinite(szt) && Number.isFinite(amountGrosze)) {
      ok.push({ pointId, packages: szt, amountGrosze, sourceReference: ref, raw: r, rowNum });
    }
  });
  return { rows: ok, errors };
}

export function validateReceipts(rows: Record<string, string>[]): ValidationResult<ParsedReceiptRow> {
  const errors: string[] = [];
  const ok: ParsedReceiptRow[] = [];
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const pointId = (r["punkt_id"] ?? r["point_id"] ?? "").trim();
    const szt = Number((r["szt"] ?? r["packages"] ?? "").toString().replace(",", "."));
    if (!pointId) errors.push(`Wiersz ${rowNum}: brak punkt_id`);
    if (!Number.isFinite(szt) || szt < 0) errors.push(`Wiersz ${rowNum}: nieprawidłowa liczba opakowań`);
    const ref = (r["referencja"] ?? r["reference"] ?? "").trim() || undefined;
    if (pointId && Number.isFinite(szt)) {
      ok.push({ pointId, packages: szt, sourceReference: ref, raw: r, rowNum });
    }
  });
  return { rows: ok, errors };
}

export function validateCollections(rows: Record<string, string>[]): ValidationResult<ParsedCollectionRow> {
  const errors: string[] = [];
  const ok: ParsedCollectionRow[] = [];
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const pointId = (r["punkt_id"] ?? r["point_id"] ?? "").trim();
    const szt = Number((r["szt"] ?? r["packages"] ?? "").toString().replace(",", "."));
    const driverName = (r["kierowca"] ?? r["driver"] ?? "").trim() || undefined;
    const dateRaw = (r["data"] ?? r["collected_at"] ?? "").trim();
    let collectedAt: number | undefined;
    if (dateRaw) {
      const parsed = Date.parse(dateRaw);
      if (Number.isFinite(parsed)) collectedAt = parsed;
      else errors.push(`Wiersz ${rowNum}: nieprawidłowa data (${dateRaw})`);
    }
    if (!pointId) errors.push(`Wiersz ${rowNum}: brak punkt_id`);
    if (!Number.isFinite(szt) || szt < 0) errors.push(`Wiersz ${rowNum}: nieprawidłowa liczba opakowań`);
    if (pointId && Number.isFinite(szt)) {
      ok.push({ pointId, packages: szt, driverName, collectedAt, raw: r, rowNum });
    }
  });
  return { rows: ok, errors };
}
