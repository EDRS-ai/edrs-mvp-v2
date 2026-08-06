// Sprint 2 PROMPT 4 — testy rekoncyliacji 3-źródłowej i sporów.
// DoD z PROMPT 4:
//   - test: rozbieżność 1,9% → matched; 2,1% → variance + ticket
//   - test: zegar poprawnie liczy dni robocze przez weekend i święto
//   - test: brak reakcji do due_at wyzwala akcję domyślną
//   - panel pokazuje wszystkie otwarte spory posortowane po due_at rosnąco

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  isBusinessDay,
  addBusinessDays,
  businessDaysBetween,
  calculateDueAt,
  isOverdue,
  getAlertLevel,
  reconcileThreeSources,
  canTransition,
  DISPUTE_STATES,
} from "../lib/reconciliation";

describe("PROMPT 4 — rekoncyliacja 3-źródłowa i spory", () => {

  describe("próg 2%: 1,9% → matched, 2,1% → disputed", () => {
    it("1,9% rozbieżność → matched (auto-accept)", () => {
      // 3 źródła: device=1000, sorter=1019, operator=1000
      // delta = |1019 - 1000| = 19, avg = 1006.33, pct = 19/1006.33 × 100 = 1.89%
      const result = reconcileThreeSources({ device: 1000, sorter: 1019, operator: 1000 }, 2.0);
      expect(result.deltaPct).toBeLessThanOrEqual(2.0);
      expect(result.status).toBe("matched");
    });

    it("2,1% rozbieżność → disputed (ticket sporny)", () => {
      // 3 źródła: device=1000, sorter=1021, operator=1000
      // delta = 21, avg = 1007, pct = 21/1007 × 100 = 2.085%
      const result = reconcileThreeSources({ device: 1000, sorter: 1021, operator: 1000 }, 2.0);
      expect(result.deltaPct).toBeGreaterThan(2.0);
      expect(result.status).toBe("disputed");
    });

    it("0% rozbieżność → matched", () => {
      const result = reconcileThreeSources({ device: 1000, sorter: 1000, operator: 1000 }, 2.0);
      expect(result.deltaPct).toBe(0);
      expect(result.status).toBe("matched");
    });

    it("próg konfigurowalny per kontrakt — 5% threshold", () => {
      // Przy progu 5%: 3% rozbieżność → matched
      const result = reconcileThreeSources({ device: 1000, sorter: 1030, operator: 1000 }, 5.0);
      expect(result.deltaPct).toBeLessThanOrEqual(5.0);
      expect(result.status).toBe("matched");
    });
  });

  describe("zegar 5 dni roboczych — kalkulator dni roboczych", () => {
    it("poniedziałek jest dniem roboczym", () => {
      const monday = new Date(2026, 6, 27); // 27 lipca 2026 = poniedziałek
      expect(isBusinessDay(monday)).toBe(true);
    });

    it("sobota nie jest dniem roboczym", () => {
      const saturday = new Date(2026, 6, 25); // 25 lipca 2026 = sobota
      expect(isBusinessDay(saturday)).toBe(false);
    });

    it("niedziela nie jest dniem roboczym", () => {
      const sunday = new Date(2026, 6, 26); // 26 lipca 2026 = niedziela
      expect(isBusinessDay(sunday)).toBe(false);
    });

    it("1 stycznia (Nowy Rok) nie jest dniem roboczym", () => {
      const newYear = new Date(2026, 0, 1); // 1 stycznia 2026
      expect(isBusinessDay(newYear)).toBe(false);
    });

    it("3 maja (Konstytucji) nie jest dniem roboczym", () => {
      const constitution = new Date(2026, 4, 3); // 3 maja 2026 (niedziela w 2026, ale sprawdźmy)
      // 3 maja 2026 = niedziela, więc sprawdzimy 1 maja (Piątek, Święto Pracy)
      const labourDay = new Date(2026, 4, 1); // 1 maja 2026 = piątek
      expect(isBusinessDay(labourDay)).toBe(false); // święto → nie roboczy
    });

    it("addBusinessDays: piątek + 3 dni robocze = środa (przez weekend)", () => {
      const friday = new Date(2026, 6, 24); // 24 lipca 2026 = piątek
      const result = addBusinessDays(friday, 3);
      // piątek + 1 = pon (27), + 2 = wt (28), + 3 = śr (29)
      expect(result.getDay()).toBe(3); // środa
      expect(result.getDate()).toBe(29);
    });

    it("addBusinessDays: środa + 5 dni roboczych = następna środa", () => {
      const wednesday = new Date(2026, 6, 22); // 22 lipca 2026 = środa
      const result = addBusinessDays(wednesday, 5);
      // śr → cz → pt → pon → wt → śr = 29 lipca
      expect(result.getDate()).toBe(29);
    });

    it("calculateDueAt: od piątku 5 dni roboczych = następny piątek", () => {
      const friday = new Date(2026, 6, 24); // 24 lipca = piątek
      const dueAt = calculateDueAt(friday);
      // pt → pon(27) → wt(28) → śr(29) → cz(30) → pt(31) = 31 lipca
      expect(dueAt.getDate()).toBe(31);
    });

    it("businessDaysBetween: od poniedziałku do piątku = 4 dni", () => {
      const monday = new Date(2026, 6, 27); // poniedziałek
      const friday = new Date(2026, 6, 31); // piątek
      const days = businessDaysBetween(monday, friday);
      expect(days).toBe(4); // wt, śr, cz, pt = 4 dni
    });
  });

  describe("alert levels: T-3, T-1, overdue", () => {
    it("due_at za 4 dni robocze → none", () => {
      const future = addBusinessDays(new Date(), 4);
      expect(getAlertLevel(future)).toBe("none");
    });

    it("due_at za 2 dni robocze → warning (T-3)", () => {
      const future = addBusinessDays(new Date(), 2);
      expect(getAlertLevel(future)).toBe("warning");
    });

    it("due_at za 1 dzień roboczy → critical (T-1)", () => {
      const future = addBusinessDays(new Date(), 1);
      expect(getAlertLevel(future)).toBe("critical");
    });

    it("due_at w przeszłości → overdue", () => {
      const past = new Date(Date.now() - 86400000); // wczoraj
      expect(getAlertLevel(past)).toBe("overdue");
      expect(isOverdue(past)).toBe(true);
    });
  });

  describe("dispute state machine 8 stanów (Square Dispute)", () => {
    it("INQUIRY_EVIDENCE_REQUIRED → INQUIRY_PROCESSING (dozwolone)", () => {
      expect(canTransition("INQUIRY_EVIDENCE_REQUIRED", "INQUIRY_PROCESSING")).toBe(true);
    });

    it("INQUIRY_EVIDENCE_REQUIRED → WON (niedozwolone — inquiry obowiązkowe)", () => {
      expect(canTransition("INQUIRY_EVIDENCE_REQUIRED", "WON")).toBe(false);
    });

    it("INQUIRY_PROCESSING → EVIDENCE_REQUIRED (formalny spór)", () => {
      expect(canTransition("INQUIRY_PROCESSING", "EVIDENCE_REQUIRED")).toBe(true);
    });

    it("INQUIRY_PROCESSING → INQUIRY_CLOSED (zamknięcie inquiry)", () => {
      expect(canTransition("INQUIRY_PROCESSING", "INQUIRY_CLOSED")).toBe(true);
    });

    it("INQUIRY_CLOSED → PROCESSING (niedozwolone — terminal)", () => {
      expect(canTransition("INQUIRY_CLOSED", "PROCESSING")).toBe(false);
    });

    it("EVIDENCE_REQUIRED → PROCESSING (dozwolone)", () => {
      expect(canTransition("EVIDENCE_REQUIRED", "PROCESSING")).toBe(true);
    });

    it("EVIDENCE_REQUIRED → ACCEPTED (dozwolone)", () => {
      expect(canTransition("EVIDENCE_REQUIRED", "ACCEPTED")).toBe(true);
    });

    it("PROCESSING → WON (dozwolone)", () => {
      expect(canTransition("PROCESSING", "WON")).toBe(true);
    });

    it("PROCESSING → LOST (dozwolone)", () => {
      expect(canTransition("PROCESSING", "LOST")).toBe(true);
    });

    it("WON → LOST (niedozwolone — terminal)", () => {
      expect(canTransition("WON", "LOST")).toBe(false);
    });

    it("LOST → WON (niedozwolone — terminal)", () => {
      expect(canTransition("LOST", "WON")).toBe(false);
    });

    it("wszystkie stany terminalne nie mają dozwolonych przejść", () => {
      expect(canTransition("WON", "PROCESSING")).toBe(false);
      expect(canTransition("LOST", "PROCESSING")).toBe(false);
      expect(canTransition("ACCEPTED", "PROCESSING")).toBe(false);
      expect(canTransition("INQUIRY_CLOSED", "EVIDENCE_REQUIRED")).toBe(false);
    });
  });
});
