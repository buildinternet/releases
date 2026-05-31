/**
 * Pure resolver: which ingestion-pipeline stages apply to a given source, in
 * order. Drives the dev Fetch Log workflow drawer. Reuses describeFetchPlan's
 * strategy so the topology can't drift from the displayed fetch strategy.
 * No I/O — operates on a Source row.
 */
import type { Source } from "@buildinternet/releases-core/schema";
import { describeFetchPlan } from "./fetch-plan.js";
import { getSourceMeta } from "./source-meta.js";

export type StageKind = "sync" | "ai" | "async";

export interface WorkflowStage {
  /** stable id: poll|webhook|fetch|hash|parse|extract|diff|enrich|classify|upsert|agent-session|summarize|embed|changelog|publish */
  key: string;
  label: string;
  kind: StageKind;
  /** static sub-label, e.g. "Browser Rendering", "github-api", "tool-loop" */
  detailHint?: string;
}

const TAIL_COMMON: WorkflowStage[] = [
  { key: "summarize", label: "Summarize", kind: "async", detailHint: "Haiku" },
  { key: "embed", label: "Embed", kind: "async", detailHint: "Voyage" },
  { key: "publish", label: "Publish", kind: "async", detailHint: "events + webhooks" },
];
const [SUMMARIZE_STAGE, EMBED_STAGE, PUBLISH_STAGE] = TAIL_COMMON;
const TAIL_GITHUB: WorkflowStage[] = [
  SUMMARIZE_STAGE,
  EMBED_STAGE,
  { key: "changelog", label: "Changelog", kind: "async", detailHint: "discover + embed" },
  PUBLISH_STAGE,
];

export function describeWorkflowStages(source: Source): WorkflowStage[] {
  const meta = getSourceMeta(source);
  const { strategy } = describeFetchPlan(source);
  const marketing = meta.marketingFilter === true;
  const enrich = meta.feedContentDepth === "summary-only";
  const classify: WorkflowStage[] = marketing
    ? [{ key: "classify", label: "Classify", kind: "ai", detailHint: "marketing" }]
    : [];
  const upsert: WorkflowStage = { key: "upsert", label: "Upsert", kind: "sync" };

  switch (strategy) {
    case "github":
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: "github-api" },
        { key: "fetch", label: "Fetch", kind: "sync", detailHint: "releases API" },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "parse", label: "Parse", kind: "sync", detailHint: "structured" },
        ...classify,
        upsert,
        ...TAIL_GITHUB,
      ];
    case "feed":
    case "video": {
      const isVideo = strategy === "video";
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: "etag" },
        {
          key: "fetch",
          label: "Fetch",
          kind: "sync",
          detailHint: isVideo ? "YouTube" : "RSS/Atom/JSON",
        },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "parse", label: "Parse", kind: "sync", detailHint: isVideo ? "video feed" : "feed" },
        ...(!isVideo && enrich
          ? [
              {
                key: "enrich",
                label: "Feed enrich",
                kind: "ai",
                detailHint: "article extract",
              } as WorkflowStage,
            ]
          : []),
        ...(!isVideo ? classify : []),
        upsert,
        ...TAIL_COMMON,
      ];
    }
    case "scrape":
    case "crawl": {
      const isCrawl = strategy === "crawl";
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: "detector" },
        {
          key: "fetch",
          label: isCrawl ? "Crawl" : "Fetch",
          kind: "sync",
          detailHint: isCrawl ? "multi-page /crawl" : "Browser Rendering",
        },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "extract", label: "Extract", kind: "ai", detailHint: "one-shot / tool-loop" },
        ...classify,
        upsert,
        ...TAIL_COMMON,
      ];
    }
    case "appstore":
      return [
        { key: "poll", label: "Poll", kind: "sync", detailHint: "iTunes lookup" },
        { key: "fetch", label: "Fetch", kind: "sync", detailHint: "iTunes API" },
        { key: "hash", label: "Hash check", kind: "sync" },
        { key: "parse", label: "Parse", kind: "sync", detailHint: "materialize" },
        upsert,
        ...TAIL_COMMON,
      ];
    case "agent":
      return [
        { key: "poll", label: "Trigger", kind: "sync", detailHint: "sweep / scheduled" },
        { key: "agent-session", label: "Agent session", kind: "ai", detailHint: "managed worker" },
        { key: "parse", label: "Parse records", kind: "ai", detailHint: "Sonnet" },
        ...classify,
        upsert,
        ...TAIL_COMMON,
      ];
    case "firecrawl":
      return [
        { key: "webhook", label: "Webhook", kind: "sync", detailHint: "monitor.page" },
        { key: "diff", label: "Diff parse", kind: "sync", detailHint: "addedContentFromDiff" },
        { key: "extract", label: "Extract", kind: "ai", detailHint: "Haiku · diff/re-scrape" },
        ...classify,
        upsert,
        ...TAIL_COMMON,
      ];
    default: {
      const _exhaustive: never = strategy;
      return _exhaustive;
    }
  }
}
