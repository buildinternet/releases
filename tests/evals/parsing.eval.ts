/**
 * Parsing evals — tests parseChangelog() against golden fixtures.
 *
 * Each fixture is a .md file paired with a .expected.json grading spec.
 * The eval calls the real AI parsing pipeline and grades structured output
 * using code-based checks (version match, date match, breaking flag, content keywords).
 *
 * Run: bun test tests/evals/parsing.eval.ts --timeout 120000
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "path";
import { parseChangelog } from "../../src/ai/ingest.js";
import {
  loadFixtures,
  gradeFixture,
  printResults,
  saveResults,
  type FixtureResult,
  type FixturePair,
} from "./helpers.js";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "changelogs");
const RESULTS_DIR = join(import.meta.dir, "results");

let fixtures: FixturePair[] = [];
const allResults: FixtureResult[] = [];

beforeAll(() => {
  fixtures = loadFixtures(FIXTURES_DIR);
  if (fixtures.length === 0) {
    throw new Error(`No fixtures found in ${FIXTURES_DIR}`);
  }
});

describe("parsing evals", () => {
  // Use a longer timeout since each test makes an AI API call
  it.each([
    "single-release",
    "multiple-releases",
    "no-versions",
    "breaking-changes",
    "media-heavy",
    "date-formats",
    "minimal-content",
    "keepachangelog-format",
    "bold-versions",
  ])(
    "parses %s correctly",
    async (fixtureName) => {
      const fixture = fixtures.find((f) => f.name === fixtureName);
      if (!fixture) {
        throw new Error(`Fixture ${fixtureName} not found — check fixtures directory`);
      }

      const actual = await parseChangelog(fixture.markdown, `eval-${fixtureName}`);
      const result = gradeFixture(fixture.name, fixture.expected, actual);
      allResults.push(result);

      // The test passes if the overall field score is >= 80%.
      // This allows minor deviations (e.g. slightly different date format)
      // while catching real regressions (wrong version, missed releases).
      expect(result.score).toBeGreaterThanOrEqual(0.8);

      // Release count must match exactly — missing or extra releases is a hard fail.
      expect(result.releaseCountMatch).toBe(true);
    },
    60_000,
  );

  it("prints summary", () => {
    if (allResults.length > 0) {
      printResults(allResults, "Parsing Evals");
      saveResults(
        allResults,
        join(RESULTS_DIR, `parsing-${new Date().toISOString().slice(0, 10)}.json`),
      );
    }
  });
});
