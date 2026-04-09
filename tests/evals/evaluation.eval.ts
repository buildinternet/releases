/**
 * Evaluation evals — tests evaluateChangelog() URL recommendation logic.
 *
 * These are code-graded: check that the function recommends the right
 * ingestion method, confidence level, and feed URL for known inputs.
 *
 * Note: These hit real URLs (HEAD requests for feed discovery), so they're
 * integration-level evals. They do NOT call the AI — evaluateChangelog()
 * uses only deterministic pre-checks.
 *
 * Run: bun test tests/evals/evaluation.eval.ts --timeout 30000
 */

import { describe, it, expect } from "bun:test";
import { evaluateChangelog } from "../../src/ai/evaluate.js";

interface EvalCase {
  url: string;
  label: string;
  expected: {
    method: "feed" | "github" | "markdown" | "scrape" | "crawl";
    confidence?: "high" | "medium" | "low";
    hasFeedUrl?: boolean;
    hasGithubRepo?: boolean;
  };
}

const cases: EvalCase[] = [
  // GitHub URLs should be detected immediately with high confidence
  {
    url: "https://github.com/vercel/next.js/releases",
    label: "GitHub releases page",
    expected: { method: "github", confidence: "high", hasGithubRepo: true },
  },
  {
    url: "https://github.com/anthropics/anthropic-sdk-python/releases",
    label: "GitHub releases (SDK)",
    expected: { method: "github", confidence: "high", hasGithubRepo: true },
  },
  {
    url: "https://github.com/denoland/deno/releases",
    label: "GitHub releases (Deno)",
    expected: { method: "github", confidence: "high", hasGithubRepo: true },
  },

  // Non-GitHub URLs without obvious feeds should fall back to scrape
  {
    url: "https://example.com/changelog",
    label: "Unknown URL (no feed)",
    expected: { method: "scrape", confidence: "low" },
  },
];

describe("evaluation evals", () => {
  it.each(cases.map((c) => [c.label, c] as const))(
    "%s",
    async (_label, evalCase) => {
      const result = await evaluateChangelog(evalCase.url);

      expect(result.recommendedMethod).toBe(evalCase.expected.method);

      if (evalCase.expected.confidence) {
        expect(result.confidence).toBe(evalCase.expected.confidence);
      }

      if (evalCase.expected.hasFeedUrl) {
        expect(result.feedUrl).toBeTruthy();
      }

      if (evalCase.expected.hasGithubRepo) {
        expect(result.githubRepo).toBeTruthy();
      }
    },
    15_000,
  );
});
