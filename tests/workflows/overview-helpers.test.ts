import { test, expect } from "bun:test";
import {
  inferSelectionMode,
  filterByDateWindow,
  unescapeHtmlEntities,
  extractOpener,
  lintOverviewBody,
  deriveCitationOffsets,
  budgetGate,
} from "./overview-helpers.js";

test("inferSelectionMode: precedence orgs > activity > overviewAge > outdated", () => {
  expect(inferSelectionMode({ orgs: ["a"] })).toBe("orgs");
  // empty orgs array falls through to the next mode
  expect(inferSelectionMode({ orgs: [], activeSince: "2026-05-01" })).toBe("activity");
  expect(inferSelectionMode({ activeSince: "2026-05-01" })).toBe("activity");
  expect(inferSelectionMode({ activeUntil: "2026-05-31" })).toBe("activity");
  expect(inferSelectionMode({ overviewUpdatedFrom: "2026-01-01" })).toBe("overviewAge");
  expect(inferSelectionMode({ overviewUpdatedTo: "2026-01-01" })).toBe("overviewAge");
  // precedence: orgs wins over everything
  expect(inferSelectionMode({ orgs: ["a"], activeSince: "x", overviewUpdatedFrom: "y" })).toBe(
    "orgs",
  );
  // precedence: activity wins over overviewAge
  expect(inferSelectionMode({ activeSince: "x", overviewUpdatedFrom: "y" })).toBe("activity");
  expect(inferSelectionMode({})).toBe("outdated");
  expect(inferSelectionMode({ staleDays: 14 })).toBe("outdated");
});

test("filterByDateWindow: inclusive date-part boundaries, drops nulls, honors open ends", () => {
  const rows = [
    { slug: "a", overviewUpdatedAt: "2026-03-31T23:00:00Z" },
    { slug: "b", overviewUpdatedAt: "2026-04-01T12:00:00Z" }, // same day as `to`
    { slug: "c", overviewUpdatedAt: "2026-04-02T00:00:01Z" },
    { slug: "d", overviewUpdatedAt: null }, // missing overview -> excluded
  ];
  // bounded window, end date inclusive of the whole day
  const within = filterByDateWindow(rows, "overviewUpdatedAt", "2026-04-01", "2026-04-01");
  expect(within.map((r: { slug: string }) => r.slug)).toEqual(["b"]);
  // from-only (open upper end)
  const fromOnly = filterByDateWindow(rows, "overviewUpdatedAt", "2026-04-01", null);
  expect(fromOnly.map((r: { slug: string }) => r.slug)).toEqual(["b", "c"]);
  // to-only (open lower end)
  const toOnly = filterByDateWindow(rows, "overviewUpdatedAt", null, "2026-04-01");
  expect(toOnly.map((r: { slug: string }) => r.slug)).toEqual(["a", "b"]);
  // no bounds -> all non-null
  const all = filterByDateWindow(rows, "overviewUpdatedAt", null, null);
  expect(all.map((r: { slug: string }) => r.slug)).toEqual(["a", "b", "c"]);
});

test("filterByDateWindow: works against any date field (orgLastActivity)", () => {
  const rows = [
    { slug: "a", orgLastActivity: "2026-05-15T00:00:00Z" },
    { slug: "b", orgLastActivity: "2026-04-15T00:00:00Z" },
    { slug: "c", orgLastActivity: null },
  ];
  const r = filterByDateWindow(rows, "orgLastActivity", "2026-05-01", null);
  expect(r.map((x: { slug: string }) => x.slug)).toEqual(["a"]);
});

test("unescapeHtmlEntities: single pass over the five entities", () => {
  expect(unescapeHtmlEntities("Q&amp;A")).toBe("Q&A");
  expect(unescapeHtmlEntities("streams.input&lt;T&gt;")).toBe("streams.input<T>");
  // single pass: &amp;lt; decodes to &lt;, NOT to <
  expect(unescapeHtmlEntities("&amp;lt;")).toBe("&lt;");
  expect(unescapeHtmlEntities("&quot;x&quot; &#39;y&#39;")).toBe("\"x\" 'y'");
  // non-strings pass through untouched
  expect(unescapeHtmlEntities(null)).toBeNull();
});

test("extractOpener: first sentence, first-line fallback, raw markdown preserved", () => {
  // first sentence-final punctuation wins, trailing content dropped
  expect(extractOpener("Shipped X. Then Y.")).toBe("Shipped X.");
  // no sentence punctuation -> first line
  expect(extractOpener("A bold headline\nbody follows")).toBe("A bold headline");
  // raw: markdown emphasis is NOT stripped (lint's org-subject check relies on it)
  expect(extractOpener("**Acme** shipped a planner.")).toBe("**Acme** shipped a planner.");
  expect(extractOpener("")).toBe("");
});

test("extractOpener: lintOverviewBody opener-length agrees with a 26-word count", () => {
  // 26 words -> over the 25-word cap; the shared extractor backs both the lint
  // rule and the workflow's openerWordCount, so they can't disagree.
  const opener = Array.from({ length: 26 }, (_, i) => `w${i}`).join(" ") + ".";
  expect(lintOverviewBody(opener, "Acme")).toContain("opener-too-long");
  expect(extractOpener(opener).split(/\s+/).filter(Boolean).length).toBe(26);
});

test("lintOverviewBody: clean body has no violations", () => {
  const body =
    "Recently shipped a faster query planner and broader OAuth support.\n\n" +
    "**Persistent state landed.** Sessions now survive restarts.";
  expect(lintOverviewBody(body, "Acme")).toEqual([]);
});

test("lintOverviewBody: flags markdown headings", () => {
  expect(lintOverviewBody("# Acme\n\nShipped things.", "Acme")).toContain("markdown-heading");
});

test("lintOverviewBody: flags an opener longer than 25 words", () => {
  const long =
    "Recently the team shipped a very long opening sentence that just keeps going on " +
    "and on well past the twenty five word ceiling that the style guide imposes here today.";
  expect(lintOverviewBody(long, "Acme")).toContain("opener-too-long");
});

test("lintOverviewBody: flags bare org-as-subject opener, incl. possessive", () => {
  expect(lintOverviewBody("Acme shipped a new planner.", "Acme")).toContain(
    "org-as-subject-opener",
  );
  expect(lintOverviewBody("Acme's SDK shipped multi-region.", "Acme")).toContain(
    "org-as-subject-opener",
  );
});

test("lintOverviewBody: allows product names that begin with the org name", () => {
  // "Acme Agent" is a product name, not bare org-as-subject
  expect(lintOverviewBody("Acme Agent launched a new mode.", "Acme")).not.toContain(
    "org-as-subject-opener",
  );
});

test("lintOverviewBody: flags version/CVE-lead bold teases", () => {
  expect(lintOverviewBody("Shipped fixes.\n\n**3.2.0 added retries.**", "Acme")).toContain(
    "version-lead-tease",
  );
  expect(lintOverviewBody("Shipped fixes.\n\n**v2.4 shipped.**", "Acme")).toContain(
    "version-lead-tease",
  );
  expect(lintOverviewBody("Shipped fixes.\n\n**CVE-2024-1234 patched.**", "Acme")).toContain(
    "version-lead-tease",
  );
  expect(lintOverviewBody("Shipped fixes.\n\n**Persistent state landed.**", "Acme")).not.toContain(
    "version-lead-tease",
  );
});

test("lintOverviewBody: flags banned editorializing phrases", () => {
  const v = lintOverviewBody("Recently shipped a seamless new flow.", "Acme");
  expect(v).toContain("banned-phrase:seamless");
});

test("deriveCitationOffsets: finds offsets, drops not-found / overlapping / empty", () => {
  const body = "v2 ships with major improvements across the board.";
  const { citations, dropped } = deriveCitationOffsets(body, [
    { sourceUrl: "https://x/1", title: "T1", citedText: "v2 ships" },
    { sourceUrl: "https://x/2", title: "T2", citedText: "major improvements" },
    { sourceUrl: "https://x/3", title: "T3", citedText: "not present here" }, // dropped: not found
    { sourceUrl: "https://x/4", title: "T4", citedText: "ships with major" }, // dropped: overlaps #1/#2
    { sourceUrl: "https://x/5", title: "T5", citedText: "" }, // dropped: empty
  ]);
  expect(citations).toEqual([
    { startIndex: 0, endIndex: 8, sourceUrl: "https://x/1", title: "T1", citedText: "v2 ships" },
    {
      startIndex: 14,
      endIndex: 32,
      sourceUrl: "https://x/2",
      title: "T2",
      citedText: "major improvements",
    },
  ]);
  expect(dropped).toBe(3);
});

test("deriveCitationOffsets: uses a later non-overlapping occurrence of a repeated phrase", () => {
  // "alpha" occurs at 0 and 17; the first hit overlaps citation #1's span, so
  // citation #2 must fall back to the second occurrence rather than being dropped.
  const body = "alpha beta gamma alpha";
  const { citations, dropped } = deriveCitationOffsets(body, [
    { sourceUrl: "https://x/1", title: "T1", citedText: "alpha beta" },
    { sourceUrl: "https://x/2", title: "T2", citedText: "alpha" },
  ]);
  expect(citations).toEqual([
    { startIndex: 0, endIndex: 10, sourceUrl: "https://x/1", title: "T1", citedText: "alpha beta" },
    { startIndex: 17, endIndex: 22, sourceUrl: "https://x/2", title: "T2", citedText: "alpha" },
  ]);
  expect(dropped).toBe(0);
});

test("budgetGate: no ceiling never stops; stops under reserve with org wording", () => {
  expect(budgetGate(null, 0, 1000, 0, 10)).toEqual({ stop: false });
  expect(budgetGate(500000, 999999, 120000, 3, 20).stop).toBe(false);
  const g = budgetGate(500000, 100, 120000, 3, 20);
  expect(g.stop).toBe(true);
  expect(g.logLine).toContain("17 orgs deferred");
});
