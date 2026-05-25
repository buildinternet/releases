/**
 * Pure ranking helpers behind the related-content rails
 * (workers/api/src/related-ranking.ts). Covers content-quality
 * classification (the hard-exclude / soft-down-weight split), the recency
 * decay multiplier, and the composed per-release rank used to order the
 * `/v1/related/releases` response server-side.
 */
import { describe, it, expect } from "bun:test";
import {
  classifyContentQuality,
  recencyMultiplier,
  scoreRelatedRelease,
  RELATED_RECENCY_HALF_LIFE_DAYS,
  RELATED_UNDATED_PENALTY,
} from "../../workers/api/src/related-ranking.js";

const DAY_MS = 86_400_000;

describe("classifyContentQuality", () => {
  it("marks a bare '- no changes' body empty by length", () => {
    const q = classifyContentQuality("- no changes", 12);
    expect(q.tier).toBe("empty");
    expect(q.weight).toBe(0);
  });

  it("marks 'No user-facing changes.' empty via the boilerplate phrase", () => {
    // 23 chars — above the length floor, caught by the boilerplate rule.
    expect(classifyContentQuality("No user-facing changes.", 23).tier).toBe("empty");
  });

  it("marks the 60-char 'internal ... (no user-facing changes)' body empty", () => {
    const text = "Internal infrastructure improvements (no user-facing changes)";
    expect(classifyContentQuality(text, text.length).tier).toBe("empty");
  });

  it("treats a short-but-real bugfix as thin, not empty", () => {
    const q = classifyContentQuality("Fixed crash on startup (#1234)", 30);
    expect(q.tier).toBe("thin");
    expect(q.weight).toBe(0.5);
  });

  it("does NOT exclude a long body that merely mentions 'no breaking changes'", () => {
    const text =
      "This release ships a new streaming API and a reworked config loader. " +
      "There are no breaking changes, but several internal modules were rewritten " +
      "for clarity and the docs were expanded with migration examples.";
    const q = classifyContentQuality(text, text.length);
    expect(q.tier).toBe("full");
    expect(q.weight).toBe(1);
  });

  it("marks a 'version bump only, no code changes' release empty", () => {
    // The qualifier ('code') sits between 'no' and 'changes' — the broadened
    // boilerplate match must catch it, not just the known-qualifier list.
    const text =
      "## 2.106.2-beta.2 (2026-05-22)\n\nThis was a version bump only, there were no code changes.";
    expect(classifyContentQuality(text, text.length).tier).toBe("empty");
  });

  it("marks the 'release notes do not describe the change' placeholder empty", () => {
    expect(classifyContentQuality("Release notes do not describe the change.", 41).tier).toBe(
      "empty",
    );
  });

  it("marks a bare 'Full Changelog' compare link empty", () => {
    const text =
      "**Full Changelog**: https://github.com/cloudflare/workerd/compare/v1.20260516.1...v1.20260517.1";
    expect(classifyContentQuality(text, text.length).tier).toBe("empty");
  });

  it("keeps a real release that happens to include a link as full", () => {
    const text =
      "Added streaming support and reworked the config loader for clarity. See the migration " +
      "guide at https://example.com/docs for upgrade steps, breaking-change notes, and examples.";
    expect(classifyContentQuality(text, text.length).tier).toBe("full");
  });

  it("does not over-exclude 'no new features' (lacks a changes/updates/fixes head)", () => {
    expect(classifyContentQuality("Bug fixes, no new features", 26).tier).toBe("thin");
  });

  it("classifies a substantial body as full", () => {
    expect(classifyContentQuality("x".repeat(400), 400).tier).toBe("full");
  });

  it("treats null/empty text with no char count as empty", () => {
    expect(classifyContentQuality(null, null).tier).toBe("empty");
    expect(classifyContentQuality("", null).tier).toBe("empty");
  });

  it("falls back to text length when contentChars is missing", () => {
    expect(classifyContentQuality("x".repeat(200), null).tier).toBe("full");
    expect(classifyContentQuality("tiny", null).tier).toBe("empty");
  });
});

describe("recencyMultiplier", () => {
  const now = Date.parse("2026-05-25T00:00:00Z");

  it("is ~1.0 for a brand-new dated item", () => {
    expect(recencyMultiplier(new Date(now).toISOString(), now)).toBeCloseTo(1, 5);
  });

  it("is ~0.5 at exactly one half-life", () => {
    const date = new Date(now - RELATED_RECENCY_HALF_LIFE_DAYS * DAY_MS).toISOString();
    expect(recencyMultiplier(date, now)).toBeCloseTo(0.5, 5);
  });

  it("is ~0.25 at two half-lives", () => {
    const date = new Date(now - 2 * RELATED_RECENCY_HALF_LIFE_DAYS * DAY_MS).toISOString();
    expect(recencyMultiplier(date, now)).toBeCloseTo(0.25, 5);
  });

  it("returns the undated penalty for null or unparseable dates", () => {
    expect(recencyMultiplier(null, now)).toBe(RELATED_UNDATED_PENALTY);
    expect(recencyMultiplier("not a date", now)).toBe(RELATED_UNDATED_PENALTY);
  });

  it("clamps future dates to <= 1.0", () => {
    const future = new Date(now + 10 * DAY_MS).toISOString();
    expect(recencyMultiplier(future, now)).toBeCloseTo(1, 5);
  });
});

describe("scoreRelatedRelease", () => {
  const now = Date.parse("2026-05-25T00:00:00Z");
  const full = "x".repeat(400);
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();

  it("excludes content-free candidates (tier=empty)", () => {
    const { tier } = scoreRelatedRelease(
      { score: 0.99, publishedAt: iso(1), summary: "- no changes", contentChars: 12 },
      now,
    );
    expect(tier).toBe("empty");
  });

  it("ranks a recent full release above an older full release at equal cosine", () => {
    const recent = scoreRelatedRelease(
      { score: 0.8, publishedAt: iso(5), summary: full, contentChars: 400 },
      now,
    );
    const old = scoreRelatedRelease(
      { score: 0.8, publishedAt: iso(180), summary: full, contentChars: 400 },
      now,
    );
    expect(recent.rank).toBeGreaterThan(old.rank);
  });

  it("ranks a full release above a thin one at equal cosine and date", () => {
    const fullItem = scoreRelatedRelease(
      { score: 0.8, publishedAt: iso(10), summary: full, contentChars: 400 },
      now,
    );
    const thinItem = scoreRelatedRelease(
      { score: 0.8, publishedAt: iso(10), summary: "Fixed a small bug", contentChars: 30 },
      now,
    );
    expect(fullItem.rank).toBeGreaterThan(thinItem.rank);
  });
});
