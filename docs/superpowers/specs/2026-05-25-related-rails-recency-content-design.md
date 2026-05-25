# Related rails: recency bias + content-first ranking

**Date:** 2026-05-25
**Status:** Approved, implementing
**Surface:** `GET /v1/related/releases`, `GET /v1/related/sources`, `web/src/components/related-rail.tsx`

## Problem

The "related content" rails on a release detail page (`More from {org}` / `From other products`) surface stale, content-free releases. Observed on the live `v2.1.150` (Claude Code) page:

- **Stale:** `From other products` showed Railway `v4.15.0` (Dec 2025) and Sentry CLI `2.47.1` (Jul 2025) on a page dated May 2026.
- **Empty:** nearly every card was `- no changes`, `No user-facing changes.`, or `Internal infrastructure improvements (no user-facing changes)`.

Root cause: the anchor release is itself a content-free "internal, no user-facing changes" release. Its embedding clusters with _other_ boilerplate "no changes" releases, so the entire Vectorize candidate pool is junk. The existing web-side recency decay (75-day half-life) then just picks the least-old members of an all-junk pool. **Content is the primary lever; recency is secondary and already partially present.**

## Decisions (from brainstorming)

1. **Content — hybrid.** Hard-exclude truly empty / boilerplate "no changes" releases so they never appear; only soft down-weight merely-thin ones (short-but-real) so they still show when they're the best available match. A rail renders fewer cards (or hides) rather than show junk.
2. **Recency — strengthen.** Shorten the half-life 75d → 45d on both rails and widen the candidate pool so recent content-rich matches can surface. Stays a soft preference (no hard cutoff) so a slow-moving org's months-old release can still fill its own `More from {org}` rail ("where possible").
3. **Where — centralize in the API (Approach A).** The endpoint does the full job (semantic → content classify → hard-exclude → rank → slice → return ranked). The web component stops reranking and just renders. Ranking becomes one pure, unit-testable function, and the `/related/sources` rail gets the same recency treatment for free.

## Design

### Pure helper — `workers/api/src/related-ranking.ts`

Worker-local (related rails are an API/web concern; not shared with the OSS CLI, so this stays out of `@buildinternet/releases-core`).

```ts
export type ContentTier = "empty" | "thin" | "full";

export const RELATED_RECENCY_HALF_LIFE_DAYS = 45;
export const RELATED_UNDATED_PENALTY = 0.25;
export const MIN_CONTENT_CHARS = 15;       // below this = empty regardless
export const BOILERPLATE_MAX_CHARS = 120;  // boilerplate phrase only excludes in a short body
export const THIN_CONTENT_CHARS = 160;     // real but short
export const THIN_WEIGHT = 0.5;

// "no changes" / "no user-facing changes" / "no notable updates" family
const BOILERPLATE_RE =
  /\bno\s+(?:(?:user[\s-]?facing|notable|significant|meaningful|functional|breaking|major|visible)\s+)*(?:changes?|updates?|fixes?)\b/i;

classifyContentQuality(text: string | null, contentChars: number | null): { tier; weight }
recencyMultiplier(date: string | null, now: number, halfLifeDays?, undatedPenalty?): number
```

**Classification:**

- `len = contentChars > 0 ? contentChars : text.length`
- `len < MIN_CONTENT_CHARS` → `empty` (weight 0) — catches `- no changes` (12), `No user-facing changes.` is caught by the next rule.
- `len < BOILERPLATE_MAX_CHARS && BOILERPLATE_RE.test(text)` → `empty` — catches the 60-char `Internal infrastructure improvements (no user-facing changes)` that a pure length test misses. The short-body gate means a rich 500-char release that merely _mentions_ "no breaking changes" is never falsely excluded.
- `len < THIN_CONTENT_CHARS` → `thin` (weight 0.5) — e.g. a one-line real bugfix. Down-weighted, still eligible.
- else → `full` (weight 1).

**Recency:** dated → `0.5^(ageDays / halfLife)`; undated/unparseable → fixed `undatedPenalty` (0.25). Same semantics as today, half-life 75 → 45.

**Combined rank (releases):** `cosineScore × recencyMultiplier × contentWeight`.

### `GET /v1/related/releases` (`workers/api/src/routes/related.ts`)

- Widen over-fetch: `topK = min(max(limit*10, 50), 100)` so enough survives the content + `excludeOrg` filter.
- Hydration SQL: add `COALESCE(r.content_chars, LENGTH(r.content), LENGTH(r.summary), 0) AS contentChars`. `summary` display column unchanged.
- New `excludeOrg` query param (org slug): drop rows whose `orgSlug === excludeOrg` server-side, _before_ slicing (today the web filters after fetching, which can starve the rail).
- Rank server-side: classify each hydrated row, drop `empty`, sort by combined rank desc, slice to `limit`, return in final order. `contentChars` stays internal — wire shape (`RelatedReleaseItem`) is unchanged.
- Update `describeRoute` to document `excludeOrg` and the new ranking behavior.

### `GET /v1/related/sources` (light)

Build all visible candidate items first, then sort by `cosineScore × recencyMultiplier(latestDate, now)` and slice to `limit`. No content weighting (a source isn't content); no new wire fields. (Endpoint currently has no web consumer — this is correctness/consistency only.)

### Web — `web/src/components/related-rail.tsx`

- Remove `RECENCY_HALF_LIFE_DAYS`, `UNDATED_PENALTY`, `recencyRank`, `rerankReleases`, the `fetchLimit` over-fetch, and the client-side `excludeOrgSlug` filter.
- Pass `excludeOrg` to the API; render the API's order directly; still return `null` when `items` is empty (honors "hide rather than show junk").
- `web/src/lib/api.ts`: `relatedReleases(releaseId, scope, limit, excludeOrg?)` appends `&excludeOrg=` when set.

## Testing

`tests/unit/related-ranking.test.ts` (pure, no D1):

- `classifyContentQuality`: `- no changes` / `No user-facing changes.` / `Internal infrastructure improvements (no user-facing changes)` → `empty`; a 30-char real bugfix → `thin`; a long body that mentions "no breaking changes" → `full` (no false exclusion); null/empty text + null contentChars → `empty`.
- `recencyMultiplier`: fresh ≈ 1.0; one half-life ≈ 0.5; undated/garbage → 0.25; future date clamped to ≤ 1.0.
- Combined ordering: a recent full release outranks an old full release at equal cosine; a full release outranks a thin one at equal cosine + date.

## Out of scope

- No new wire fields (`contentTier` etc.) — internal only.
- No change to the `releases_visible` view or embedding pipeline.
- Mounting a sources rail in the web UI (endpoint stays unmounted).

## Tunables

`RELATED_RECENCY_HALF_LIFE_DAYS=45`, `RELATED_UNDATED_PENALTY=0.25`, `MIN_CONTENT_CHARS=15`, `BOILERPLATE_MAX_CHARS=120`, `THIN_CONTENT_CHARS=160`, `THIN_WEIGHT=0.5`, `BOILERPLATE_RE`. All centralized in `related-ranking.ts`.
