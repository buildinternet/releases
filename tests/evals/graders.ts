/**
 * Pure grading helpers for the local ad-hoc evals. No AI, no fs — unit-tested
 * deterministically in graders.test.ts (which DOES run under `bun test`).
 */
import type { FieldResult } from "./helpers";

// ── Binary grading (marketing classifier) ──────────────────────────

export interface BinaryCase {
  id: string;
  /** Ground-truth label: true == marketing (should be suppressed). */
  expected: boolean;
}
export interface BinaryPrediction {
  id: string;
  predicted: boolean;
}
export interface BinaryGradeResult {
  total: number;
  correct: number;
  accuracy: number;
  /** Predicted marketing, actually a real release → a real release gets hidden. The costly error. */
  falsePositives: number;
  /** Predicted real, actually marketing → marketing slips through. The cheaper error. */
  falseNegatives: number;
  perCase: Array<{ id: string; expected: boolean; predicted: boolean; passed: boolean }>;
}

export function gradeBinary(
  cases: BinaryCase[],
  predictions: BinaryPrediction[],
): BinaryGradeResult {
  const byId = new Map(predictions.map((p) => [p.id, p.predicted]));
  let correct = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const perCase: BinaryGradeResult["perCase"] = [];

  for (const c of cases) {
    if (!byId.has(c.id)) throw new Error(`no prediction for case "${c.id}"`);
    const predicted = byId.get(c.id)!;
    const passed = predicted === c.expected;
    if (passed) correct++;
    else if (predicted && !c.expected) falsePositives++;
    else if (!predicted && c.expected) falseNegatives++;
    perCase.push({ id: c.id, expected: c.expected, predicted, passed });
  }

  return {
    total: cases.length,
    correct,
    accuracy: cases.length > 0 ? correct / cases.length : 0,
    falsePositives,
    falseNegatives,
    perCase,
  };
}

// ── Structural grading (release summary, Tier 1) ───────────────────

/** Unambiguous leakage signals — always checked in summary + titleShort. */
export const DEFAULT_FORBIDDEN_SUBSTRINGS = ["</", "```", "Body:"];

export interface StructuralSpec {
  /** true => empty/boilerplate body: summary + titleShort must be null. */
  expectDiscarded: boolean;
  /** Defaults to true when not discarded. */
  summaryMustBeNonEmpty?: boolean;
  /** Per-fixture leakage tokens, on top of the defaults. */
  forbidInSummary?: string[];
}
export interface SummaryArtifact {
  summary: string | null;
  titleShort: string | null;
  skipped: boolean;
}
export interface StructuralGradeOptions {
  titleShortMaxChars?: number;
  /** Caller-injected tokens, e.g. the EMPTY_BODY_FALLBACK sentinel. */
  extraForbidden?: string[];
}
export interface StructuralGradeResult {
  passed: boolean;
  fields: FieldResult[];
}

export function gradeStructural(
  spec: StructuralSpec,
  artifact: SummaryArtifact,
  opts: StructuralGradeOptions = {},
): StructuralGradeResult {
  const fields: FieldResult[] = [];
  const max = opts.titleShortMaxChars ?? 120;

  if (spec.expectDiscarded) {
    fields.push({
      field: "summary discarded",
      passed: artifact.summary === null,
      expected: null,
      actual: artifact.summary,
    });
    fields.push({
      field: "titleShort discarded",
      passed: artifact.titleShort === null,
      expected: null,
      actual: artifact.titleShort,
    });
    return { passed: fields.every((f) => f.passed), fields };
  }

  const mustBeNonEmpty = spec.summaryMustBeNonEmpty ?? true;
  if (mustBeNonEmpty) {
    const nonEmpty = artifact.summary !== null && artifact.summary.trim().length > 0;
    fields.push({
      field: "summary non-empty",
      passed: nonEmpty,
      expected: "non-empty",
      actual: artifact.summary,
    });
  }

  const forbidden = [
    ...DEFAULT_FORBIDDEN_SUBSTRINGS,
    ...(opts.extraForbidden ?? []),
    ...(spec.forbidInSummary ?? []),
  ];
  for (const [label, text] of [
    ["summary", artifact.summary],
    ["titleShort", artifact.titleShort],
  ] as const) {
    if (text === null) continue;
    const hit = forbidden.find((tok) => text.includes(tok));
    fields.push({
      field: `no leakage (${label})`,
      passed: hit === undefined,
      expected: "clean",
      actual: hit ?? "clean",
    });
  }

  if (artifact.titleShort !== null) {
    fields.push({
      field: "titleShort length",
      passed: artifact.titleShort.length <= max,
      expected: `<= ${max}`,
      actual: artifact.titleShort.length,
    });
  }

  return { passed: fields.every((f) => f.passed), fields };
}

// ── Overview structural grading (org overviews, Tier 1) ─────────────
//
// The deterministic half of the overview rubric (src/shared/rubrics/overview.md).
// The judgment-heavy criteria — synthesis across sources, weighting, voice,
// faithfulness — are left to the optional Sonnet judge in overview.eval.ts.
// These checks are the ones a regex can settle without an API call.

/** Buzzwords the rubric's "prefer plain language" rule bans outright. */
export const OVERVIEW_BANNED_WORDS = [
  "next-generation",
  "cutting-edge",
  "world-class",
  "best-in-class",
  "seamless",
  "transformative",
  "comprehensive",
  "leverage",
  "utilize",
  "facilitate",
];

/** Filler / sign-off phrases the rubric forbids (Content + Output discipline). */
export const OVERVIEW_BANNED_PHRASES = [
  "continues to evolve",
  "received improvements",
  "substantial updates",
  "robust enhancements",
  "exciting new features",
  "stay tuned",
  "more to come",
];

/** Envelope / prompt-leakage tokens that must never reach the body. */
export const OVERVIEW_LEAKAGE_TOKENS = ["</", "```", "<existing-page", "<release-meta", "<media>"];

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "loom.com"];

export interface OverviewStructuralSpec {
  /** Org display name — the body must not lead with a line that is just this. */
  orgName: string;
  /** Hard floor on word count. Rubric default 80. */
  minWords?: number;
  /** Hard ceiling on word count. Rubric default 300. */
  maxWords?: number;
  /** Max media items (images + video links). Rubric default 2. */
  maxMedia?: number;
  /** Extra fixture-specific banned phrases on top of the defaults. */
  extraBannedPhrases?: string[];
}

/**
 * Count human-visible words: strip image syntax, reduce links to their text,
 * drop formatting punctuation, then split on whitespace. An approximation good
 * enough to settle the 80–300 band, not an exact typesetter's count.
 */
export function countOverviewWords(body: string): number {
  const plain = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images → nothing
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/[*_`>#]/g, " ") // markdown emphasis/heading/quote marks
    .replace(/^\s*[-+]\s+/gm, " ") // bullet markers
    .replace(/\s+/g, " ")
    .trim();
  return plain.length === 0 ? 0 : plain.split(" ").length;
}

/** Count markdown images plus links that point at a known video host. */
export function countOverviewMedia(body: string): number {
  const images = body.match(/!\[[^\]]*\]\([^)]*\)/g) ?? [];
  const links = body.match(/(?<!!)\[[^\]]*\]\(([^)]*)\)/g) ?? [];
  const videoLinks = links.filter((l) => {
    const url = (l.match(/\(([^)]*)\)/)?.[1] ?? "").toLowerCase();
    return VIDEO_HOSTS.some((h) => url.includes(h));
  });
  return images.length + videoLinks.length;
}

/** First non-empty line, stripped of leading markdown heading/bold marks. */
function firstContentLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length > 0)
      return line
        .replace(/^#+\s*/, "")
        .replace(/\*+/g, "")
        .trim();
  }
  return "";
}

export function gradeOverviewStructural(
  body: string,
  spec: OverviewStructuralSpec,
): StructuralGradeResult {
  const fields: FieldResult[] = [];
  const minWords = spec.minWords ?? 80;
  const maxWords = spec.maxWords ?? 300;
  const maxMedia = spec.maxMedia ?? 2;

  const trimmed = body.trim();
  fields.push({
    field: "non-empty",
    passed: trimmed.length > 0,
    expected: "non-empty",
    actual: trimmed.length > 0 ? "non-empty" : "empty",
  });

  // No markdown headings anywhere — the UI renders structure.
  const headingHit = /^[ \t]{0,3}#{1,6}\s/m.test(body);
  fields.push({
    field: "no markdown headings",
    passed: !headingHit,
    expected: "none",
    actual: headingHit ? "heading present" : "none",
  });

  // Must not lead with a bare org-name title.
  const lead = firstContentLine(body);
  const leadsWithOrgName = lead.toLowerCase() === spec.orgName.trim().toLowerCase();
  fields.push({
    field: "no leading org-name title",
    passed: !leadsWithOrgName,
    expected: `!= "${spec.orgName}"`,
    actual: lead,
  });

  const words = countOverviewWords(body);
  fields.push({
    field: "word count",
    passed: words >= minWords && words <= maxWords,
    expected: `${minWords}–${maxWords}`,
    actual: words,
  });

  const media = countOverviewMedia(body);
  fields.push({
    field: "media cap",
    passed: media <= maxMedia,
    expected: `<= ${maxMedia}`,
    actual: media,
  });

  const bannedWordHit = OVERVIEW_BANNED_WORDS.find((w) => new RegExp(`\\b${w}\\b`, "i").test(body));
  fields.push({
    field: "no banned buzzwords",
    passed: bannedWordHit === undefined,
    expected: "clean",
    actual: bannedWordHit ?? "clean",
  });

  const lower = body.toLowerCase();
  const bannedPhrases = [...OVERVIEW_BANNED_PHRASES, ...(spec.extraBannedPhrases ?? [])];
  const phraseHit = bannedPhrases.find((p) => lower.includes(p.toLowerCase()));
  fields.push({
    field: "no filler phrases",
    passed: phraseHit === undefined,
    expected: "clean",
    actual: phraseHit ?? "clean",
  });

  const leakHit = OVERVIEW_LEAKAGE_TOKENS.find((t) => body.includes(t));
  fields.push({
    field: "no leakage",
    passed: leakHit === undefined,
    expected: "clean",
    actual: leakHit ?? "clean",
  });

  return { passed: fields.every((f) => f.passed), fields };
}

// ── Citation integrity grading (org overviews, Tier 1) ──────────────
//
// Checks the citations the model actually emitted (post extract + clamp)
// against the body and the set of input release sources. A citation that
// resolves to no provided source is a misattribution; an out-of-bounds span
// is a clamp regression; both ship a wrong outbound link silently.

export interface CitationLike {
  startIndex: number;
  endIndex: number;
  sourceUrl: string;
  citedText: string;
}

export interface CitationGradeSpec {
  /** Minimum citations the body should carry. Default 1. Set 0 for thin sources. */
  minCitations?: number;
}

export function gradeCitations(
  body: string,
  citations: CitationLike[],
  validSources: Iterable<string>,
  spec: CitationGradeSpec = {},
): StructuralGradeResult {
  const fields: FieldResult[] = [];
  const minCitations = spec.minCitations ?? 1;
  const valid = new Set(validSources);

  fields.push({
    field: "citations present",
    passed: citations.length >= minCitations,
    expected: `>= ${minCitations}`,
    actual: citations.length,
  });

  const unresolved = citations.filter((c) => !valid.has(c.sourceUrl));
  fields.push({
    field: "all sources resolve",
    passed: unresolved.length === 0,
    expected: "all resolve to an input release",
    actual: unresolved.length === 0 ? "all resolve" : unresolved.map((c) => c.sourceUrl),
  });

  const max = body.length;
  const outOfBounds = citations.filter(
    (c) => c.startIndex < 0 || c.endIndex > max || c.endIndex <= c.startIndex,
  );
  fields.push({
    field: "offsets in bounds",
    passed: outOfBounds.length === 0,
    expected: `0 <= start < end <= ${max}`,
    actual:
      outOfBounds.length === 0
        ? "in bounds"
        : outOfBounds.map((c) => `[${c.startIndex},${c.endIndex}]`),
  });

  const emptyCited = citations.filter((c) => c.citedText.trim().length === 0);
  fields.push({
    field: "cited text present",
    passed: emptyCited.length === 0,
    expected: "every citation quotes source text",
    actual: emptyCited.length === 0 ? "all present" : `${emptyCited.length} empty`,
  });

  return { passed: fields.every((f) => f.passed), fields };
}

// ── Article extraction grading (feed-enrich) ──────────────────────────

export interface ArticleSpec {
  title: string;
  mustContain?: string[];
  mustNotContain?: string[];
  /** Upper bound on body length — for shell/index pages, the extracted body must
   *  stay below the enrichment thin-floor so production discards it. */
  maxChars?: number;
  minChars?: number;
}

/**
 * Structural check for single-article extraction. Returns every failed
 * expectation (an empty array == pass): `mustContain` phrases must survive
 * VERBATIM (also catches paraphrasing, since a reworded body won't contain the
 * exact phrase); `mustNotContain` phrases (chrome / other-article text) must be
 * dropped; `maxChars` caps a shell/index page's body below the enrichment floor;
 * `minChars` floors a real body.
 */
export function gradeArticle(spec: ArticleSpec, content: string): string[] {
  const failures: string[] = [];
  if (spec.maxChars != null && content.length > spec.maxChars) {
    failures.push(`body too long for a shell page: ${content.length} > ${spec.maxChars}`);
  }
  if (spec.minChars != null && content.length < spec.minChars) {
    failures.push(`body too short: ${content.length} < ${spec.minChars}`);
  }
  for (const needle of spec.mustContain ?? []) {
    if (!content.includes(needle)) failures.push(`missing (dropped or paraphrased): "${needle}"`);
  }
  for (const banned of spec.mustNotContain ?? []) {
    if (content.includes(banned)) failures.push(`leaked chrome / other article: "${banned}"`);
  }
  return failures;
}
