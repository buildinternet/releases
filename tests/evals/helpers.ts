/**
 * Shared grading utilities for eval suites.
 *
 * Expected JSON uses a flexible schema — not the exact ParsedRelease shape,
 * but a grading spec with fields like `contentContains`, `mediaCountMin`, etc.
 * This lets us grade AI output without requiring exact text matches on
 * inherently variable fields (content summaries, titles).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { logger } from "../../src/lib/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ExpectedRelease {
  version?: string;
  title?: string; // substring match if provided
  publishedAt?: string; // exact or prefix match (e.g. "2024-03" matches "2024-03-15")
  isBreaking: boolean;
  hasContent?: boolean;
  contentContains?: string[]; // each string must appear in content (case-insensitive)
  versionShouldBeAbsent?: boolean;
  mediaCount?: number; // exact media count
  mediaCountMin?: number; // minimum media count
  mediaTypes?: string[]; // each type must appear in at least one media item
}

export interface ActualRelease {
  version?: string;
  title: string;
  content: string;
  publishedAt?: string;
  isBreaking: boolean;
  media?: Array<{ type: string; url: string; alt?: string }>;
}

export interface FieldResult {
  field: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
}

export interface ReleaseGradeResult {
  index: number;
  passed: boolean;
  fields: FieldResult[];
}

export interface FixtureResult {
  fixture: string;
  passed: boolean;
  releaseCountMatch: boolean;
  expectedCount: number;
  actualCount: number;
  releases: ReleaseGradeResult[];
  score: number; // 0-1, fraction of fields that passed
}

// ── Fixture loading ────────────────────────────────────────────────

export interface FixturePair {
  name: string;
  markdown: string;
  expected: ExpectedRelease[];
}

export function loadFixtures(fixturesDir: string): FixturePair[] {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".md"));
  const fixtures: FixturePair[] = [];

  for (const mdFile of files) {
    const name = basename(mdFile, ".md");
    const expectedFile = join(fixturesDir, `${name}.expected.json`);

    try {
      const markdown = readFileSync(join(fixturesDir, mdFile), "utf-8");
      const expected = JSON.parse(readFileSync(expectedFile, "utf-8")) as ExpectedRelease[];
      fixtures.push({ name, markdown, expected });
    } catch (error) {
      logger.warn(`Skipping fixture ${name}: missing expected JSON or parse error`);
    }
  }

  return fixtures;
}

// ── Grading ────────────────────────────────────────────────────────

/** Strip leading "v" for version comparison (e.g. "v1.2.3" -> "1.2.3"). */
function normalizeVersion(v: string): string {
  return v.replace(/^v/i, "");
}

function gradeRelease(expected: ExpectedRelease, actual: ActualRelease): ReleaseGradeResult {
  const fields: FieldResult[] = [];

  if (expected.versionShouldBeAbsent) {
    fields.push({
      field: "version (absent)",
      passed: actual.version === undefined || actual.version === null,
      expected: "absent",
      actual: actual.version,
    });
  } else if (expected.version !== undefined) {
    const passed = normalizeVersion(actual.version ?? "") === normalizeVersion(expected.version);
    fields.push({
      field: "version",
      passed,
      expected: expected.version,
      actual: actual.version,
    });
  }

  if (expected.title !== undefined) {
    const passed = actual.title.toLowerCase().includes(expected.title.toLowerCase());
    fields.push({
      field: "title",
      passed,
      expected: expected.title,
      actual: actual.title,
    });
  }

  if (expected.publishedAt !== undefined) {
    const actualDate = actual.publishedAt ?? "";
    fields.push({
      field: "publishedAt",
      passed: actualDate.startsWith(expected.publishedAt),
      expected: expected.publishedAt,
      actual: actual.publishedAt,
    });
  }

  fields.push({
    field: "isBreaking",
    passed: actual.isBreaking === expected.isBreaking,
    expected: expected.isBreaking,
    actual: actual.isBreaking,
  });

  if (expected.hasContent) {
    fields.push({
      field: "hasContent",
      passed: actual.content.length > 0,
      expected: true,
      actual: actual.content.length > 0,
    });
  }

  if (expected.contentContains) {
    for (const keyword of expected.contentContains) {
      const found = actual.content.toLowerCase().includes(keyword.toLowerCase());
      fields.push({
        field: `contentContains("${keyword}")`,
        passed: found,
        expected: keyword,
        actual: found ? "found" : "missing",
      });
    }
  }

  const mediaLen = actual.media?.length ?? 0;

  if (expected.mediaCount !== undefined) {
    fields.push({
      field: "mediaCount",
      passed: mediaLen === expected.mediaCount,
      expected: expected.mediaCount,
      actual: mediaLen,
    });
  }

  if (expected.mediaCountMin !== undefined) {
    fields.push({
      field: "mediaCountMin",
      passed: mediaLen >= expected.mediaCountMin,
      expected: `>= ${expected.mediaCountMin}`,
      actual: mediaLen,
    });
  }

  if (expected.mediaTypes) {
    const actualTypes = new Set((actual.media ?? []).map((m) => m.type));
    for (const expectedType of expected.mediaTypes) {
      const found = actualTypes.has(expectedType);
      fields.push({
        field: `mediaType("${expectedType}")`,
        passed: found,
        expected: expectedType,
        actual: found ? "found" : "missing",
      });
    }
  }

  return {
    index: 0, // set by caller
    passed: fields.every((f) => f.passed),
    fields,
  };
}

/**
 * Match actual releases to expected releases by version or position.
 * Returns grading results for each expected release.
 */
export function gradeFixture(
  fixtureName: string,
  expected: ExpectedRelease[],
  actual: ActualRelease[],
): FixtureResult {
  const releaseResults: ReleaseGradeResult[] = [];
  let totalFields = 0;
  let passedFields = 0;

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];

    // Match by version first, fall back to positional
    let match: ActualRelease | undefined;
    if (exp.version && !exp.versionShouldBeAbsent) {
      match = actual.find(
        (a) => a.version && normalizeVersion(a.version) === normalizeVersion(exp.version!),
      );
    }
    if (!match && i < actual.length) {
      match = actual[i];
    }

    if (!match) {
      // Missing release — all fields fail
      const fields: FieldResult[] = [
        { field: "release_found", passed: false, expected: exp.version ?? `release #${i}`, actual: "missing" },
      ];
      releaseResults.push({ index: i, passed: false, fields });
      totalFields++;
      continue;
    }

    const result = gradeRelease(exp, match);
    result.index = i;
    releaseResults.push(result);

    totalFields += result.fields.length;
    passedFields += result.fields.filter((f) => f.passed).length;
  }

  const releaseCountMatch = actual.length === expected.length;

  return {
    fixture: fixtureName,
    passed: releaseCountMatch && releaseResults.every((r) => r.passed),
    releaseCountMatch,
    expectedCount: expected.length,
    actualCount: actual.length,
    releases: releaseResults,
    score: totalFields > 0 ? passedFields / totalFields : 0,
  };
}

// ── Reporting ──────────────────────────────────────────────────────

export function printResults(results: FixtureResult[], label = "Evals"): void {
  const passed = results.filter((r) => r.passed).length;
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

  console.error(`\n${"=".repeat(60)}`);
  console.error(`${label}: ${passed}/${results.length} passed (${(avgScore * 100).toFixed(1)}% field accuracy)`);
  console.error("=".repeat(60));

  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    const fieldTotal = result.releases.reduce((s, r) => s + r.fields.length, 0);
    const fieldPassed = result.releases.reduce((s, r) => s + r.fields.filter((f) => f.passed).length, 0);
    const countNote = result.releaseCountMatch ? "" : ` [count: expected ${result.expectedCount}, got ${result.actualCount}]`;

    console.error(`  ${status}  ${result.fixture} (${fieldPassed}/${fieldTotal} fields)${countNote}`);

    // Show failed fields
    if (!result.passed) {
      for (const release of result.releases) {
        for (const field of release.fields) {
          if (!field.passed) {
            console.error(`        release #${release.index} ${field.field}: expected=${JSON.stringify(field.expected)}, actual=${JSON.stringify(field.actual)}`);
          }
        }
      }
    }
  }

  console.error("");
}

export function saveResults(results: FixtureResult[], outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });

  const summary = {
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      averageScore: results.reduce((s, r) => s + r.score, 0) / results.length,
    },
    results,
  };

  writeFileSync(outputPath, JSON.stringify(summary, null, 2));
}
