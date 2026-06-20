/**
 * Breaking-change classifier eval fixtures: the fixture shape, the cases, and
 * the canonical rubric path. Unlike the collection-summary fixtures (one JSON
 * file per real prod day-window), these are inlined representative release
 * shapes spanning the verdict space — a hard removal, a still-working
 * deprecation, a purely additive release, a default-behavior reversal (the
 * tricky "looks additive, is breaking" case), and two abstain cases (marketing
 * filler, version-only with no detail). Swap in literal prod bodies as they're
 * curated; the classifier is the unit under test either way.
 */
import { join } from "path";
import type { BreakingClassifyInput } from "@releases/ai-internal/breaking-classifier";
import type { BreakingLevel } from "@buildinternet/releases-core/breaking";

export interface BreakingFixture {
  name: string;
  input: BreakingClassifyInput;
  /** Curated ground-truth verdict. */
  expected: BreakingLevel;
}

/** Absolute path to the grading rubric (shared with the prompt's intent). */
export function breakingRubricPath(): string {
  return join(import.meta.dir, "..", "..", "src", "shared", "rubrics", "breaking.md");
}

export const BREAKING_FIXTURES: BreakingFixture[] = [
  {
    name: "major-removal-and-dropped-support",
    expected: "major",
    input: {
      sourceName: "OpenAI Node SDK",
      productName: null,
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
    name: "minor-live-deprecation",
    expected: "minor",
    input: {
      sourceName: "Next.js",
      productName: null,
      title: "v15.4.2",
      version: "15.4.2",
      content: [
        "- Fixed a hydration mismatch in the App Router.",
        "- Added a new `images.qualities` config option.",
        "- The `legacyBehavior` prop on `next/link` is now deprecated and will be removed in v16.",
        "  It still works for now and logs a warning.",
      ].join("\n"),
    },
  },
  {
    name: "none-additive-and-fixes",
    expected: "none",
    input: {
      sourceName: "Stripe CLI",
      productName: null,
      title: "v1.21.0",
      version: "1.21.0",
      content: [
        "- Add `stripe listen --skip-verify` flag.",
        "- Improve error messages on failed webhook deliveries.",
        "- Performance: faster CLI startup.",
      ].join("\n"),
    },
  },
  {
    name: "major-default-behavior-reversal",
    expected: "major",
    input: {
      sourceName: "Acme Auth SDK",
      productName: null,
      title: "v3.2.0",
      version: "3.2.0",
      content: [
        "- Added a `tokenRefresh` option.",
        "- Sessions now expire after 1 hour by default (previously 24 hours). Set",
        "  `sessionTtl: '24h'` to keep the old behavior.",
        "- Misc internal cleanups.",
      ].join("\n"),
    },
  },
  {
    name: "unknown-marketing-filler",
    expected: "unknown",
    input: {
      sourceName: "Acme Platform",
      productName: null,
      title: "April release",
      version: null,
      content:
        "This month we shipped a bunch of improvements to make Acme faster and more delightful. Thanks to all our users!",
    },
  },
  {
    name: "unknown-version-only-no-detail",
    expected: "unknown",
    input: {
      sourceName: "Widgets SDK",
      productName: null,
      title: "v2.0.0",
      version: "2.0.0",
      content: "Release 2.0.0. See the website for details.",
    },
  },
];
