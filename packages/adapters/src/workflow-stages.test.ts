import { describe, it, expect } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import { describeWorkflowStages } from "./workflow-stages.js";

function mkSource(
  over: Omit<Partial<Source>, "metadata"> & { metadata?: Record<string, unknown> | null },
): Source {
  const { metadata, ...rest } = over;
  return {
    id: "src_x",
    orgId: "org_x",
    slug: "x",
    name: "X",
    url: "https://x.test",
    type: "scrape",
    fetchPriority: "normal",
    nextFetchAfter: null,
    lastPolledAt: null,
    lastFetchedAt: null,
    deletedAt: null,
    changeDetectedAt: null,
    ...rest,
    metadata: metadata == null ? null : JSON.stringify(metadata),
  } as unknown as Source;
}
const keys = (s: Source) => describeWorkflowStages(s).map((x) => x.key);

describe("describeWorkflowStages", () => {
  it("github: poll→fetch→hash→parse→upsert + async(summarize,embed,changelog,publish)", () => {
    expect(keys(mkSource({ type: "github" }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "upsert",
      "summarize",
      "embed",
      "changelog",
      "publish",
    ]);
  });
  it("github + marketingFilter inserts classify before upsert", () => {
    expect(keys(mkSource({ type: "github", metadata: { marketingFilter: true } }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "classify",
      "upsert",
      "summarize",
      "embed",
      "changelog",
      "publish",
    ]);
  });
  it("feed plain", () => {
    expect(keys(mkSource({ type: "feed", metadata: { feedUrl: "u", feedType: "rss" } }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("feed summary-only + marketingFilter inserts enrich then classify", () => {
    expect(
      keys(
        mkSource({
          type: "feed",
          metadata: {
            feedUrl: "u",
            feedType: "rss",
            feedContentDepth: "summary-only",
            marketingFilter: true,
          },
        }),
      ),
    ).toEqual([
      "poll",
      "fetch",
      "hash",
      "parse",
      "enrich",
      "classify",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("video has no enrich/classify/changelog even if flags set", () => {
    expect(
      keys(
        mkSource({
          type: "video",
          metadata: {
            feedUrl: "u",
            feedType: "atom",
            video: { provider: "youtube" },
            marketingFilter: true,
            feedContentDepth: "summary-only",
          },
        }),
      ),
    ).toEqual(["poll", "fetch", "hash", "parse", "upsert", "summarize", "embed", "publish"]);
  });
  it("scrape uses extract; no enrich/changelog", () => {
    expect(keys(mkSource({ type: "scrape" }))).toEqual([
      "poll",
      "fetch",
      "hash",
      "extract",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("scrape + crawlEnabled keeps key 'fetch' but labels it Crawl", () => {
    const s = mkSource({ type: "scrape", metadata: { crawlEnabled: true } });
    expect(keys(s)).toEqual([
      "poll",
      "fetch",
      "hash",
      "extract",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
    expect(describeWorkflowStages(s).find((x) => x.key === "fetch")!.label).toBe("Crawl");
  });
  it("appstore: no extract/enrich/classify/changelog", () => {
    expect(
      keys(
        mkSource({
          type: "appstore",
          metadata: { appStore: { trackId: "1", storefront: "us", platform: "ios" } },
        }),
      ),
    ).toEqual(["poll", "fetch", "hash", "parse", "upsert", "summarize", "embed", "publish"]);
  });
  it("agent: trigger→agent-session→parse→upsert + async", () => {
    expect(keys(mkSource({ type: "agent" }))).toEqual([
      "poll",
      "agent-session",
      "parse",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("agent + marketingFilter inserts classify before upsert", () => {
    expect(keys(mkSource({ type: "agent", metadata: { marketingFilter: true } }))).toEqual([
      "poll",
      "agent-session",
      "parse",
      "classify",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
  it("firecrawl: webhook→diff→extract→upsert + async (no poll)", () => {
    expect(keys(mkSource({ type: "scrape", metadata: { firecrawl: { enabled: true } } }))).toEqual([
      "webhook",
      "diff",
      "extract",
      "upsert",
      "summarize",
      "embed",
      "publish",
    ]);
  });
});
