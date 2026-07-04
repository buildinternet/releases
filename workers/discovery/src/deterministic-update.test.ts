import { describe, expect, it } from "bun:test";

import {
  parseScrapeFetchResult,
  runScrapeFetchLoop,
  scrapeFetchErrorCategory,
  type UpdateLoopOptions,
} from "./deterministic-update.js";

const okResult = (source: string, found: number, inserted: number) =>
  JSON.stringify({
    fetched: true,
    status: "success",
    releasesFound: found,
    releasesInserted: inserted,
    source,
  });

describe("parseScrapeFetchResult", () => {
  it("parses a successful JSON result", () => {
    expect(parseScrapeFetchResult("src_a", okResult("a", 3, 2))).toEqual({
      source: "src_a",
      ok: true,
      status: "success",
      releasesFound: 3,
      releasesInserted: 2,
    });
  });

  it("parses a categorized error result", () => {
    expect(parseScrapeFetchResult("src_b", "Error [validation]: bad body")).toEqual({
      source: "src_b",
      ok: false,
      error: "bad body",
      errorCategory: "validation",
    });
  });

  it("parses a bare error result", () => {
    expect(parseScrapeFetchResult("src_c", "Error: source not found")).toEqual({
      source: "src_c",
      ok: false,
      error: "source not found",
    });
  });

  it("treats an unparseable non-error string as a failure", () => {
    const r = parseScrapeFetchResult("src_d", "totally not json");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Unparseable");
  });

  it("defaults missing counts to 0 on success", () => {
    const r = parseScrapeFetchResult("src_e", JSON.stringify({ status: "no_change" }));
    expect(r).toEqual({
      source: "src_e",
      ok: true,
      status: "no_change",
      releasesFound: 0,
      releasesInserted: 0,
    });
  });
});

describe("scrapeFetchErrorCategory", () => {
  // Canonical parser for scrapeFetch's `Error [category]: …` wire format —
  // the agent path (managed-agents-session) delegates here, so this guards
  // against the two parsers drifting.
  it("extracts the category from a categorized error", () => {
    expect(scrapeFetchErrorCategory("Error [validation]: bad body")).toBe("validation");
    expect(scrapeFetchErrorCategory("Error [infra]: boom")).toBe("infra");
  });

  it("returns null for a bare error or a success string", () => {
    expect(scrapeFetchErrorCategory("Error: not found")).toBeNull();
    expect(scrapeFetchErrorCategory('{"status":"success"}')).toBeNull();
  });
});

describe("runScrapeFetchLoop", () => {
  const opts: UpdateLoopOptions = { budgetMs: 60_000, now: () => 0 };

  it("aggregates counts across sources", async () => {
    const fn = async (s: string) => okResult(s, s === "a" ? 2 : 5, s === "a" ? 1 : 4);
    const summary = await runScrapeFetchLoop(["a", "b"], fn, opts);
    expect(summary.sourcesProcessed).toBe(2);
    expect(summary.sourcesSkipped).toBe(0);
    expect(summary.totalReleasesFound).toBe(7);
    expect(summary.totalReleasesInserted).toBe(5);
    expect(summary.errorCount).toBe(0);
  });

  it("counts per-source errors but keeps going", async () => {
    const fn = async (s: string) => (s === "bad" ? "Error [infra]: boom" : okResult(s, 1, 1));
    const summary = await runScrapeFetchLoop(["good", "bad", "good2"], fn, opts);
    expect(summary.sourcesProcessed).toBe(3);
    expect(summary.errorCount).toBe(1);
    expect(summary.totalReleasesInserted).toBe(2);
  });

  it("converts a thrown scrapeFetch into an error outcome (never throws)", async () => {
    const fn = async (s: string) => {
      if (s === "throws") throw new Error("network exploded");
      return okResult(s, 1, 1);
    };
    const summary = await runScrapeFetchLoop(["throws", "ok"], fn, opts);
    expect(summary.errorCount).toBe(1);
    expect(summary.results[0]).toMatchObject({
      source: "throws",
      ok: false,
      error: "network exploded",
    });
    expect(summary.sourcesProcessed).toBe(2);
  });

  it("skips remaining sources once the wall-clock budget is exhausted", async () => {
    // Elapsed time = 40s per completed fetch; budget 60s. Sources a and b run
    // (elapsed 0s, then 40s), then the check before c sees 80s ≥ 60s and stops.
    let fetched = 0;
    const now = () => fetched * 40_000;
    const fn = async (s: string) => {
      fetched += 1;
      return okResult(s, 1, 1);
    };
    const summary = await runScrapeFetchLoop(["a", "b", "c"], fn, {
      budgetMs: 60_000,
      now,
    });
    expect(summary.sourcesProcessed).toBe(2);
    expect(summary.sourcesSkipped).toBe(1);
  });

  it("handles an empty source list", async () => {
    const summary = await runScrapeFetchLoop([], async () => "", opts);
    expect(summary).toMatchObject({ sourcesProcessed: 0, sourcesSkipped: 0, errorCount: 0 });
  });
});
