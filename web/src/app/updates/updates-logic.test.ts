import { describe, expect, test } from "bun:test";
import {
  monthKeyOf,
  monthLabelOf,
  buildMonthBuckets,
  areaGroupOf,
  buildAreaBuckets,
  sumComposition,
  isFixOnlyComposition,
  versionRangeLabel,
  entryPublishedAt,
  entryComposition,
  entryAreaGroup,
  entryVersionLabel,
} from "./updates-logic";
import type { FeedEntry, RollupItem } from "@/components/org-release-entries";
import type { OrgReleaseItemView } from "@/lib/release-view";

// Minimal release fixture — only the fields updates-logic reads.
function rel(opts: {
  version?: string | null;
  day?: string; // YYYY-MM-DD
  bugs?: number;
  features?: number;
  enhancements?: number;
  noComposition?: boolean;
  source?: string;
  product?: string;
  groupSlug?: string;
  groupName?: string;
}): OrgReleaseItemView {
  const day = opts.day ?? "2026-07-03";
  return {
    version: opts.version ?? null,
    title: opts.version ?? "release",
    summary: "",
    publishedAt: `${day}T12:00:00Z`,
    url: `https://example.com/${opts.source ?? "web"}`,
    source: {
      slug: opts.source ?? "product-changelog",
      name: opts.source ?? "product-changelog",
      type: "feed",
    },
    product: opts.product ? { slug: opts.product, name: opts.product } : null,
    groupSlug: opts.groupSlug,
    groupName: opts.groupName,
    composition: opts.noComposition
      ? null
      : {
          bugs: opts.bugs ?? 0,
          features: opts.features ?? 0,
          enhancements: opts.enhancements ?? 0,
        },
  } as unknown as OrgReleaseItemView;
}

describe("monthKeyOf / monthLabelOf", () => {
  test("derives a UTC year-month key", () => {
    expect(monthKeyOf("2026-07-03T12:00:00Z")).toBe("2026-07");
    expect(monthKeyOf("2026-01-01T00:00:00Z")).toBe("2026-01");
  });

  test("falls back to 'undated' for missing/invalid input", () => {
    expect(monthKeyOf(null)).toBe("undated");
    expect(monthKeyOf(undefined)).toBe("undated");
    expect(monthKeyOf("not-a-date")).toBe("undated");
  });

  test("formats a month key as a human label", () => {
    expect(monthLabelOf("2026-07")).toBe("July 2026");
    expect(monthLabelOf("undated")).toBe("Undated");
  });
});

describe("buildMonthBuckets", () => {
  test("counts releases per month, newest month first", () => {
    const buckets = buildMonthBuckets([
      rel({ day: "2026-07-03" }),
      rel({ day: "2026-07-01" }),
      rel({ day: "2026-06-20" }),
    ]);
    expect(buckets).toEqual([
      { key: "2026-07", label: "July 2026", count: 2 },
      { key: "2026-06", label: "June 2026", count: 1 },
    ]);
  });

  test("sorts an undated bucket last", () => {
    const buckets = buildMonthBuckets([rel({ day: "2026-06-20" }), { publishedAt: null }]);
    expect(buckets.map((b) => b.key)).toEqual(["2026-06", "undated"]);
  });
});

describe("areaGroupOf / buildAreaBuckets", () => {
  test("maps known group slugs to their display override", () => {
    expect(areaGroupOf(rel({ groupSlug: "cli", groupName: "cli" }))).toEqual({
      slug: "cli",
      label: "CLI",
    });
    expect(
      areaGroupOf(rel({ source: "product-changelog", groupSlug: "product-changelog" })),
    ).toEqual({ slug: "product-changelog", label: "Web" });
  });

  test("falls back to the release's own label for an unmapped group", () => {
    expect(areaGroupOf(rel({ groupSlug: "api-mcp", groupName: "API & MCP" }))).toEqual({
      slug: "api-mcp",
      label: "API & MCP",
    });
  });

  test("falls back through product then source when groupSlug is absent", () => {
    expect(areaGroupOf(rel({ product: "turborepo", source: "turborepo" }))).toMatchObject({
      slug: "turborepo",
    });
  });

  test("lists distinct areas in first-appearance order", () => {
    const buckets = buildAreaBuckets([
      rel({ groupSlug: "cli", groupName: "CLI" }),
      rel({ groupSlug: "product-changelog", groupName: "product-changelog" }),
      rel({ groupSlug: "cli", groupName: "CLI" }),
    ]);
    expect(buckets).toEqual([
      { slug: "cli", label: "CLI" },
      { slug: "product-changelog", label: "Web" },
    ]);
  });
});

describe("sumComposition / isFixOnlyComposition", () => {
  test("sums counts across members, treating missing composition as zero", () => {
    const sum = sumComposition([
      rel({ features: 2, bugs: 1 }),
      rel({ noComposition: true }),
      rel({ enhancements: 1 }),
    ]);
    expect(sum).toEqual({ bugs: 1, features: 2, enhancements: 1 });
  });

  test("returns null when every count is zero", () => {
    expect(sumComposition([rel({ noComposition: true }), rel({ noComposition: true })])).toBeNull();
  });

  test("detects a fix-only composition", () => {
    expect(isFixOnlyComposition({ bugs: 1, features: 0, enhancements: 0 })).toBe(true);
    expect(isFixOnlyComposition({ bugs: 1, features: 1, enhancements: 0 })).toBe(false);
    expect(isFixOnlyComposition(null)).toBe(false);
  });
});

describe("versionRangeLabel", () => {
  test("returns a single normalized version for one release", () => {
    expect(versionRangeLabel([{ version: "0.67.1" }])).toBe("v0.67.1");
  });

  test("returns oldest→newest for a multi-release rollup (newest-first input)", () => {
    expect(versionRangeLabel([{ version: "0.66.0" }, { version: "0.65.0" }])).toBe(
      "v0.65.0→v0.66.0",
    );
  });

  test("collapses to one version when the range is degenerate", () => {
    expect(versionRangeLabel([{ version: "0.66.0" }, { version: "0.66.0" }])).toBe("v0.66.0");
  });

  test("returns null with no versions at all", () => {
    expect(versionRangeLabel([{ version: null }])).toBeNull();
  });
});

describe("entry* helpers (row | rollup)", () => {
  test("entryPublishedAt/entryComposition/entryAreaGroup/entryVersionLabel on a row", () => {
    const entry: FeedEntry = { kind: "row", release: rel({ version: "0.67.1", bugs: 1 }) };
    expect(entryPublishedAt(entry)).toBe("2026-07-03T12:00:00Z");
    expect(entryComposition(entry)).toEqual({ bugs: 1, features: 0, enhancements: 0 });
    expect(entryAreaGroup(entry).slug).toBe("product-changelog");
    expect(entryVersionLabel(entry)).toBe("v0.67.1");
  });

  test("entryPublishedAt/entryComposition/entryVersionLabel on a rollup", () => {
    const item: RollupItem = {
      kind: "rollup",
      groupKey: "::cli",
      label: "cli",
      releases: [
        rel({ source: "cli", version: "0.66.0", features: 2, groupSlug: "cli" }),
        rel({ source: "cli", version: "0.65.0", enhancements: 1, groupSlug: "cli" }),
      ],
    };
    const entry: FeedEntry = { kind: "rollup", item };
    expect(entryPublishedAt(entry)).toBe("2026-07-03T12:00:00Z");
    expect(entryComposition(entry)).toEqual({ bugs: 0, features: 2, enhancements: 1 });
    expect(entryAreaGroup(entry)).toEqual({ slug: "cli", label: "CLI" });
    expect(entryVersionLabel(entry)).toBe("v0.65.0→v0.66.0");
  });
});
