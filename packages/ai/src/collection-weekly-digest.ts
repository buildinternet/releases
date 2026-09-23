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
  /** Usage summed across all generation attempts (1 or 2). */
  usage: WeeklyDigestUsage;
  /** How many model calls this digest took (1 = clean first attempt). */
  attempts: number;
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
  /**
   * Importance>=4 releases that did not fit under `MAX_RELEASES`. High-importance
   * releases sort first, so this is non-zero only when a single week has more
   * than `MAX_RELEASES` of them; the prompt surfaces the count explicitly so an
   * overflow is characterized in the digest rather than silently dropped.
   */
  omittedImportantCount: number;
} {
  if (releases.length <= MAX_RELEASES) {
    return { selected: releases, omittedCount: 0, omittedImportantCount: 0 };
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
  const omittedImportantCount = sorted
    .slice(MAX_RELEASES)
    .filter((r) => (r.importance ?? 0) >= 4).length;
  return { selected, omittedCount: releases.length - selected.length, omittedImportantCount };
}

export const SYSTEM_PROMPT = `You write a weekly digest — a short editorial roundup, like a mini blog post — for a curated collection of software products, covering everything that shipped that week across the collection's members. This is first-party editorial content published as a standalone page, not a changelog listing: readers come here to understand the week's story, then click through to specific releases for detail.

<output_structure>
Output exactly one <title>...</title> tag, then one <intro>...</intro> tag, then one <body>...</body> tag, then one <releases>...</releases> tag, in that order. Output nothing before, between, or after these tags.
</output_structure>

<consolidate_by_product>
Write about products, not releases. The input groups releases by product. When a product shipped several releases in the week — a CLI, SDK, or app cutting several versions — tell its week as ONE account: say it shipped a handful of updates, then describe what changed across all of them, grouped by what the changes do. (A news feed or company blog is different: its posts are separate announcements, and each can be its own story.) NEVER walk through a product's releases one version at a time. "v2.1.275 fixed X. 2.1.274 tackled Y. 2.1.276 patched a 2.1.275 regression." is WRONG. "Claude Code shipped eight updates, most of them fixes: [restored memory files no longer break prompt caching](rel:rel_A), [sessions stuck on a bad tool call now repair themselves](rel:rel_B), and [proxy users got a quick patch for a request error](rel:rel_C)." is RIGHT.

The product is the subject of every sentence, never a release. "The same release adds…", "that release also…", "the prior release had already…", "a later patch fixed…" all make a release the subject — the same recap in different words — and are WRONG. Write "pnpm also added…" or "Claude Code also fixed…". The order a product's releases shipped within the week almost never matters to the reader; describe what the product does now.

Consolidating changes the prose, not the coverage: every release marked "MUST be discussed and linked" still gets its own link, on the phrase naming its change, inside that product's account.

Version numbers and dates are never the subject of a sentence and never link anchor text: not "2.1.274 tackled…", not "v2.1.278 made…", not "Devin's September 18 release". Name a version only when the version itself is the news — a major release like "Next.js 16", or one broken release readers need to skip — and even then lead with the change. The page lists every cited release, with its exact version, below the digest, so the prose does not need to carry them.
</consolidate_by_product>

<title_format>
An editorial headline naming the theme of the week — not "Week of July 6 digest" and not a list of product names. When several products shipped the same KIND of change, name that theme. When one release clearly dominates, lead with it. No version numbers. Sentence case, no trailing punctuation, no quotation marks, no markdown. Target 40-90 characters; hard cap 90.
</title_format>

<intro_format>
One to two sentences: the lede, naming the week's most significant development(s) concretely — by product and change, not by version number. This doubles as the page's meta description, so it must stand alone without the body. No markdown, no opening filler ("This week"), no marketing language.
</intro_format>

<body_format>
300-600 words of markdown, organized into 2-4 thematic sections with ### headings (not "Overview" / "Releases" — name the actual themes, e.g. "### Faster local development" or "### Security hardening across the SDKs"). Write narrative prose: what shipped, why it matters to a developer using these tools, and connections between releases when there are any — NOT a bullet-per-release dump. Weight by impact: the biggest story of the week gets the most space; routine churn across many small releases gets a compact mention or is folded into a supporting sentence, not enumerated.

Inline release links are REQUIRED, not optional: every release you discuss must carry a link at its first mention, and a body with no links is invalid. The link form is [anchor text](rel:<id>) where <id> is the release's id copied VERBATIM from the square brackets in the input — the entire string including its "rel_" prefix, never shortened or re-cased. Example: for the input line "- [rel_abc123XYZexample0000] Acme / CLI: Faster builds", write [Acme's faster builds](rel:rel_abc123XYZexample0000). The anchor text is natural prose naming the change or the product — never a version number, a date, "here", or "this release". One sentence may carry several links, one per change it names. Only use ids from the input — never invent one. Do not use any other markdown link form.

Skip pure noise (dependency bumps, internal tooling, checksum-only releases) unless it's part of a broader theme worth naming.
</body_format>

<releases_format>
A single comma-separated list of every release id you linked in the body — each copied verbatim with its "rel_" prefix, no other text, no duplicates.
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
  selection: {
    selected: WeeklyDigestRelease[];
    omittedCount: number;
    omittedImportantCount?: number;
  },
): string {
  const labelOf = (r: WeeklyDigestRelease) =>
    r.product && r.product !== r.org ? `${r.org} / ${r.product}` : r.org;
  const renderRelease = (r: WeeklyDigestRelease) => {
    const label = labelOf(r);
    const tail = r.summary ? ` — ${r.summary}` : "";
    // Importance must be visible in the input: the generation gate requires
    // every importance>=4 release to be discussed + linked, which the model
    // can only honor if the line says so.
    const importanceTag =
      (r.importance ?? 0) >= 4
        ? ` [importance ${r.importance}/5 — MUST be discussed and linked]`
        : r.importance != null
          ? ` [importance ${r.importance}/5]`
          : "";
    const head = `- [${r.id}] ${label}: ${r.title}${tail} (${r.publishedAt.slice(0, 10)})${importanceTag}`;
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
  };
  // Group by product so a product's week reads as one unit. The selection is
  // importance-first, so interleaved per-release lines led the model to recap
  // a busy CLI version by version. Groups keep first-appearance order, which
  // puts the product with the week's most important release first.
  const groups = new Map<string, WeeklyDigestRelease[]>();
  for (const r of selection.selected) {
    const label = labelOf(r);
    const group = groups.get(label);
    if (group) group.push(r);
    else groups.set(label, [r]);
  }
  const lines = [...groups].flatMap(([label, rs]) => [
    "",
    `${label} (${rs.length} release${rs.length === 1 ? "" : "s"}):`,
    ...rs.map(renderRelease),
  ]);
  const omittedImportant = selection.omittedImportantCount ?? 0;
  const omittedNote =
    selection.omittedCount > 0
      ? [
          `(${selection.omittedCount} additional lower-priority release${
            selection.omittedCount === 1 ? "" : "s"
          } shipped this week and are omitted from this list — you may characterize them collectively, but do not cite a rel_ID for them.${
            omittedImportant > 0
              ? ` NOTE: ${omittedImportant} of the omitted releases are ALSO high-importance — this was an unusually heavy week; say so explicitly in the body.`
              : ""
          })`,
        ]
      : [];
  return [
    `Collection: ${input.collectionName}`,
    `Week starting (ET Monday): ${input.weekStart}`,
    `Releases (${selection.selected.length}), grouped by product:`,
    ...lines,
    "",
    ...omittedNote,
    // Trailing restatement of the hard requirements: on heavy weeks the rules
    // at the top of the system prompt are dozens of excerpts away, and
    // long-context adherence measurably drops (0-link outputs in the launch
    // backfill happened only on the largest inputs).
    `REMINDER: link every release you discuss as [anchor text](rel:<id>) using ids copied verbatim from the list above, and make sure every release marked "MUST be discussed and linked" is covered. A body with no (rel:...) links is invalid. Tell each product's week as one account of what changed, with the product (never a release) as the subject — anchor text names the change, never a version number or date.`,
  ].join("\n");
}

/**
 * Map a placeholder id to a provided release id. Models occasionally drop the
 * prefix: `rel:t067…` for `rel_t067…`, or just the `rel` when the nanoid
 * itself starts with `_` (`rel:___gix…` for `rel___gix…`). A repair counts
 * only when the rebuilt id is in the provided set, so nothing outside it ever
 * resolves.
 */
export function resolvePlaceholderId(id: string, idToPath: Map<string, string>): string | null {
  for (const candidate of [id, `rel_${id}`, `rel${id}`]) {
    if (idToPath.has(candidate)) return candidate;
  }
  return null;
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
  // The prompt forbids any link form other than (rel:...); enforce it here.
  // A model-authored URL is never trusted into first-party editorial content —
  // unlink it and keep the anchor text.
  const stripped = body.replace(
    /\[([^\]]*)\]\((?!rel:)[^)]*\)/g,
    (_full, anchor: string) => anchor,
  );
  const resolvedIds = new Set<string>();
  const re = /\[([^\]]*)\]\(rel:([A-Za-z0-9_-]+)\)/g;
  const resolvedBody = stripped.replace(re, (_full, anchor: string, rawId: string) => {
    const id = resolvePlaceholderId(rawId, idToPath);
    if (!id) return anchor; // unknown id — drop the link, keep the text
    resolvedIds.add(id);
    return `[${anchor}](${idToPath.get(id)!})`;
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

/** Model calls allowed per digest: one clean attempt plus one retry. */
export const MAX_GENERATION_ATTEMPTS = 2;

/** Placeholder ids referenced in a raw (pre-resolution) body. */
function rawPlaceholderIds(body: string): string[] {
  const ids: string[] = [];
  const re = /\[[^\]]*\]\(rel:([A-Za-z0-9_-]+)\)/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) ids.push(m[1]!);
  return ids;
}

/** A three-part version token (`v2.1.275`, `2.1.274`, `1.0.0-beta.2`). */
const VERSION_TOKEN_RE = /\bv?\d+\.\d+\.\d+/i;

/** An anchor this short that carries a version is a label, not a change. */
const VERSION_LABEL_MAX_WORDS = 4;

/**
 * Link anchors in a raw body that are version labels — the version-by-version
 * recap the prompt forbids ("[2.1.274](rel:…) tackled…", "[Deno 2.9.1](…)").
 * An anchor that names the change and mentions the version it shipped in
 * ("RUM Browser SDK 7.4.0 fixed a prototype pollution flaw") is fine, and
 * two-part names like "Next.js 16" are left alone: a major version can
 * legitimately be the news.
 */
export function versionAnchors(body: string): string[] {
  const anchors: string[] = [];
  const re = /\[([^\]]*)\]\(rel:[A-Za-z0-9_-]+\)/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const anchor = m[1]!;
    const words = anchor.trim().split(/\s+/).length;
    if (VERSION_TOKEN_RE.test(anchor) && words <= VERSION_LABEL_MAX_WORDS) anchors.push(anchor);
  }
  return anchors;
}

/**
 * Validate one generation attempt (eval-derived: fabricated ids and dropped
 * importance>=4 coverage were the two real failure modes of the chosen lane).
 *
 * - `hard` failures make the attempt unusable: too few links surviving
 *   resolution, or an importance>=4 release left uncited. Never accepted.
 * - `soft` failures trigger a retry, but the attempt is still shippable:
 *   fabricated ids (`resolveReleasePlaceholders` drops them to plain text,
 *   so the page degrades to slightly link-poorer, not broken) and
 *   version-number anchor text (reads as a changelog recap, but every claim
 *   and link still holds).
 */
export function validateWeeklyDigestAttempt(
  rawBody: string,
  resolvedIds: string[],
  selected: WeeklyDigestRelease[],
  idToPath: Map<string, string>,
): { hard: string | null; soft: string | null } {
  const fabricated = [...new Set(rawPlaceholderIds(rawBody))].filter(
    (id) => resolvePlaceholderId(id, idToPath) === null,
  );
  const minLinks = Math.min(3, selected.length);
  const cited = new Set(resolvedIds);
  const uncited = selected.filter((r) => (r.importance ?? 0) >= 4 && !cited.has(r.id));

  let hard: string | null = null;
  if (resolvedIds.length < minLinks) {
    hard = `too few resolvable release links (${resolvedIds.length} < ${minLinks})`;
  } else if (uncited.length > 0) {
    hard = `importance>=4 releases uncited: ${uncited.map((r) => r.id).join(", ")}`;
  }
  const versioned = versionAnchors(rawBody);
  const softReasons = [
    fabricated.length > 0 ? `fabricated release ids: ${fabricated.join(", ")}` : null,
    versioned.length > 0
      ? `version-number link anchors: ${versioned.map((a) => `"${a}"`).join(", ")}`
      : null,
  ].filter((s): s is string => s !== null);
  const soft = softReasons.length > 0 ? softReasons.join("; ") : null;
  return { hard, soft };
}

/**
 * Run a collection's week through the supplied TextModel, then resolve link
 * placeholders against `idToPath` (built by the caller from the *provided*
 * release set only). `releaseIds` on the result is derived from the resolved
 * body, not the model's self-reported `<releases>` tag — so a hallucinated id
 * can never end up in the persisted "releases covered" list.
 *
 * Validate-and-retry (model-eval outcome on PR #2115): each attempt is
 * checked with {@link validateWeeklyDigestAttempt}; a parse error or any
 * failure triggers one retry. A hard-clean attempt with only soft failures
 * is kept as a fallback and returned if the retry does no better. Two hard
 * failures throw — the caller treats that week like the quality-floor skip
 * rather than persisting a digest whose links don't hold up.
 */
export async function generateCollectionWeeklyDigest(
  model: TextModel,
  input: CollectionWeekInput,
  idToPath: Map<string, string>,
): Promise<WeeklyDigestResult> {
  const selection = selectWeeklyDigestReleases(input.releases);
  const user = buildCollectionWeekBlock(input, selection);

  const totalUsage: WeeklyDigestUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  let fallback: WeeklyDigestResult | null = null;
  let lastFailure = "no attempts ran";

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    // A retry names what the previous draft got wrong; an identical re-ask
    // mostly reproduces the same mistake.
    let completion: Awaited<ReturnType<TextModel["complete"]>>;
    try {
      completion = await model.complete({
        system: SYSTEM_PROMPT,
        user:
          attempt === 1
            ? user
            : `${user}\n\nYour previous draft was rejected (${lastFailure}). Write a new draft that fixes this.`,
        maxTokens: MAX_OUTPUT_TOKENS,
        cacheSystem: true,
      });
    } catch (err) {
      // A timed-out or failed call is a failed attempt, not a failed digest:
      // the retry may route to a healthier provider.
      lastFailure = `model call failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const { text, usage } = completion;
    totalUsage.input += usage.input;
    totalUsage.output += usage.output;
    totalUsage.cacheCreate += usage.cacheCreate;
    totalUsage.cacheRead += usage.cacheRead;

    let parsed: ReturnType<typeof parseWeeklyDigest>;
    try {
      parsed = parseWeeklyDigest(text);
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
      continue;
    }

    const { body, releaseIds } = resolveReleasePlaceholders(parsed.body, idToPath);
    const verdict = validateWeeklyDigestAttempt(
      parsed.body,
      releaseIds,
      selection.selected,
      idToPath,
    );
    const result: WeeklyDigestResult = {
      title: parsed.title,
      intro: parsed.intro,
      body,
      releaseIds,
      usage: { ...totalUsage },
      attempts: attempt,
    };

    if (!verdict.hard && !verdict.soft) return result;
    if (!verdict.hard) fallback = result; // shippable — bad links already dropped
    // Report every reason, so a retry can fix a hard and a soft failure at once.
    lastFailure =
      [verdict.hard, verdict.soft].filter(Boolean).join("; ") || "unknown validation failure";
  }

  if (fallback) {
    // Report the real number of model calls, not the attempt the fallback came from.
    return { ...fallback, usage: { ...totalUsage }, attempts: MAX_GENERATION_ATTEMPTS };
  }
  throw new Error(
    `weekly digest failed validation after ${MAX_GENERATION_ATTEMPTS} attempts: ${lastFailure}`,
  );
}
