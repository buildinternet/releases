/**
 * `parseTimeWindow` (workers/api/src/utils.ts) — the shared resolver behind the
 * `since`/`until` query params on /v1/search, /v1/releases/latest, and the org
 * feed. Covers resolution, empty/absent passthrough, the per-bound error
 * messages, and the inverted-window guard (since after until → 400, not a
 * silent empty set).
 */
import { describe, it, expect } from "bun:test";
import { parseTimeWindow } from "../../workers/api/src/utils.js";

describe("parseTimeWindow", () => {
  it("resolves both bounds to canonical ISO", () => {
    const r = parseTimeWindow("2026-01-01", "2026-05-01T00:00:00Z");
    expect(r).toEqual({
      ok: true,
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-05-01T00:00:00.000Z",
    });
  });

  it("treats undefined and empty-string as absent", () => {
    expect(parseTimeWindow(undefined, undefined)).toEqual({
      ok: true,
      since: undefined,
      until: undefined,
    });
    expect(parseTimeWindow("", "")).toEqual({ ok: true, since: undefined, until: undefined });
  });

  it("resolves relative shorthand", () => {
    const r = parseTimeWindow("90d", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports an unparseable `since`", () => {
    const r = parseTimeWindow("nope", undefined);
    expect(r).toEqual({ ok: false, message: expect.stringContaining("Invalid `since`") });
  });

  it("reports an unparseable `until`", () => {
    const r = parseTimeWindow("2026-01-01", "nope");
    expect(r).toEqual({ ok: false, message: expect.stringContaining("Invalid `until`") });
  });

  it("rejects an inverted window (since after until)", () => {
    const r = parseTimeWindow("2026-05-01", "2026-01-01");
    expect(r).toEqual({ ok: false, message: "`since` must not be after `until`" });
  });

  it("allows an equal since/until (degenerate but not inverted)", () => {
    const r = parseTimeWindow("2026-01-01", "2026-01-01");
    expect(r.ok).toBe(true);
  });
});
