import { describe, expect, test } from "bun:test";
import { type CollectionReleaseItem } from "@/lib/api";
import {
  isTag,
  rollupTags,
  type RollupCandidate,
  type TagListItem,
} from "./collection-timeline-rollup";

// Minimal fixture — rollupTags only reads org/source/product/version, so we
// cast a partial rather than enumerate every ReleaseItem field.
function rel(opts: {
  org: string;
  source: string;
  sourceName?: string;
  product?: string | null;
  version?: string;
  type?: string;
}): CollectionReleaseItem {
  return {
    version: opts.version ?? "v1.0.0",
    title: opts.version ?? "v1.0.0",
    summary: "",
    publishedAt: "2026-05-28T00:00:00Z",
    url: `https://example.com/${opts.source}/${opts.version ?? "v1"}`,
    source: {
      slug: opts.source,
      name: opts.sourceName ?? opts.source,
      type: opts.type ?? "github",
    },
    org: { slug: opts.org, name: opts.org },
    product: opts.product ? { slug: opts.product, name: opts.product } : null,
  } as unknown as CollectionReleaseItem;
}

function rollupsOf(items: TagListItem[]) {
  return items.filter((i): i is Extract<TagListItem, { kind: "rollup" }> => i.kind === "rollup");
}

// The org releases feed (#1233) hands rollupTags `OrgReleaseItem` rows, which
// carry no `org` block. This fixture mirrors that minimal shape.
function orgFeedRel(source: string, version: string, product?: string): RollupCandidate {
  return {
    version,
    title: version,
    url: `https://example.com/${source}/${version}`,
    source: { slug: source, name: source, type: "github" },
    product: product ? { slug: product, name: product } : null,
  };
}

describe("rollupTags", () => {
  test("collapses a null-product source with 2+ tags into one rollup keyed on source", () => {
    const tags = [
      rel({
        org: "vercel",
        source: "vercel-cli",
        sourceName: "Vercel CLI",
        version: "vercel@54.6.1",
      }),
      rel({
        org: "vercel",
        source: "vercel-cli",
        sourceName: "Vercel CLI",
        version: "@vercel/aws@0.2.1",
      }),
      rel({
        org: "vercel",
        source: "vercel-cli",
        sourceName: "Vercel CLI",
        version: "@vercel/node@5.8.6",
      }),
    ];

    const out = rollupTags(tags);

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("rollup");
    const rollup = out[0] as Extract<TagListItem, { kind: "rollup" }>;
    expect(rollup.label).toBe("Vercel CLI");
    expect(rollup.groupKey).toBe("vercel::vercel-cli");
    expect(rollup.releases).toHaveLength(3);
  });

  test("collapses a product-bearing source with 2+ tags, keyed on product (unification holds)", () => {
    const tags = [
      rel({ org: "vercel", source: "turborepo", product: "turborepo", version: "v2.9.16" }),
      rel({ org: "vercel", source: "turborepo", product: "turborepo", version: "v2.9.15" }),
    ];

    const out = rollupTags(tags);

    expect(out).toHaveLength(1);
    const rollup = out[0] as Extract<TagListItem, { kind: "rollup" }>;
    expect(rollup.kind).toBe("rollup");
    expect(rollup.groupKey).toBe("vercel::turborepo");
    expect(rollup.label).toBe("turborepo");
  });

  test("leaves a source/product with exactly one tag as a single", () => {
    const tags = [
      rel({ org: "vercel", source: "turborepo", product: "turborepo", version: "v2.9.16" }),
    ];

    const out = rollupTags(tags);

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("single");
  });

  test("produces one rollup per bucket for a mixed org/day block", () => {
    const tags = [
      ...Array.from({ length: 10 }, (_, i) =>
        rel({
          org: "vercel",
          source: "vercel-cli",
          sourceName: "Vercel CLI",
          version: `vercel@${i}`,
        }),
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        rel({ org: "vercel", source: "vercel-ai-sdk", sourceName: "AI SDK", version: `ai@${i}` }),
      ),
      rel({ org: "vercel", source: "turborepo", product: "turborepo", version: "v2.9.16" }),
      rel({ org: "vercel", source: "turborepo", product: "turborepo", version: "v2.9.15" }),
    ];

    const out = rollupTags(tags);
    const rollups = rollupsOf(out);

    expect(rollups).toHaveLength(3);
    const byLabel = Object.fromEntries(rollups.map((r) => [r.label, r.releases.length]));
    expect(byLabel).toEqual({ "Vercel CLI": 10, "AI SDK": 9, turborepo: 2 });
  });

  test("preserves first-appearance (newest-first) order across buckets", () => {
    const tags = [
      rel({ org: "vercel", source: "vercel-ai-sdk", sourceName: "AI SDK", version: "ai@6" }),
      rel({ org: "vercel", source: "vercel-cli", sourceName: "Vercel CLI", version: "vercel@54" }),
      rel({ org: "vercel", source: "vercel-ai-sdk", sourceName: "AI SDK", version: "ai@5" }),
      rel({ org: "vercel", source: "vercel-cli", sourceName: "Vercel CLI", version: "vercel@53" }),
    ];

    const out = rollupTags(tags);
    const labels = rollupsOf(out).map((r) => r.label);

    // AI SDK appears first in the input, so its bucket leads.
    expect(labels).toEqual(["AI SDK", "Vercel CLI"]);
  });

  test("isTag partitions GitHub tags from feed/scrape/agent posts", () => {
    expect(isTag(rel({ org: "cf", source: "workerd", type: "github" }))).toBe(true);
    expect(isTag(rel({ org: "cf", source: "cf-changelog", type: "feed" }))).toBe(false);
    expect(isTag(rel({ org: "cf", source: "blog", type: "scrape" }))).toBe(false);
    expect(isTag(rel({ org: "cf", source: "discovery", type: "agent" }))).toBe(false);
  });

  // The org releases feed (#1233) reuses rollupTags on OrgReleaseItem rows,
  // which carry no `org` block (every row shares the page's one org). The
  // bucket key's org segment is empty, so grouping falls back to product/source.
  test("groups org-feed rows (no `org` block) by product ?? source", () => {
    const tags = [
      orgFeedRel("vercel-cli", "vercel@54.6.1"),
      orgFeedRel("vercel-cli", "@vercel/node@5.8.6"),
      orgFeedRel("turborepo", "v2.9.16", "turborepo"),
      orgFeedRel("turborepo", "v2.9.15", "turborepo"),
      orgFeedRel("vercel-ai-sdk", "ai@6"),
    ];

    const out = rollupTags(tags);
    const rollups = out.filter((i) => i.kind === "rollup");
    const singles = out.filter((i) => i.kind === "single");

    // vercel-cli (×2) and turborepo (×2) roll up; the lone ai-sdk tag stays single.
    expect(rollups).toHaveLength(2);
    expect(singles).toHaveLength(1);
    const byKey = Object.fromEntries(
      rollups.map((r) => [(r as Extract<typeof r, { kind: "rollup" }>).groupKey, r] as const),
    );
    // Empty org segment in the key (no `org` block) — grouping is by source/product alone.
    expect(byKey["::vercel-cli"]).toBeDefined();
    expect(byKey["::turborepo"]).toBeDefined();
  });

  // #1234: the API now emits a resolved groupSlug/groupName (COALESCE(product,
  // source)). rollupTags prefers them over re-deriving product ?? source, so
  // two distinct sources sharing a server group key collapse into one bucket.
  test("prefers server groupSlug/groupName over product/source when present", () => {
    const tags: RollupCandidate[] = [
      {
        version: "v1",
        title: "v1",
        url: "https://example.com/a",
        source: { slug: "src-a", name: "Source A", type: "github" },
        product: null,
        org: { slug: "acme", name: "acme" },
        groupSlug: "unified",
        groupName: "Unified Group",
      },
      {
        version: "v2",
        title: "v2",
        url: "https://example.com/b",
        source: { slug: "src-b", name: "Source B", type: "github" },
        product: null,
        org: { slug: "acme", name: "acme" },
        groupSlug: "unified",
        groupName: "Unified Group",
      },
    ];

    const out = rollupTags(tags);

    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("rollup");
    const rollup = out[0] as Extract<TagListItem<RollupCandidate>, { kind: "rollup" }>;
    // Both sources collapse into ONE bucket because they share the server group.
    expect(rollup.groupKey).toBe("acme::unified");
    expect(rollup.label).toBe("Unified Group");
    expect(rollup.releases).toHaveLength(2);
  });
});
