/**
 * Generate a weekly "mini blog post" digest for a collection: an editorial
 * headline, a lede, and a markdown narrative covering that ET week's releases
 * across the collection's members. Sibling of `collection-summary.ts` (the
 * daily rollup) — same `TextModel` interface, same summarize lane, same
 * tagged-output parsing convention (`release-content.ts`'s `extractTagged`).
 *
 * Unlike the daily rollup, this module also resolves `(rel:rel_ID)` link
 * placeholders in the model's markdown output against the *provided* release
 * set — never trusting a model-authored URL — and drops/unlinks any id not in
 * that set.
 */
import { extractTagged } from "./release-content";
import type { TextModel } from "./text-model";

/** Cap on the model's response: headline + lede + a 300-600 word body. */
export const MAX_OUTPUT_TOKENS = 2048;

/**
 * Hard cap on releases fed to the model per week, importance-biased (see
 * `selectWeeklyDigestReleases`). Keeps the prompt bounded on a busy week
 * across a large collection.
 */
export const MAX_RELEASES = 40;

/** Per-release changelog-body excerpt cap (chars), mirroring the daily lane. */
export const PER_RELEASE_BODY_CHARS = 500;

/** A week needs at least this many substantive releases to be worth a digest. */
export const MIN_SUBSTANTIVE_RELEASES = 3;

/** A release counts as "substantive" once its body excerpt reaches this length. */
export const SUBSTANTIVE_BODY_CHARS = 200;

export interface WeeklyDigestRelease {
  id: string; // rel_...
  org: string;
  product: string | null;
  title: string;
  summary: string | null;
  body: string | null;
  publishedAt: string;
  importance: number | null;
}

export interface CollectionWeekInput {
  collectionName: string;
  weekStart: string; // YYYY-MM-DD (ET Monday)
  releases: WeeklyDigestRelease[];
}

export interface WeeklyDigestFields {
  title: string;
  intro: string;
  /** Markdown body with `(rel:rel_ID)` placeholders resolved to real paths. */
  body: string;
  /** `rel_` ids actually cited in the resolved body. */
  releaseIds: string[];
}

export interface WeeklyDigestUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface WeeklyDigestResult extends WeeklyDigestFields {
  usage: WeeklyDigestUsage;
}

/** Whether a release has enough substance to count toward the quality floor. */
export function isSubstantiveRelease(r: WeeklyDigestRelease): boolean {
  if (r.summary && r.summary.trim().length > 0) return true;
  return (r.body?.trim().length ?? 0) >= SUBSTANTIVE_BODY_CHARS;
}

/**
 * Importance-biased selection: every importance >= 4 release is always
 * included, then the cap is filled by importance DESC / recency DESC.
 * Returns the selected releases (capped at `MAX_RELEASES`) plus the count of
 * releases omitted because the week exceeded the cap.
 */
export function selectWeeklyDigestReleases(releases: WeeklyDigestRelease[]): {
  selected: WeeklyDigestRelease[];
  omittedCount: number;
} {
  if (releases.length <= MAX_RELEASES) {
    return { selected: releases, omittedCount: 0 };
  }
  const sorted = releases.toSorted((a, b) => {
    const aHigh = (a.importance ?? 0) >= 4 ? 1 : 0;
    const bHigh = (b.importance ?? 0) >= 4 ? 1 : 0;
    if (aHigh !== bHigh) return bHigh - aHigh;
    const aImp = a.importance ?? 0;
    const bImp = b.importance ?? 0;
    if (aImp !== bImp) return bImp - aImp;
    return b.publishedAt.localeCompare(a.publishedAt);
  });
  const selected = sorted.slice(0, MAX_RELEASES);
  return { selected, omittedCount: releases.length - selected.length };
}

export const SYSTEM_PROMPT = `You write a weekly digest — a short editorial roundup, like a mini blog post — for a curated collection of software products, covering everything that shipped that week across the collection's members. This is first-party editorial content published as a standalone page, not a changelog listing: readers come here to understand the week's story, then click through to specific releases for detail.

<output_structure>
Output exactly one <title>...</title> tag, then one <intro>...</intro> tag, then one <body>...</body> tag, then one <releases>...</releases> tag, in that order. Output nothing before, between, or after these tags.
</output_structure>

<title_format>
An editorial headline naming the theme of the week — not "Week of July 6 digest" and not a list of product names. When several products shipped the same KIND of change, name that theme. When one release clearly dominates, lead with it. Sentence case, no trailing punctuation, no quotation marks, no markdown. Target 40-90 characters.
</title_format>

<intro_format>
One to two sentences: the lede, naming the week's most significant development(s) concretely. This doubles as the page's meta description, so it must stand alone without the body. No markdown, no opening filler ("This week"), no marketing language.
</intro_format>

<body_format>
300-600 words of markdown, organized into 2-4 thematic sections with ### headings (not "Overview" / "Releases" — name the actual themes, e.g. "### Faster local development" or "### Security hardening across the SDKs"). Write narrative prose: what shipped, why it matters to a developer using these tools, and connections between releases when there are any — NOT a bullet-per-release dump. Weight by impact: the biggest story of the week gets the most space; routine churn across many small releases gets a compact mention or is folded into a supporting sentence, not enumerated.

Every time you reference a specific release, link it inline using the placeholder form [anchor text](rel:rel_ID), where rel_ID is exactly one of the release IDs given in the input and the anchor text is natural prose (the product name or the change, never "here" or "this release"). Only use IDs from the input — never invent one. Do not use any other markdown link form.

Skip pure noise (dependency bumps, internal tooling, checksum-only releases) unless it's part of a broader theme worth naming.
</body_format>

<releases_format>
A single comma-separated list of every rel_ID you actually referenced with a (rel:rel_ID) placeholder in the body — no other text, no duplicates.
</releases_format>`;

/** Collapse whitespace runs so an excerpt isn't mostly blank lines. */
function normalizeBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Render the user-message block from a week's selected releases. */
export function buildCollectionWeekBlock(
  input: CollectionWeekInput,
  selection: { selected: WeeklyDigestRelease[]; omittedCount: number },
): string {
  const lines = selection.selected.map((r) => {
    const label = r.product && r.product !== r.org ? `${r.org} / ${r.product}` : r.org;
    const tail = r.summary ? ` — ${r.summary}` : "";
    const head = `- [${r.id}] ${label}: ${r.title}${tail} (${r.publishedAt.slice(0, 10)})`;
    const normalized = r.body ? normalizeBody(r.body) : "";
    if (!normalized) return head;
    const excerpt =
      normalized.length > PER_RELEASE_BODY_CHARS
        ? `${normalized.slice(0, PER_RELEASE_BODY_CHARS)}…`
        : normalized;
    const indented = excerpt
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    return `${head}\n${indented}`;
  });
  const omittedNote =
    selection.omittedCount > 0
      ? [
          `(${selection.omittedCount} additional lower-priority release${
            selection.omittedCount === 1 ? "" : "s"
          } shipped this week and are omitted from this list — you may characterize them collectively, but do not cite a rel_ID for them.)`,
        ]
      : [];
  return [
    `Collection: ${input.collectionName}`,
    `Week starting (ET Monday): ${input.weekStart}`,
    `Releases (${selection.selected.length}):`,
    ...lines,
    ...omittedNote,
  ].join("\n");
}

/**
 * Resolve `(rel:rel_ID)` placeholders in a markdown body against the provided
 * release-id → path map. An id not present in the map is unlinked — the
 * anchor text is kept as plain text, never trusted as a URL. Returns the
 * resolved body plus the deduplicated list of ids actually resolved.
 */
export function resolveReleasePlaceholders(
  body: string,
  idToPath: Map<string, string>,
): { body: string; releaseIds: string[] } {
  const resolvedIds = new Set<string>();
  const re = /\[([^\]]*)\]\(rel:([A-Za-z0-9_-]+)\)/g;
  const resolvedBody = body.replace(re, (full, anchor: string, id: string) => {
    const path = idToPath.get(id);
    if (!path) return anchor; // unknown id — drop the link, keep the text
    resolvedIds.add(id);
    return `[${anchor}](${path})`;
  });
  return { body: resolvedBody, releaseIds: [...resolvedIds] };
}

/** Parse a model response into title/intro/body (pre-link-resolution) + cited ids. */
export function parseWeeklyDigest(raw: string): {
  title: string;
  intro: string;
  body: string;
  citedIds: string[];
} {
  const title = extractTagged(raw, "title");
  if (!title) {
    throw new Error(`model output missing <title> tag (raw length ${raw.length})`);
  }
  const intro = extractTagged(raw, "intro");
  if (!intro) {
    throw new Error(`model output missing <intro> tag (raw length ${raw.length})`);
  }
  const body = extractTagged(raw, "body");
  if (!body) {
    throw new Error(`model output missing <body> tag (raw length ${raw.length})`);
  }
  const releasesRaw = extractTagged(raw, "releases");
  const citedIds = releasesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { title, intro, body, citedIds };
}

/**
 * Run a collection's week through the supplied TextModel, then resolve link
 * placeholders against `idToPath` (built by the caller from the *provided*
 * release set only). `releaseIds` on the result is derived from the resolved
 * body, not the model's self-reported `<releases>` tag — so a hallucinated id
 * can never end up in the persisted "releases covered" list.
 */
export async function generateCollectionWeeklyDigest(
  model: TextModel,
  input: CollectionWeekInput,
  idToPath: Map<string, string>,
): Promise<WeeklyDigestResult> {
  const selection = selectWeeklyDigestReleases(input.releases);
  const { text, usage } = await model.complete({
    system: SYSTEM_PROMPT,
    user: buildCollectionWeekBlock(input, selection),
    maxTokens: MAX_OUTPUT_TOKENS,
    cacheSystem: true,
  });
  const parsed = parseWeeklyDigest(text);
  const { body, releaseIds } = resolveReleasePlaceholders(parsed.body, idToPath);
  return {
    title: parsed.title,
    intro: parsed.intro,
    body,
    releaseIds,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheCreate: usage.cacheCreate,
      cacheRead: usage.cacheRead,
    },
  };
}
