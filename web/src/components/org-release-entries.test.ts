import { describe, expect, test } from "bun:test";
import type { OrgReleaseItem } from "@/lib/api";
import { buildFeedEntries, entryDayKey, type FeedEntry } from "./org-release-entries";

// Minimal OrgReleaseItem fixture — buildFeedEntries only reads
// source/product/version/title/publishedAt/url, so we cast a partial.
function rel(opts: {
  source: string;
  version: string;
  product?: string;
  type?: string;
  day?: string; // YYYY-MM-DD
}): OrgReleaseItem {
  const day = opts.day ?? "2026-05-28";
  return {
    version: opts.version,
    title: opts.version,
    summary: "",
    publishedAt: `${day}T12:00:00Z`,
    url: `https://example.com/${opts.source}/${opts.version}`,
    source: { slug: opts.source, name: opts.source, type: opts.type ?? "github" },
    product: opts.product ? { slug: opts.product, name: opts.product } : null,
  } as unknown as OrgReleaseItem;
}

function rollupLabels(entries: FeedEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === "rollup" ? [e.item.label] : []));
}

describe("buildFeedEntries", () => {
  test("collapses a same-day 2+ source cluster into one rollup", () => {
    const entries = buildFeedEntries([
      rel({ source: "vercel-cli", version: "vercel@54.6.1" }),
      rel({ source: "vercel-cli", version: "@vercel/node@5.8.6" }),
      rel({ source: "vercel-cli", version: "@vercel/aws@0.2.1" }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("rollup");
    expect(rollupLabels(entries)).toEqual(["vercel-cli"]);
    if (entries[0].kind === "rollup") expect(entries[0].item.releases).toHaveLength(3);
  });

  test("leaves a lone tag as a flat row", () => {
    const entries = buildFeedEntries([rel({ source: "next", version: "v15.0.0" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("row");
  });

  test("never rolls up non-GitHub posts (feed/scrape/agent)", () => {
    const entries = buildFeedEntries([
      rel({ source: "vercel-blog", version: "Post A", type: "feed" }),
      rel({ source: "vercel-blog", version: "Post B", type: "feed" }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "row")).toBe(true);
  });

  test("buckets the same source on different days separately", () => {
    const entries = buildFeedEntries([
      rel({ source: "vercel-cli", version: "a", day: "2026-05-28" }),
      rel({ source: "vercel-cli", version: "b", day: "2026-05-28" }),
      rel({ source: "vercel-cli", version: "c", day: "2026-05-27" }),
      rel({ source: "vercel-cli", version: "d", day: "2026-05-27" }),
    ]);

    // Two rollups — one per day — not one cluster spanning both days.
    const rollups = entries.filter((e) => e.kind === "rollup");
    expect(rollups).toHaveLength(2);
    expect(entryDayKey(entries[0])).toBe("2026-05-28");
    expect(entryDayKey(entries[1])).toBe("2026-05-27");
  });

  test("emits a rollup at its newest member and keeps posts interleaved in place", () => {
    // published-desc order: tag, post, tag (same source). The two tags cluster;
    // the post sits between them in the input. The rollup lands at the first
    // (newest) tag; the post stays a row right after it.
    const entries = buildFeedEntries([
      rel({ source: "vercel-cli", version: "vercel@2" }),
      rel({ source: "vercel-blog", version: "A blog post", type: "feed" }),
      rel({ source: "vercel-cli", version: "vercel@1" }),
    ]);

    expect(entries.map((e) => e.kind)).toEqual(["rollup", "row"]);
    expect(rollupLabels(entries)).toEqual(["vercel-cli"]);
    if (entries[0].kind === "rollup") expect(entries[0].item.releases).toHaveLength(2);
    if (entries[1].kind === "row") expect(entries[1].release.source.type).toBe("feed");
  });

  test("keeps product-keyed and source-keyed clusters as distinct rollups", () => {
    const entries = buildFeedEntries([
      rel({ source: "turborepo", version: "v2.9.16", product: "turborepo" }),
      rel({ source: "turborepo", version: "v2.9.15", product: "turborepo" }),
      rel({ source: "vercel-cli", version: "vercel@9" }),
      rel({ source: "vercel-cli", version: "vercel@8" }),
    ]);

    expect(rollupLabels(entries)).toEqual(["turborepo", "vercel-cli"]);
  });
});
