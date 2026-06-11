import { describe, expect, test } from "bun:test";
import type { OrgReleaseItem } from "@/lib/api";
import {
  buildFeedEntries,
  entryDayKey,
  rollupSummaryLine,
  type FeedEntry,
} from "./org-release-entries";

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

  // App Store same-day version rollup (#1236): appstore rows join the per-day
  // rollup pass alongside GitHub tags.
  test("collapses a same-day cluster of one app's versions into a rollup", () => {
    const entries = buildFeedEntries([
      rel({ source: "slack-ios", version: "25.5.2", product: "slack", type: "appstore" }),
      rel({ source: "slack-ios", version: "25.5.1", product: "slack", type: "appstore" }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("rollup");
    if (entries[0].kind === "rollup") {
      expect(entries[0].item.releases).toHaveLength(2);
      expect(entries[0].item.groupKey).toBe("::slack-ios");
    }
  });

  test("leaves a lone same-day app version as a flat row", () => {
    const entries = buildFeedEntries([
      rel({ source: "slack-ios", version: "25.5.2", product: "slack", type: "appstore" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("row");
  });

  test("rolls up appstore and GitHub clusters on the same day as distinct rows", () => {
    const entries = buildFeedEntries([
      rel({ source: "slack-ios", version: "25.5.2", product: "slack", type: "appstore" }),
      rel({ source: "slack-ios", version: "25.5.1", product: "slack", type: "appstore" }),
      rel({ source: "slack-sdk", version: "v3.0.0" }),
      rel({ source: "slack-sdk", version: "v2.9.0" }),
    ]);

    // appstore keyed per-source, github keyed source — two independent rollups,
    // each landing at its newest member in published-desc order.
    expect(rollupLabels(entries)).toEqual(["slack-ios", "slack-sdk"]);
  });
});

// A rollup member as `rollupSummaryLine` reads it: only the title-hierarchy
// fields matter (delegated to deriveFeedTitle).
type SummaryMember = {
  title: string;
  version: string | null;
  titleShort?: string | null;
  titleGenerated?: string | null;
};
function member(o: Partial<SummaryMember> & { version?: string | null }): SummaryMember {
  return {
    title: o.title ?? o.version ?? "",
    version: o.version ?? null,
    titleShort: o.titleShort ?? null,
    titleGenerated: o.titleGenerated ?? null,
  };
}

describe("rollupSummaryLine", () => {
  test("joins distinct member headlines with a middot", () => {
    const line = rollupSummaryLine([
      member({ version: "v0.62.0", titleShort: "follows + feed verbs" }),
      member({ version: "v0.61.0", titleShort: "leaner get/latest/list" }),
    ]);
    expect(line).toBe("follows + feed verbs · leaner get/latest/list");
  });

  test("prefers titleShort over a bare-version title", () => {
    // title is just the version restated; titleShort carries the real gist.
    const line = rollupSummaryLine([
      member({ version: "v0.62.0", title: "v0.62.0", titleShort: "media in --json" }),
    ]);
    expect(line).toBe("media in --json");
  });

  test("skips members whose only label is a bare version", () => {
    const line = rollupSummaryLine([
      member({ version: "v0.62.0", titleShort: "admin webhooks" }),
      member({ version: "v0.61.0", title: "v0.61.0" }), // no descriptive content
    ]);
    expect(line).toBe("admin webhooks");
  });

  test("dedupes identical headlines case-insensitively", () => {
    const line = rollupSummaryLine([
      member({ version: "v3.0.1", titleShort: "Bug fixes" }),
      member({ version: "v3.0.0", titleShort: "bug fixes" }),
    ]);
    expect(line).toBe("Bug fixes");
  });

  test("caps at the limit and appends an ellipsis when there are more", () => {
    const line = rollupSummaryLine(
      [
        member({ version: "v4", titleShort: "a" }),
        member({ version: "v3", titleShort: "b" }),
        member({ version: "v2", titleShort: "c" }),
        member({ version: "v1", titleShort: "d" }),
      ],
      3,
    );
    expect(line).toBe("a · b · c …");
  });

  test("returns null when no member has anything more descriptive than its version", () => {
    const line = rollupSummaryLine([
      member({ version: "v0.62.0", title: "v0.62.0" }),
      member({ version: "v0.61.0", title: "0.61.0" }),
    ]);
    expect(line).toBeNull();
  });
});
