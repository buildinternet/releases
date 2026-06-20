/**
 * Breaking-change eval fixtures. The classifier is now folded into the
 * release-summary call (#1696) — these run through `summarizeRelease` and the
 * eval grades the `breaking` field it returns. Representative release shapes
 * spanning the verdict space, including the SemVer signals the prompt weighs:
 * a major-version bump, a patch, a content-driven break on a patch version, and
 * abstain cases. Swap in literal prod bodies as they're curated.
 */
import { join } from "path";
import type { SummarizeReleaseInput } from "@releases/ai-internal/release-content";
import type { BreakingLevel } from "@buildinternet/releases-core/breaking";

export interface BreakingFixture {
  name: string;
  input: SummarizeReleaseInput;
  /** Curated ground-truth verdict. */
  expected: BreakingLevel;
}

/** Absolute path to the grading rubric (shared with the prompt's intent). */
export function breakingRubricPath(): string {
  return join(import.meta.dir, "..", "..", "src", "shared", "rubrics", "breaking.md");
}

const base = { orgSlug: "acme", productName: null, url: null } as const;

export const BREAKING_FIXTURES: BreakingFixture[] = [
  {
    name: "major-removal-and-dropped-support",
    expected: "major",
    input: {
      ...base,
      sourceName: "OpenAI Node SDK",
      title: "v5.0.0",
      version: "5.0.0",
      content: [
        "### Breaking changes",
        "- `openai.completions.create` has been removed; use `openai.chat.completions.create`.",
        "- The client now requires Node 20+ (dropped Node 18).",
        "",
        "### Migration",
        "Replace `completions.create({ prompt })` with `chat.completions.create({ messages })`,",
        "and upgrade your runtime to Node 20 or later.",
      ].join("\n"),
    },
  },
  {
    name: "major-semver-bump-thin-notes",
    expected: "major",
    input: {
      ...base,
      sourceName: "Widgets SDK",
      title: "v3.0.0",
      version: "3.0.0",
      content: "Release 3.0.0. A few API cleanups and refactors; see the README for the new usage.",
    },
  },
  {
    name: "minor-live-deprecation",
    expected: "minor",
    input: {
      ...base,
      sourceName: "Next.js",
      title: "v15.5.0",
      version: "15.5.0",
      content: [
        "- Fixed a hydration mismatch in the App Router.",
        "- Added a new `images.qualities` config option.",
        "- The `legacyBehavior` prop on `next/link` is now deprecated and will be removed in v16.",
        "  It still works for now and logs a warning.",
      ].join("\n"),
    },
  },
  {
    name: "none-patch-additive-and-fixes",
    expected: "none",
    input: {
      ...base,
      sourceName: "Stripe CLI",
      title: "v1.21.3",
      version: "1.21.3",
      content: [
        "- Add `stripe listen --skip-verify` flag.",
        "- Improve error messages on failed webhook deliveries.",
        "- Performance: faster CLI startup.",
      ].join("\n"),
    },
  },
  {
    name: "major-default-reversal-on-patch-version",
    expected: "major",
    input: {
      ...base,
      sourceName: "Acme Auth SDK",
      title: "v3.2.1",
      version: "3.2.1",
      content: [
        "- Added a `tokenRefresh` option.",
        "- Sessions now expire after 1 hour by default (previously 24 hours). Set",
        "  `sessionTtl: '24h'` to keep the old behavior.",
        "- Misc internal cleanups.",
      ].join("\n"),
    },
  },
  {
    name: "unknown-marketing-filler-no-version",
    expected: "unknown",
    input: {
      ...base,
      sourceName: "Acme Platform",
      title: "April release",
      version: null,
      content:
        "This month we shipped a bunch of improvements to make Acme faster and more delightful. Thanks to all our users!",
    },
  },
];
