/**
 * Discovery evals — tests the agent's ability to find changelog sources for known companies.
 *
 * WARNING: These are expensive ($2+ per company) and slow (minutes each).
 * Run manually, not in CI.
 *
 * Run: bun test tests/evals/discovery.eval.ts --timeout 300000
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 *
 * Grading:
 * - Source recall: what % of expected sources were found? (URL pattern matching)
 * - Precision: flags unexpected sources without penalizing (agent may find valid sources we didn't list)
 * - Product detection: were expected products identified?
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { runDiscovery, type DiscoveryState } from "../../src/agent/released.js";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "discovery");

// ── Types ──────────────────────────────────────────────────────────

interface ExpectedSource {
  urlPattern: string;
  type: "github" | "feed" | "scrape";
}

interface DiscoveryFixture {
  company: string;
  domain?: string;
  githubOrg?: string;
  expectedSources: ExpectedSource[];
  expectedProducts: string[];
  notes?: string;
}

interface DiscoveryGrade {
  recall: number;
  sourceResults: Array<{ pattern: string; type: string; found: boolean }>;
  unexpectedSources: Array<{ url: string; type: string }>;
  totalDiscovered: number;
  cost: number;
  turns: number;
  status: string;
}

// ── Fixture loading ────────────────────────────────────────────────

function loadDiscoveryFixtures(): Array<{ name: string; fixture: DiscoveryFixture }> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: basename(f, ".json"),
      fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf-8")) as DiscoveryFixture,
    }));
}

// ── Grading ────────────────────────────────────────────────────────

function gradeDiscovery(fixture: DiscoveryFixture, state: DiscoveryState): DiscoveryGrade {
  const discoveredUrls = state.sources.map((s) => s.url.toLowerCase());

  const sourceResults = fixture.expectedSources.map((expected) => {
    const pattern = expected.urlPattern.toLowerCase();
    const found = discoveredUrls.some((url) => url.includes(pattern));
    return { pattern: expected.urlPattern, type: expected.type, found };
  });

  const recall = sourceResults.filter((r) => r.found).length / sourceResults.length;

  const expectedPatterns = fixture.expectedSources.map((s) => s.urlPattern.toLowerCase());
  const unexpectedSources = state.sources
    .filter((s) => !expectedPatterns.some((p) => s.url.toLowerCase().includes(p)))
    .map((s) => ({ url: s.url, type: s.type }));

  return {
    recall,
    sourceResults,
    unexpectedSources,
    totalDiscovered: state.sources.length,
    cost: state.costUsd ?? 0,
    turns: state.turns ?? 0,
    status: state.status,
  };
}

describe("discovery evals", () => {
  const fixtures = loadDiscoveryFixtures();

  for (const { fixture } of fixtures) {
    it(`discovers sources for ${fixture.company}`, async () => {
      console.error(`\n--- Discovery eval: ${fixture.company} ---`);

      const state = await runDiscovery({
        company: fixture.company,
        domain: fixture.domain,
        githubOrg: fixture.githubOrg,
        onProgress: () => process.stderr.write("."),
      });

      const grade = gradeDiscovery(fixture, state);
      printDiscoveryGrade(grade);

      // 50% threshold accounts for discovery variability -- the agent may
      // find alternate valid URLs for the same content.
      expect(grade.recall).toBeGreaterThanOrEqual(0.5);
    }, 180_000);
  }
});

function printDiscoveryGrade(grade: DiscoveryGrade): void {
  const found = grade.sourceResults.filter((r) => r.found).length;

  console.error(`\n  Status: ${grade.status}`);
  console.error(`  Sources found: ${grade.totalDiscovered}`);
  console.error(
    `  Recall: ${(grade.recall * 100).toFixed(0)}% (${found}/${grade.sourceResults.length})`,
  );
  console.error(`  Cost: $${grade.cost.toFixed(2)} | Turns: ${grade.turns}`);

  for (const result of grade.sourceResults) {
    console.error(`    ${result.found ? "FOUND" : "MISS"}  ${result.pattern} (${result.type})`);
  }

  if (grade.unexpectedSources.length > 0) {
    console.error("  Extra sources (not in expected list):");
    for (const s of grade.unexpectedSources) {
      console.error(`    +  ${s.url} (${s.type})`);
    }
  }
}
