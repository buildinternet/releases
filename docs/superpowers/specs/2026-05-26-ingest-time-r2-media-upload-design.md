# 2026-05-26 — #1177 Ingest-time R2 upload of release media

Mirror third-party release media to the `released-media` R2 bucket **at ingest**
so images are served same-origin from `media.releases.sh` (`r2Url`) instead of as
raw vendor-CDN URLs. This is the deferred **Option B** from #1033.

Once release media is same-origin, the #1174 release-feed thumbnail transform no
longer needs the open "Any origin" Cloudflare Image Transformations setting that
issue #1176 enabled — so a second outcome of this work is **tightening CF Sources back
to "Specified origins"** (an owner dashboard action) and repointing the AGENTS.md
"Media pipeline" bullet from the closed #1033 to here.

---

## Background — what already exists

- **Stored shape.** The `releases.media` column holds a JSON array of
  `MediaRef`-shaped items `{ type, url, alt?, r2Key? }`
  (`packages/rendering/src/media.ts`). The wire/API shape is `MediaItem`
  `{ type, url, alt?, r2Url? }` (`packages/api-types/src/schemas/shared.ts`).
- **Read side is already done.** `parseReleaseMedia` (`workers/api/src/utils.ts`)
  resolves each stored `r2Key` → public `r2Url` via
  `resolveR2Url(r2Key, mediaOrigin)` = `${mediaOrigin}/${r2Key}`. Every read path
  (`/v1/orgs/:slug/releases`, search, related, GraphQL, sources, overview-inputs)
  funnels through it, and the web call sites already prefer `r2Url ?? url`. **So
  ingest only needs to populate `r2Key` on the stored item — no wire/read change.**
- **Upload plumbing.** `MEDIA.put` exists at `PUT /v1/media/:key`
  (`workers/api/src/routes/media.ts`); the `media_assets` registry table
  (`packages/core/src/schema.ts`: `UNIQUE(r2_key)`, `UNIQUE(content_hash)`,
  indexed `source_id`/`release_id`/`content_hash`) is written via
  `POST /v1/media/assets` (chunked at 9 rows/insert for the 100-bind D1 cap). The
  one existing caller is the one-shot `scripts/upload-org-avatars.ts`
  (`orgs/{slug}.{ext}` keys).
- **Bindings.** The API worker already binds `MEDIA` (R2 `released-media`) and
  `MEDIA_ORIGIN = https://media.releases.sh`. No new bindings or secrets — the CF
  `CLOUDFLARE_*` secrets are for Browser Rendering (feed-enrich), not R2.
- **No pipeline today.** `filterJunkMedia` / `processMediaForR2` (historically
  described in AGENTS.md) do not exist. Ingest stores third-party URLs verbatim
  modulo `normalizeMediaUrl` (Next/Vercel optimizer unwrap). The only
  junk-related symbol is `isJunkMediaUrl` + `SMALL_MEDIA_MARKERS` in
  `web/src/lib/og-helpers.ts` — a client-side OG hero-image filter, not an
  ingest gate.

---

## Locked decisions

| Fork           | Decision                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upload timing  | **Synchronous, pre-insert** — `r2Key` present on first read; one DB write; matches the existing feed-enrich / marketing-classifier pre-insert pattern. Bounded (caps + per-image timeout + limited concurrency) and fail-open. |
| Write coverage | **Two dominant fresh-media paths** — cron `poll-fetch` insert + `/releases/batch` endpoint (feed, scrape, agent/extract). Defer App Store materialization + on-demand GitHub lookup to a fast-follow.                          |
| Backfill       | **Follow-up issue** — forward path only; existing third-party rows keep rendering via passthrough.                                                                                                                             |
| Junk filter    | URL pre-filter (favicons, tracking pixels, avatar/`?s=NN` markers, `data:`) **plus** a post-fetch gate (`Content-Type ∈ image/*`, byte size in `[floor, ceiling]`). The fetch is free since we fetch to upload anyway.         |
| R2 key         | Content-hash: `releases/{sha256-of-bytes}.{ext-from-content-type}`. Matches `media_assets` `UNIQUE(content_hash)`/`UNIQUE(r2_key)`, gives free dedup, idempotent re-upload.                                                    |
| Rollout        | Feature-gated behind `MEDIA_R2_UPLOAD_ENABLED` (default **off**). Flag-off = byte-identical current behavior; rollback = unset flag, no deploy.                                                                                |

---

## Components

### 1. `filterJunkMedia(media)` — pure, URL-based pre-filter

Generalizes the OG-side heuristic into a shared, runtime-neutral helper (new
`packages/rendering/src/media-filter.ts`, or co-located with `media-url.ts`).
Drops items whose URL matches junk markers:

- the existing `SMALL_MEDIA_MARKERS` (avatar crops `c_fill,w_44…`, `/avatar/`,
  `?s=32…64`),
- favicon paths (`/favicon`, `favicon.ico`),
- 1×1 / tracking-pixel markers,
- `data:` URIs (inline, not worth mirroring).

`web/src/lib/og-helpers.ts`'s `isJunkMediaUrl` is refactored to delegate to the
shared marker list so the two never drift. Pure → fully unit-testable; no fetch.

### 2. `processMediaForR2(media, opts)` — worker R2 uploader

New worker module `workers/api/src/lib/media-ingest.ts`. Signature roughly:

```ts
processMediaForR2(
  media: MediaRef[],
  opts: {
    db: Db;
    bucket: R2Bucket;          // env.MEDIA
    sourceId?: string | null;
    perItemTimeoutMs?: number; // default ~5_000
    maxItems?: number;         // per-release cap
    concurrency?: number;      // small, e.g. 4
  },
): Promise<MediaRef[]>         // same array, r2Key set where upload succeeded
```

Per surviving item, with bounded concurrency and a per-item `AbortController`
timeout:

1. `fetch(url)` (plain `fetch`, no auth).
2. **Validate** the response: `Content-Type` matches
   `image/(png|jpe?g|gif|webp|avif)`; `byteLength` in `[MEDIA_MIN_BYTES,
MEDIA_MAX_BYTES]` (floor drops spacers/pixels; ceiling drops absurd payloads).
   On miss → skip (leave item untouched, no `r2Key`).
3. `sha256(arrayBuffer)` via Web Crypto (`crypto.subtle.digest`) → hex.
4. `r2Key = releases/{hash}.{ext}` (ext derived from the validated content-type).
5. `MEDIA.put(r2Key, bytes, { httpMetadata: { contentType } })` — idempotent
   (identical bytes → identical key).
6. Register in `media_assets` via drizzle `insert(...).onConflictDoNothing()`
   (`content_hash` + `r2_key` UNIQUE absorb duplicates). `release_id` is null at
   pre-insert time (the column is nullable + informational); `source_id` set when
   known.
7. Set `item.r2Key = r2Key`.

**Fail-open everywhere:** any fetch error, timeout, non-image, out-of-range size,
`put` error, or registry error logs `logEvent("warn", { component:
"media-r2-upload", event, sourceId, url, err })` and leaves the original
third-party URL in place. A bad image never blocks a release.

**Caps:** per-release `maxItems` and a per-fire / per-batch total cap so a single
fire can't fan out unbounded fetches. Concurrency is small to avoid hammering one
host. Counts logged for observability.

### 3. Wiring the two ingest paths

Both are flag-gated on `MEDIA_R2_UPLOAD_ENABLED === "true"`; flag-off keeps the
exact current code path.

- **`workers/api/src/cron/poll-fetch.ts` (~1231).** The synchronous
  `rawReleases.map(...)` row build becomes an async pre-pass: for each raw
  release, `filterJunkMedia(media)` then `await processMediaForR2(...)`, producing
  media with `r2Key` set, then serialize into the insert row — keeping the
  existing `normalizeMediaUrl` URL unwrap. Runs inside the poll-fetch Workflow
  `step.do`, which has a generous wall-clock budget.
- **`workers/api/src/routes/sources.ts` `/releases/batch` (~708).** `r.media`
  arrives as a JSON string. Parse → `filterJunkMedia` → `await
processMediaForR2(...)` → re-serialize before the insert row is built. This is
  the latency-sensitive request path; the per-fire cap + per-item timeout +
  bounded concurrency keep it controlled.

### 4. Web same-origin transform gate (`web/src/lib/media.ts`)

`releaseThumbUrl(src, width)` currently applies `cfImageUrl` to **any** absolute
URL when `NEXT_PUBLIC_RELEASES_IMG_TRANSFORM` is on — which only works while CF
Sources = "Any origin". Gate it to same-origin:

```ts
export function releaseThumbUrl(src: string, width: number): string {
  if (!IMG_TRANSFORM_ON) return src;
  if (!src.startsWith(MEDIA_ORIGIN)) return src; // third-party → passthrough
  return cfImageUrl(src, { origin: MEDIA_ORIGIN, width });
}
```

Call sites already pass `r2Url ?? url`, so R2-hosted media (`media.releases.sh/…`)
flows through the transform (crisp) and third-party media passes through
untransformed (jagged, never broken). **This is the linchpin that makes tightening
CF Sources back to "Specified origins" safe regardless of how much media has been
uploaded** — we simply never ask CF to transform a cross-origin source again. It
also de-risks the still-pending Vercel flag flip (#1176).

### 5. CF Sources tighten + docs (acceptance criteria)

- **Owner dashboard action** (can't be done from code): after deploy + verifying
  new media lands on R2, set Cloudflare → Images → Transformations → Sources back
  from "Any origin" to "Specified origins" (`releases.sh` + `media.releases.sh`).
  This spec provides the verification curls; #1176 and #1177 get updated to record
  the reversal.
- **AGENTS.md.** Rewrite the "Media pipeline" bullet: repoint #1033 → #1177 and
  describe the now-real behavior (ingest-time R2 upload gated by
  `MEDIA_R2_UPLOAD_ENABLED`; `filterJunkMedia` + `processMediaForR2`; content-hash
  keying; same-origin thumbnail transform). Cross-check `docs/architecture/web.md`.

---

## Data / schema

**No schema change.** `media_assets` already has the columns + UNIQUE
constraints; the stored `media` JSON's `r2Key` is an already-supported optional
field. No migration → the schema-pairing CI gate is not triggered.

---

## Failure modes & safety

- Flag default off → zero behavior change until flipped; rollback = unset flag, no
  deploy.
- Fail-open: any image-level failure keeps the third-party URL; ingest never
  blocked.
- Bounded: per-release + per-fire caps, per-item timeout, small concurrency limit.
- Idempotent: content-hash key + `onConflictDoNothing` → retries/re-ingest never
  duplicate R2 objects or registry rows.

---

## Testing

- **Unit (`bun test`):**
  - `filterJunkMedia` — drops each marker class + `data:` URIs; passes real image
    URLs through.
  - `processMediaForR2` — mocked `fetch` + a fake `R2Bucket` + `createTestDb`:
    asserts `r2Key` set on success, `MEDIA.put` called with the hash-derived key,
    a `media_assets` row written; and fail-open (item untouched) on non-image
    content-type, out-of-range size, fetch error, and timeout. Asserts caps +
    dedup (same bytes → one object).
  - `releaseThumbUrl` — transforms a `media.releases.sh` src, passes a third-party
    src through unchanged (flag on); passthrough when flag off.
- **Type/lint:** `npx tsc --noEmit` (root + `workers/api` + `web`); `bun run lint`.
- **Smoke (R2 / cf.image can't run locally):** branch deploy
  `gh workflow run deploy-workers.yml --ref <branch> -f worker=api -f
environment=production`, trigger a fetch on a media-rich source, confirm
  `media-r2-upload` events in Axiom (`releases-cloudflare-logs`) and a
  `GET media.releases.sh/releases/{hash}.{ext}` → 200. Only then tighten CF
  Sources and verify a third-party transform now 403s while an R2 source 200s.

---

## Out of scope (YAGNI / follow-ups)

- **Backfill** of existing third-party rows → separate issue (walk `releases` →
  `processMediaForR2` → `UPDATE media`).
- **App Store materialization** + **on-demand GitHub lookup** ingest wiring →
  fast-follow (low fresh-media volume).
- **Body-image (`/_media/`) pipeline** — already served same-origin via
  `hydrateMediaUrls`; untouched here.
