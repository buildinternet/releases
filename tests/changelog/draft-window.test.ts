import { test, expect, describe } from "bun:test";
import { computeDraftWindow } from "../../scripts/changelog/draft-window";

describe("computeDraftWindow", () => {
  test("no prior section → just yesterday", () => {
    expect(computeDraftWindow(null, "2026-06-15")).toEqual({
      sinceIso: "2026-06-14",
      untilIso: "2026-06-14",
      cappedFrom: null,
    });
  });
  test("prior section a few days back → since = latest+1 .. yesterday", () => {
    expect(computeDraftWindow("2026-06-11", "2026-06-15")).toEqual({
      sinceIso: "2026-06-12",
      untilIso: "2026-06-14",
      cappedFrom: null,
    });
  });
  test("already caught up (latest == yesterday) → empty window (since > until)", () => {
    const w = computeDraftWindow("2026-06-14", "2026-06-15");
    expect(w.sinceIso > w.untilIso).toBe(true);
  });
  test("gap > 7 days → clamp since to until-7 and record cappedFrom", () => {
    const w = computeDraftWindow("2026-05-01", "2026-06-15", 7);
    expect(w.untilIso).toBe("2026-06-14");
    expect(w.sinceIso).toBe("2026-06-07");
    expect(w.cappedFrom).toBe("2026-05-02");
  });
});
