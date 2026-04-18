import { describe, expect, it } from "bun:test";
import { describeCadence } from "../../web/src/app/status/cadence-helpers";

describe("describeCadence", () => {
  it("renders an em-dash placeholder when signal is missing", () => {
    const out = describeCadence(null, "normal", null);
    expect(out.primary).toBe("—");
    expect(out.tone).toBe("normal");
    expect(out.secondary).toBe("never retiered");
  });

  it("notes the signal threshold when retier ran but had nothing to classify", () => {
    const out = describeCadence(null, "normal", "2026-04-18T03:00:00Z");
    expect(out.secondary).toBe("<3 releases of signal");
  });

  it("formats sub-day gaps in hours", () => {
    const out = describeCadence(0.5, "normal", "2026-04-18T03:00:00Z");
    expect(out.primary).toBe("12h median");
  });

  it("formats single-digit day gaps with one decimal", () => {
    const out = describeCadence(4.7, "normal", "2026-04-18T03:00:00Z");
    expect(out.primary).toBe("4.7d median");
  });

  it("rounds large gaps to whole days", () => {
    const out = describeCadence(45.3, "low", "2026-04-18T03:00:00Z");
    expect(out.primary).toBe("45d median");
  });

  it("marks a mismatch when cadence implies a different tier than fetchPriority", () => {
    // 5-day median cadence implies "normal", but the source is on "low".
    const out = describeCadence(5, "low", "2026-04-18T03:00:00Z");
    expect(out.tone).toBe("warn");
    expect(out.tooltip).toContain("implies normal");
  });

  it("does not flag a mismatch when tiers agree", () => {
    const out = describeCadence(30, "low", "2026-04-18T03:00:00Z");
    expect(out.tone).toBe("normal");
  });

  it("flags paused sources that still have a cadence heartbeat", () => {
    // Cadence implies "normal" but source is paused — surface it so an
    // operator can decide whether to unpause.
    const out = describeCadence(5, "paused", "2026-04-18T03:00:00Z");
    expect(out.tone).toBe("warn");
  });

  it("leaves tone normal when medianGap > 90d (no implied tier)", () => {
    const out = describeCadence(120, "low", "2026-04-18T03:00:00Z");
    expect(out.tone).toBe("normal");
  });

  it("formats retier age relative to the provided `now` clock", () => {
    const now = new Date("2026-04-20T03:00:00Z");
    const out = describeCadence(5, "normal", "2026-04-18T03:00:00Z", now);
    expect(out.secondary).toBe("retiered 2d ago");
  });

  it("collapses sub-hour retier gaps to 'just now'", () => {
    const now = new Date("2026-04-18T03:30:00Z");
    const out = describeCadence(5, "normal", "2026-04-18T03:00:00Z", now);
    expect(out.secondary).toBe("retiered just now");
  });
});
