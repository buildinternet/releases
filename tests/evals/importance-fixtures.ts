/**
 * Importance-score eval fixtures. The score is folded into the release-summary
 * call — these run through `summarizeRelease` and the eval grades the
 * `importance` field it returns against a curated ground truth.
 *
 * Rubric (packages/ai/src/release-content.ts `<importance_format>`):
 *   5 landmark · 4 major-for-company · 3 notable · 2 routine · 1 housekeeping.
 * Fixture truths avoid genuinely ambiguous boundary cases; the eval's primary
 * criterion is within-1 agreement plus a false-promotion guard (truth ≤3 must
 * never score ≥4 — a wrong dot on the feed is the costliest error).
 */
import type { SummarizeReleaseInput } from "@releases/ai-internal/release-content";

export interface ImportanceFixture {
  name: string;
  input: SummarizeReleaseInput;
  /** Curated ground-truth score; null = the empty-body skip path. */
  expected: number | null;
}

const base = { orgSlug: "acme", productName: null, url: null } as const;

export const IMPORTANCE_FIXTURES: ImportanceFixture[] = [
  {
    name: "landmark-frontier-model-launch",
    expected: 5,
    input: {
      ...base,
      orgSlug: "novamind",
      sourceName: "NovaMind Blog",
      title: "Introducing Atlas 2, our most capable model family",
      version: null,
      content: [
        "Today we're releasing Atlas 2, a new family of frontier models that sets the",
        "state of the art on 14 of 16 public benchmarks, including SWE-bench and GPQA.",
        "Atlas 2 Pro is available today in the API and to all Pro subscribers; Atlas 2",
        "Flash rolls out free to everyone this week. Alongside the models we're",
        "publishing a full system card and extending our safety commitments to cover",
        "agentic use. Pricing starts at $2/M input tokens — 60% below Atlas 1 Pro.",
      ].join("\n"),
    },
  },
  {
    name: "landmark-flagship-ga-after-preview",
    expected: 5,
    input: {
      ...base,
      orgSlug: "gridbase",
      sourceName: "Gridbase Changelog",
      title: "Gridbase Postgres is now generally available",
      version: null,
      content: [
        "After 18 months of preview and 40,000 databases created, Gridbase Postgres is",
        "now generally available with a 99.99% SLA, point-in-time recovery, and SOC 2",
        "Type II certification. GA pricing is live today; all preview databases migrate",
        "automatically with zero downtime. This is the biggest launch in the company's",
        "history and completes our managed data platform.",
      ].join("\n"),
    },
  },
  {
    name: "major-pricing-overhaul",
    expected: 4,
    input: {
      ...base,
      orgSlug: "shiplane",
      sourceName: "Shiplane Updates",
      title: "New usage-based pricing for all plans",
      version: null,
      content: [
        "Starting September 1, all Shiplane plans move from per-seat to usage-based",
        "pricing. Existing customers keep current rates for 12 months. The free tier",
        "grows to 10,000 builds/month, but overage on Team plans is billed at $0.02 per",
        "build minute — most active teams will see their bill change. A migration",
        "calculator is available in the dashboard.",
      ].join("\n"),
    },
  },
  {
    name: "major-flagship-feature",
    expected: 4,
    input: {
      ...base,
      orgSlug: "framelab",
      sourceName: "FrameLab Releases",
      title: "FrameLab 8.0: real-time multiplayer editing",
      version: "8.0.0",
      content: [
        "FrameLab 8.0 ships the most-requested feature in our history: real-time",
        "multiplayer editing. Every document now supports live cursors, presence, and",
        "conflict-free co-editing for up to 50 collaborators, on every plan including",
        "free. Also in 8.0: a rebuilt comments panel and 2x faster file opens.",
      ].join("\n"),
    },
  },
  {
    name: "major-breaking-v2-migration",
    expected: 4,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme API",
      title: "API v2: new auth model, v1 sunset in 6 months",
      version: "2.0.0",
      content: [
        "API v2 is live. All endpoints now require OAuth 2.1 with PKCE — static API",
        "keys are deprecated and stop working when v1 sunsets on March 1. Response",
        "envelopes changed from `{data}` to typed resources, and cursor pagination",
        "replaces page numbers. Every integration must migrate; see the migration",
        "guide for a step-by-step path and the compatibility proxy for the interim.",
      ].join("\n"),
    },
  },
  {
    name: "notable-solid-feature",
    expected: 3,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme Dashboard",
      title: "Scheduled exports to S3 and GCS",
      version: null,
      content: [
        "You can now schedule recurring exports of any report to Amazon S3 or Google",
        "Cloud Storage. Choose CSV or Parquet, set an hourly/daily/weekly cadence, and",
        "exports run with your workspace's service credentials. Available on Business",
        "and Enterprise plans.",
      ].join("\n"),
    },
  },
  {
    name: "notable-new-integration",
    expected: 3,
    input: {
      ...base,
      orgSlug: "tracklight",
      sourceName: "Tracklight Changelog",
      title: "Linear integration",
      version: null,
      content: [
        "Tracklight now integrates with Linear: create Linear issues from any error",
        "group, sync status both ways, and link deploys to Linear cycles. The",
        "integration is available to all workspaces under Settings → Integrations.",
      ].join("\n"),
    },
  },
  {
    name: "notable-security-patch-cve",
    expected: 3,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme Server",
      title: "v4.12.3",
      version: "4.12.3",
      content: [
        "Security release. Fixes CVE-2026-31544 (moderate severity): authenticated",
        "users with viewer role could read audit-log entries for projects they were",
        "not members of. All self-hosted deployments should upgrade; cloud is already",
        "patched. No API or config changes.",
      ].join("\n"),
    },
  },
  {
    name: "routine-improvements-rollup",
    expected: 2,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme App",
      title: "March improvements",
      version: null,
      content: [
        "- Faster search indexing for large workspaces",
        "- The activity feed now groups similar events",
        "- Fixed an issue where CSV imports could drop the header row",
        "- Keyboard shortcut (Cmd+K) opens the command palette from settings pages",
      ].join("\n"),
    },
  },
  {
    name: "routine-minor-version-small-adds",
    expected: 2,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme CLI",
      title: "v1.42.0",
      version: "1.42.0",
      content: [
        "### Added",
        "- `--output json` flag on `acme status`",
        "- Shell completions for fish",
        "",
        "### Fixed",
        "- `acme login` no longer prompts twice behind corporate proxies",
      ].join("\n"),
    },
  },
  {
    name: "housekeeping-patch-bugfix",
    expected: 1,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme SDK",
      title: "v2.7.1",
      version: "2.7.1",
      content: "Fixed a regression in 2.7.0 where retry backoff ignored the configured maximum.",
    },
  },
  {
    name: "housekeeping-dependency-bumps",
    expected: 1,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme SDK",
      title: "v2.7.2",
      version: "2.7.2",
      content: [
        "### Chores",
        "- Bump undici from 6.19.2 to 6.19.8",
        "- Bump typescript to 5.6.2 (dev)",
        "- CI: cache bun install across jobs",
      ].join("\n"),
    },
  },
  {
    name: "housekeeping-docs-only",
    expected: 1,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme SDK",
      title: "v2.7.3",
      version: "2.7.3",
      content: "Documentation: fixed broken links in the README and corrected the retry example.",
    },
  },
  {
    name: "empty-body-skips-to-null",
    expected: null,
    input: {
      ...base,
      orgSlug: "acme",
      sourceName: "Acme SDK",
      title: "v2.7.4",
      version: "2.7.4",
      content: "",
    },
  },
];
