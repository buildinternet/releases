import { describe, expect, test } from "bun:test";
import { type CollectionReleaseItem } from "@/lib/api";
import { isTag, rollupTags, type TagListItem } from "./collection-timeline-rollup";

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
  });
});
