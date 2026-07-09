# Media Thumbnails on Compact Release Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small image thumbnail on compact release cards/rows (home RECENT ticker, org "Latest releases" teaser, "also covered by" rail, lookup-rail preview) whenever the release has usable image/GIF media — rendered exactly as today when it doesn't.

**Architecture:** One thumbnail-derivation primitive per runtime. On the API worker, extract the existing inline `firstImageThumbnail(raw, mediaOrigin)` from `related.ts` into `utils.ts` and reuse it to add a server-derived `thumbnail` field to the coverage and lookup wire payloads. On the web, add a `pickReleaseThumb(media)` helper (for GraphQL-fed surfaces that carry the raw `media[]`) and a shared `<ReleaseThumb>` presentational component reused across all new render sites, matching the existing `related-rail.tsx` treatment.

**Tech Stack:** Bun, TypeScript (strict), Hono + Drizzle (D1) API worker, Next.js web, GraphQL Codegen, Zod (`@buildinternet/releases-api-types`), `bun test`.

## Global Constraints

- Runtime: **Bun**. Tests run with `bun test`. Lint/format/type: `bun run check` (oxlint + oxfmt).
- Public repo — **no PII** in any committed file (no absolute home-dir paths; use `~/…` or repo-relative; `@example.com` in fixtures).
- **No emojis in web UI** — use SVG/icon components.
- `@buildinternet/releases-api-types` is **published** and consumed by the OSS CLI — wire changes must be **additive + optional** (no renames/removals).
- **Do NOT create a new changeset.** Extend the existing pending `.changeset/latest-feed-kind-group.md` (already `@buildinternet/releases-api-types: minor`).
- Worker code logs via `logEvent()` (not the fs logger) — not expected to be needed here, but obey if adding logs.
- "Usable media" = first `media[]` entry of `type === "image" || "gif"`, url = `r2Url ?? url`. Video-only media is NOT used as a thumbnail here (matches `firstImageThumbnail` semantics).
- No layout shift when a release has no media — the thumbnail node is simply absent.
- `bun run check` and the relevant `bun test` invocation must pass before each commit.

---

### Task 1: Extract `firstImageThumbnail` into the API `utils.ts`

Move the private inline picker out of `related.ts` so coverage + lookup can reuse the single derivation. Behavior is unchanged.

**Files:**
- Modify: `workers/api/src/utils.ts` (add exported fn after `parseReleaseMedia`, ~line 88)
- Modify: `workers/api/src/routes/related.ts` (remove local fn at ~369-379; import from utils)
- Test: `workers/api/src/utils.test.ts`

**Interfaces:**
- Produces: `export function firstImageThumbnail(raw: string | null, mediaOrigin: string): { url: string; alt?: string } | null`
- Consumes: existing `parseReleaseMedia(raw, mediaOrigin)` in the same file.

- [ ] **Step 1: Write the failing test**

Append to `workers/api/src/utils.test.ts`:

```ts
import { firstImageThumbnail } from "./utils.js";

describe("firstImageThumbnail", () => {
  const origin = "https://media.releases.sh";

  it("returns null for empty/null media", () => {
    expect(firstImageThumbnail(null, origin)).toBeNull();
    expect(firstImageThumbnail("[]", origin)).toBeNull();
  });

  it("picks the first image entry and prefers a plain url when no r2Key", () => {
    const raw = JSON.stringify([
      { type: "image", url: "https://cdn.example.com/a.png", alt: "Shot" },
    ]);
    expect(firstImageThumbnail(raw, origin)).toEqual({
      url: "https://cdn.example.com/a.png",
      alt: "Shot",
    });
  });

  it("picks a gif and omits alt when absent", () => {
    const raw = JSON.stringify([{ type: "gif", url: "https://cdn.example.com/a.gif" }]);
    expect(firstImageThumbnail(raw, origin)).toEqual({ url: "https://cdn.example.com/a.gif" });
  });

  it("skips video-only media", () => {
    const raw = JSON.stringify([{ type: "video", url: "https://x/poster.jpg" }]);
    expect(firstImageThumbnail(raw, origin)).toBeNull();
  });

  it("returns null on malformed json", () => {
    expect(firstImageThumbnail("{not json", origin)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/src/utils.test.ts`
Expected: FAIL — `firstImageThumbnail` is not exported from `./utils.js`.

- [ ] **Step 3: Add the function to `workers/api/src/utils.ts`**

Insert immediately after the `parseReleaseMedia` function (after ~line 88):

```ts
/**
 * Pick the first image-like media entry from a `releases.media` JSON blob and
 * reduce it to a display thumbnail. Returns null when the row has no usable
 * image/gif — compact card consumers then render a text-only row. Shared by the
 * related, coverage, and lookup surfaces so every rail derives thumbnails the
 * same way.
 */
export function firstImageThumbnail(
  raw: string | null,
  mediaOrigin: string,
): { url: string; alt?: string } | null {
  const media = parseReleaseMedia(raw, mediaOrigin);
  const first = media.find((m) => m.type === "image" || m.type === "gif");
  if (!first) return null;
  const url = first.r2Url ?? first.url;
  if (!url) return null;
  return first.alt ? { url, alt: first.alt } : { url };
}
```

- [ ] **Step 4: Refactor `related.ts` to import it**

In `workers/api/src/routes/related.ts`:
1. Delete the local `function firstImageThumbnail(...) { ... }` block (~lines 364-379, including its doc comment).
2. Add `firstImageThumbnail` to the existing import from `../utils.js` (find the line importing `parseReleaseMedia` from `../utils.js` and add `firstImageThumbnail` to the named imports; if `parseReleaseMedia` is no longer referenced directly in `related.ts` after the move, remove it from the import).

Verify no other references remain: `grep -n "parseReleaseMedia\|firstImageThumbnail" workers/api/src/routes/related.ts`.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test workers/api/src/utils.test.ts`
Expected: PASS.
Run: `cd workers/api && npx tsc --noEmit` (or from root: `bun run check`)
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/utils.ts workers/api/src/utils.test.ts workers/api/src/routes/related.ts
git commit -m "refactor(api): extract firstImageThumbnail into utils for reuse"
```

---

### Task 2: Add `thumbnail` wire fields to api-types + extend changeset

Additive optional `thumbnail` on the coverage sibling and the slim lookup release item, plus a shared schema.

**Files:**
- Modify: `packages/api-types/src/schemas/shared.ts` (add `ReleaseThumbnailSchema`)
- Modify: `packages/api-types/src/schemas/releases.ts:121-128` (`ReleaseCoverageSiblingSchema`)
- Modify: `packages/api-types/src/schemas/search.ts:202-207` (lookup release item)
- Modify: `.changeset/latest-feed-kind-group.md`

**Interfaces:**
- Produces: `ReleaseThumbnailSchema = z.object({ url: z.string(), alt: z.string().optional() })`; both consuming schemas gain `thumbnail: ReleaseThumbnailSchema.nullable().optional()`. The inferred `ReleaseCoverageSibling` and `LookupResultPayload["releases"][number]` types gain `thumbnail?: { url: string; alt?: string } | null`.

- [ ] **Step 1: Add the shared schema to `shared.ts`**

Append to `packages/api-types/src/schemas/shared.ts`:

```ts
/**
 * Display thumbnail derived server-side from a release's first image/gif media
 * entry. Shared by the coverage, lookup, and related-release payloads.
 */
export const ReleaseThumbnailSchema = z.object({
  url: z.string(),
  alt: z.string().optional(),
});
```

Ensure `shared.ts` imports zod (`import { z } from "zod";`) — add it if the file doesn't already.

- [ ] **Step 2: Add `thumbnail` to `ReleaseCoverageSiblingSchema`**

In `packages/api-types/src/schemas/releases.ts`, add the import at the top (next to other schema imports):

```ts
import { ReleaseThumbnailSchema } from "./shared.js";
```

Then extend the object (after the `org: ...` line, ~line 127):

```ts
  org: z.object({ slug: z.string(), name: z.string() }).nullable(),
  /** First image/gif thumbnail for the counterpart release; null when it has
   * none. Optional so an older server that omits it still validates. */
  thumbnail: ReleaseThumbnailSchema.nullable().optional(),
});
```

(If `shared.ts` already exports something `releases.ts` imports, add `ReleaseThumbnailSchema` to that existing import instead of a new line.)

- [ ] **Step 3: Add `thumbnail` to the lookup release item**

In `packages/api-types/src/schemas/search.ts`, ensure `ReleaseThumbnailSchema` is imported from `./shared.js` (add to the existing shared import or a new import line). Then extend the inline release object (lines 202-207):

```ts
        z.object({
          id: z.string(),
          version: z.string().nullable(),
          title: z.string(),
          publishedAt: z.string().nullable(),
          /** First image/gif thumbnail; null when the release has none. */
          thumbnail: ReleaseThumbnailSchema.nullable().optional(),
        }),
```

- [ ] **Step 4: Extend the pending changeset**

Edit `.changeset/latest-feed-kind-group.md`. Keep the frontmatter (`"@buildinternet/releases-api-types": minor`). Append a paragraph to the body:

```markdown

Also add an optional server-derived `thumbnail` (`{ url, alt? } | null`) to the coverage sibling shape (`ReleaseCoverageSiblingSchema`) and to each release item in the lookup payload (`LookupResultPayloadSchema.releases`), so compact release rails can render a visual aid. Additive and optional — older responses omit it.
```

- [ ] **Step 5: Typecheck + build api-types**

Run: `cd packages/api-types && bun run build` (or from root `bun run check`).
Expected: builds with no type errors; the new exports resolve.

- [ ] **Step 6: Commit**

```bash
git add packages/api-types/src/schemas/shared.ts packages/api-types/src/schemas/releases.ts packages/api-types/src/schemas/search.ts .changeset/latest-feed-kind-group.md
git commit -m "feat(api-types): add optional thumbnail to coverage sibling + lookup release items"
```

---

### Task 3: Derive `thumbnail` in the coverage endpoint

Fetch `media` in the sibling query and populate the new field.

**Files:**
- Modify: `workers/api/src/routes/releases.ts` (`fetchCoverageSiblings` ~400-438 + its two call sites ~352, ~365)
- Test: `workers/api/test/release-coverage.test.ts`

**Interfaces:**
- Consumes: `firstImageThumbnail` (Task 1), `ReleaseCoverageSibling` gaining `thumbnail` (Task 2).
- Produces: `fetchCoverageSiblings(db, ids, mediaOrigin)` — new third param.

- [ ] **Step 1: Write the failing test**

In `workers/api/test/release-coverage.test.ts`, in the `seed` function, add `media` JSON to one release row (the canonical `rel_canon` — it is the sibling surfaced on a `coverage`-role response). Set on the `rel_canon` values object:

```ts
      media: JSON.stringify([
        { type: "image", url: "https://cdn.example.com/launch.png", alt: "Launch hero" },
      ]),
```

Then add a test case (place near the existing coverage-role assertion):

```ts
it("surfaces the canonical sibling thumbnail from its first image media", async () => {
  const db = mkDb();
  await seed(db);
  const app = mkApp(db);
  // rel_cov_changelog is a coverage-side row whose canonical is rel_canon.
  const res = await app.request("/releases/rel_cov_changelog/coverage");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    role: string;
    canonical: { sibling: { thumbnail: { url: string; alt?: string } | null } | null };
  };
  expect(body.role).toBe("coverage");
  expect(body.canonical.sibling?.thumbnail).toEqual({
    url: "https://cdn.example.com/launch.png",
    alt: "Launch hero",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/release-coverage.test.ts`
Expected: FAIL — `thumbnail` is `undefined` (not yet derived).

- [ ] **Step 3: Add `media` to the query + thread `mediaOrigin`**

In `workers/api/src/routes/releases.ts`:

1. Import `firstImageThumbnail`: add it to the existing `../utils.js` import (alongside whatever's already imported from there; if nothing, add `import { firstImageThumbnail } from "../utils.js";`).

2. Change the `fetchCoverageSiblings` signature and select. Update the signature line (~400):

```ts
async function fetchCoverageSiblings(
  db: ReturnType<typeof createDb>,
  ids: string[],
  mediaOrigin: string,
): Promise<Map<string, ReleaseCoverageSibling>> {
```

3. Add `media` to the `.select({...})` (after `publishedAt: releases.publishedAt,`, ~line 412):

```ts
      publishedAt: releases.publishedAt,
      media: releases.media,
```

4. In the row-mapping loop (~427-436), add the derived thumbnail:

```ts
    map.set(r.id, {
      id: r.id,
      version: r.version,
      title: r.title,
      sourceName: r.sourceName,
      publishedAt: r.publishedAt,
      org: r.orgSlug && r.orgName ? { slug: r.orgSlug, name: r.orgName } : null,
      thumbnail: firstImageThumbnail(r.media, mediaOrigin),
    });
```

5. Update both call sites inside the `GET /releases/:id/coverage` handler to pass the origin. At ~line 352 and ~line 365, change `fetchCoverageSiblings(db, ...)` to include `c.env.MEDIA_ORIGIN ?? ""` as the third arg. Example:

```ts
const siblings = await fetchCoverageSiblings(db, [asCoverage.canonicalId], c.env.MEDIA_ORIGIN ?? "");
```
```ts
const siblings = await fetchCoverageSiblings(
  db,
  covers.map((r) => r.coverageId),
  c.env.MEDIA_ORIGIN ?? "",
);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test workers/api/test/release-coverage.test.ts`
Expected: PASS (new case + existing cases).
Run: `bun run check`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/releases.ts workers/api/test/release-coverage.test.ts
git commit -m "feat(api): derive coverage sibling thumbnail from release media"
```

---

### Task 4: Derive `thumbnail` in the lookup payload

`toLookupPayload` already has `r.media` on each full row; thread `mediaOrigin` and derive.

**Files:**
- Modify: `workers/api/src/routes/search.ts` (`toLookupPayload` ~145-173 + call site ~726; export the fn for testing)
- Test: `workers/api/test/lookup-payload.test.ts` (new)

**Interfaces:**
- Consumes: `firstImageThumbnail` (Task 1), lookup item schema gaining `thumbnail` (Task 2).
- Produces: `export function toLookupPayload(lookup, mediaOrigin): LookupResultPayload | null`.

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/lookup-payload.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { toLookupPayload } from "../src/routes/search.js";

describe("toLookupPayload thumbnail derivation", () => {
  const origin = "https://media.releases.sh";

  it("derives a thumbnail from a release's first image media", () => {
    const lookup = {
      status: "existing",
      source: null,
      relatedOrg: null,
      releases: [
        {
          id: "rel_1",
          version: "1.0.0",
          title: "Big launch",
          publishedAt: "2026-05-01T00:00:00.000Z",
          media: JSON.stringify([
            { type: "image", url: "https://cdn.example.com/a.png", alt: "Hero" },
          ]),
        },
      ],
    } as unknown as Parameters<typeof toLookupPayload>[0];

    const out = toLookupPayload(lookup, origin);
    expect(out?.releases?.[0]?.thumbnail).toEqual({
      url: "https://cdn.example.com/a.png",
      alt: "Hero",
    });
  });

  it("yields null thumbnail when the release has no image media", () => {
    const lookup = {
      status: "existing",
      source: null,
      relatedOrg: null,
      releases: [
        { id: "rel_2", version: null, title: "No media", publishedAt: null, media: "[]" },
      ],
    } as unknown as Parameters<typeof toLookupPayload>[0];

    expect(toLookupPayload(lookup, origin)?.releases?.[0]?.thumbnail).toBeNull();
  });

  it("returns null for a null lookup", () => {
    expect(toLookupPayload(null, origin)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/lookup-payload.test.ts`
Expected: FAIL — `toLookupPayload` is not exported / `thumbnail` undefined.

- [ ] **Step 3: Update `toLookupPayload` in `search.ts`**

1. Add `firstImageThumbnail` to the existing import from `../utils.js` in `search.ts`.
2. Export the function and add the `mediaOrigin` param. Change the declaration (~145):

```ts
export function toLookupPayload(
  lookup: Awaited<ReturnType<typeof runLookup>> | null,
  mediaOrigin: string,
): LookupResultPayload | null {
```

3. Add `thumbnail` to the release map (~164-169):

```ts
    releases: lookup.releases?.map((r) => ({
      id: r.id,
      version: r.version ?? null,
      title: r.title,
      publishedAt: r.publishedAt ?? null,
      thumbnail: firstImageThumbnail(r.media, mediaOrigin),
    })),
```

4. Update the call site (~726). `mediaOrigin` is already in scope in that handler (defined ~line 434). Change:

```ts
        lookup: toLookupPayload(lookup, mediaOrigin),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test workers/api/test/lookup-payload.test.ts`
Expected: PASS.
Run: `bun run check`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/search.ts workers/api/test/lookup-payload.test.ts
git commit -m "feat(api): derive lookup release thumbnails from media"
```

---

### Task 5: Web — `pickReleaseThumb` helper + shared `<ReleaseThumb>` component

The client-side derivation for GraphQL-fed surfaces (which carry raw `media[]`) plus one shared presentational component reused by every new render site.

**Files:**
- Modify: `web/src/lib/media.ts` (add `pickReleaseThumb`)
- Test: `web/src/lib/media.test.ts`
- Create: `web/src/components/release-thumb.tsx`
- Test: `web/src/components/release-thumb.test.tsx`

**Interfaces:**
- Produces:
  - `pickReleaseThumb(media): { url: string; alt: string } | null` where `media: Array<{ type: string; url: string; alt?: string | null; r2Url?: string | null }> | null | undefined`. URL is routed through the existing `releaseThumbUrl(src, 96)`.
  - `<ReleaseThumb src alt? size? />` — `size` is `"sm"` (32px) or `"md"` (40px, default). Renders an `<img>`; renders nothing when `src` is falsy.

- [ ] **Step 1: Write the failing helper test**

Append to `web/src/lib/media.test.ts`:

```ts
import { pickReleaseThumb } from "./media";

describe("pickReleaseThumb", () => {
  it("returns null for empty/nullish media", () => {
    expect(pickReleaseThumb(null)).toBeNull();
    expect(pickReleaseThumb(undefined)).toBeNull();
    expect(pickReleaseThumb([])).toBeNull();
  });

  it("picks the first image/gif and prefers r2Url", () => {
    const got = pickReleaseThumb([
      { type: "video", url: "https://x/poster.jpg" },
      { type: "image", url: "https://cdn/a.png", r2Url: "https://media.releases.sh/a.png", alt: "Shot" },
    ]);
    expect(got).toEqual({ url: "https://media.releases.sh/a.png", alt: "Shot" });
  });

  it("defaults alt to empty string", () => {
    expect(pickReleaseThumb([{ type: "gif", url: "https://cdn/a.gif" }])).toEqual({
      url: "https://cdn/a.gif",
      alt: "",
    });
  });

  it("skips video-only media", () => {
    expect(pickReleaseThumb([{ type: "video", url: "https://x/p.jpg" }])).toBeNull();
  });
});
```

(Note: `releaseThumbUrl` is a passthrough unless `NEXT_PUBLIC_RELEASES_IMG_TRANSFORM==="true"`, so the expected URLs equal the input `r2Url ?? url`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test web/src/lib/media.test.ts`
Expected: FAIL — `pickReleaseThumb` not exported.

- [ ] **Step 3: Implement `pickReleaseThumb`**

Append to `web/src/lib/media.ts`:

```ts
/**
 * Reduce a release's `media[]` to a single display thumbnail: the first
 * image/gif entry (`r2Url ?? url`), routed through {@link releaseThumbUrl} at a
 * compact width. Returns null when there is no usable image — compact card
 * consumers then render exactly as they do today (no placeholder). Mirrors the
 * server's `firstImageThumbnail` so every surface derives thumbnails the same
 * way.
 */
export function pickReleaseThumb(
  media:
    | Array<{ type: string; url: string; alt?: string | null; r2Url?: string | null }>
    | null
    | undefined,
): { url: string; alt: string } | null {
  const first = media?.find((m) => m.type === "image" || m.type === "gif");
  if (!first) return null;
  const src = first.r2Url ?? first.url;
  if (!src) return null;
  return { url: releaseThumbUrl(src, 96), alt: first.alt ?? "" };
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `bun test web/src/lib/media.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

Create `web/src/components/release-thumb.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseThumb } from "./release-thumb.tsx";

describe("ReleaseThumb", () => {
  it("renders an img with the src and alt", () => {
    const html = renderToStaticMarkup(<ReleaseThumb src="https://cdn/a.png" alt="Shot" />);
    expect(html).toContain('src="https://cdn/a.png"');
    expect(html).toContain('alt="Shot"');
  });

  it("renders nothing when src is empty", () => {
    expect(renderToStaticMarkup(<ReleaseThumb src="" alt="x" />)).toBe("");
  });

  it("applies the small size class when size=sm", () => {
    const html = renderToStaticMarkup(<ReleaseThumb src="https://cdn/a.png" size="sm" />);
    expect(html).toContain("w-8");
    expect(html).toContain("h-8");
  });
});
```

- [ ] **Step 6: Run the component test to verify it fails**

Run: `bun test web/src/components/release-thumb.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `ReleaseThumb`**

Create `web/src/components/release-thumb.tsx`:

```tsx
/**
 * Shared compact release-media thumbnail. One treatment reused across the home
 * ticker, org "latest releases" teaser, "also covered by" rail, and lookup
 * preview so every compact release surface reads as one system — matching the
 * related-rail card thumbnail. Renders nothing when `src` is falsy, so callers
 * pass a possibly-empty url without branching.
 */
export function ReleaseThumb({
  src,
  alt = "",
  size = "md",
}: {
  src: string | null | undefined;
  alt?: string;
  size?: "sm" | "md";
}) {
  if (!src) return null;
  const box = size === "sm" ? "w-8 h-8" : "w-10 h-10";
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={alt}
      className={`shrink-0 ${box} rounded-md object-cover bg-stone-100 dark:bg-stone-800`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}
```

- [ ] **Step 8: Run tests + typecheck**

Run: `bun test web/src/lib/media.test.ts web/src/components/release-thumb.test.tsx`
Expected: PASS.
Run: `bun run check`
Expected: no new errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/media.ts web/src/lib/media.test.ts web/src/components/release-thumb.tsx web/src/components/release-thumb.test.tsx
git commit -m "feat(web): add pickReleaseThumb helper and shared ReleaseThumb component"
```

---

### Task 6: Web — thumbnails on the RECENT ticker

Add `media` to the ticker query, regen types, render the thumb in the card.

**Files:**
- Modify: `web/src/lib/graphql/operations/homepage-ticker.graphql`
- Regenerate: `web/src/lib/graphql/__generated__/graphql.ts` (via codegen)
- Modify: `web/src/components/shipping-now-ticker.tsx`

**Interfaces:**
- Consumes: `pickReleaseThumb` + `<ReleaseThumb>` (Task 5). After codegen, `TickerRelease` gains `media: Array<{ type: MediaKind; url: string; alt: string | null; r2Url: string | null }>`.

- [ ] **Step 1: Add `media` to the query**

In `web/src/lib/graphql/operations/homepage-ticker.graphql`, add the `media` block inside `items` (after `titleShort`, before `source`):

```graphql
      titleShort
      media {
        type
        url
        alt
        r2Url
      }
      source {
```

- [ ] **Step 2: Regenerate GraphQL types**

Run: `cd web && bun run codegen` (the script that runs `web/codegen.ts`; if the script name differs, check `web/package.json` `scripts` for the codegen entry, e.g. `graphql-codegen`).
Expected: `web/src/lib/graphql/__generated__/graphql.ts` now includes `media` on the `HomepageTicker` `items` type. Verify: `grep -n "media" web/src/lib/graphql/__generated__/graphql.ts | grep -i ticker` context, or that `HomepageTickerQuery` items include `media`.

- [ ] **Step 3: Render the thumbnail in the card**

In `web/src/components/shipping-now-ticker.tsx`:

1. Add imports near the top:

```ts
import { pickReleaseThumb } from "@/lib/media";
import { ReleaseThumb } from "./release-thumb";
```

2. In `Card`, compute the thumb after the `video` line (~102):

```ts
  const video = videoRowInfoFromWire(release.source.video);
  const thumb = pickReleaseThumb(release.media);
```

3. Render it in the header row so it sits opposite the org avatar/label without disturbing the title/footer. Wrap the existing header `<div className="flex items-center gap-2 min-w-0"> ... </div>` (lines ~117-153) and the thumbnail as siblings under a flex row. Simplest: place `<ReleaseThumb>` as the trailing element of the header flex row, after the relative-time span (after the `{relative && (...)}` block, still inside the header `div`):

```tsx
        {relative && (
          <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500 whitespace-nowrap">
            {relative}
          </span>
        )}
        {thumb && <ReleaseThumb src={thumb.url} alt={thumb.alt} size="sm" />}
      </div>
```

(Using `size="sm"` keeps the header row height balanced; the card body/footer are unchanged, so no layout shift when `thumb` is null.)

- [ ] **Step 4: Typecheck + lint**

Run: `bun run check`
Expected: no new errors. (`release.media` now typed via codegen.)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/graphql/operations/homepage-ticker.graphql web/src/lib/graphql/__generated__/graphql.ts web/src/components/shipping-now-ticker.tsx
git commit -m "feat(web): show media thumbnail on home RECENT ticker cards"
```

---

### Task 7: Web — thumbnail on the org "Latest releases" teaser

The teaser's data (`OrgReleaseItem`) already carries `media`; just render it.

**Files:**
- Modify: `web/src/components/org/latest-releases-teaser.tsx`

**Interfaces:**
- Consumes: `pickReleaseThumb` + `<ReleaseThumb>` (Task 5). `OrgReleaseItem` (from `@buildinternet/releases-api-types`, mapped via `mapOrgReleaseItem`) carries `media: MediaItem[]`.

- [ ] **Step 1: Render the thumb in each teaser row**

In `web/src/components/org/latest-releases-teaser.tsx`:

1. Add imports:

```ts
import { pickReleaseThumb } from "@/lib/media";
import { ReleaseThumb } from "../release-thumb";
```

2. Inside the `items.map((r, i) => { ... })` body, derive the thumb before the `return`:

```ts
          const label = r.titleShort || r.title;
          const meta = [r.product?.name, r.version].filter(Boolean).join(" · ");
          const thumb = pickReleaseThumb(r.media);
```

3. Render it as the leading element of the row `<Link>` (before the `<div className="min-w-0 flex-1">`), so the row reads image → text → date → chevron:

```tsx
            <Link
              key={r.id ?? `${label}-${i}`}
              href={releasesHref}
              className="flex items-center gap-3.5 border-t border-[var(--line)] px-4 py-3.5 transition-colors first:border-t-0 hover:bg-[var(--surface-2)]"
            >
              {thumb && <ReleaseThumb src={thumb.url} alt={thumb.alt} size="sm" />}
              <div className="min-w-0 flex-1">
```

- [ ] **Step 2: Typecheck**

Run: `bun run check`
Expected: no new errors. If `OrgReleaseItem.media`'s element type is not directly assignable to `pickReleaseThumb`'s param, it is structurally compatible (`type: string; url: string; alt?; r2Url?`) — no cast needed. If a strict-mode mismatch appears, confirm `mapOrgReleaseItem` output shape and adjust the call, not the helper signature.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/org/latest-releases-teaser.tsx
git commit -m "feat(web): show media thumbnail on org latest-releases teaser"
```

---

### Task 8: Web — thumbnail on the "also covered by" rail

Render the server-derived `thumbnail` now present on `ReleaseCoverageSibling`.

**Files:**
- Modify: `web/src/components/also-covered-by.tsx`

**Interfaces:**
- Consumes: `<ReleaseThumb>` (Task 5); `ReleaseCoverageSibling.thumbnail` (Tasks 2-3).

- [ ] **Step 1: Render the thumb in `CoverageItem`**

In `web/src/components/also-covered-by.tsx`:

1. Add import:

```ts
import { ReleaseThumb } from "./release-thumb";
```

2. In `CoverageItem`, add the thumbnail as the leading element of `inner`, and switch the row alignment from `items-baseline` to `items-center` so the image aligns with the text. Update `inner`:

```tsx
  const inner = (
    <>
      {item.thumbnail && <ReleaseThumb src={item.thumbnail.url} alt={item.thumbnail.alt ?? ""} size="sm" />}
      <div className="min-w-0 flex-1 truncate">
        <span className="text-[14px] text-stone-900 dark:text-stone-100">{heading}</span>
        <span className="ml-2 text-[12px] text-stone-500 dark:text-stone-400">{byline}</span>
      </div>
      {item.publishedAt && (
        <span className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0 tabular-nums">
          {formatDate(item.publishedAt)}
        </span>
      )}
    </>
  );
```

3. Change both wrapper elements' `items-baseline` → `items-center` (the non-link `<div>` and the `<Link>`), keeping the rest of their classes:

```tsx
    return (
      <div className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2">{inner}</div>
    );
```
```tsx
    <Link
      href={`/release/${item.id}`}
      className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-stone-100 dark:hover:bg-stone-900 transition-colors"
    >
```

- [ ] **Step 2: Typecheck**

Run: `bun run check`
Expected: no new errors. `item.thumbnail` is typed (optional/nullable) via the api-types bump.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/also-covered-by.tsx
git commit -m "feat(web): show media thumbnail on also-covered-by rail"
```

---

### Task 9: Web — thumbnail on the lookup-rail preview

Render the server-derived `thumbnail` now on the lookup payload's release items.

**Files:**
- Modify: `web/src/components/lookup-rail.tsx` (`ReleasesPreview`, rows ~164-185)

**Interfaces:**
- Consumes: `<ReleaseThumb>` (Task 5); `LookupResultPayload["releases"][number].thumbnail` (Tasks 2, 4).

- [ ] **Step 1: Inspect the current row markup**

Run: `sed -n '146,198p' web/src/components/lookup-rail.tsx` to see the exact row layout (`ReleasesPreview`). The rows render `rel.id`, `rel.version`, `rel.title`, `rel.publishedAt`.

- [ ] **Step 2: Render the thumb**

In `web/src/components/lookup-rail.tsx`:

1. Add import:

```ts
import { ReleaseThumb } from "./release-thumb";
```

2. In `ReleasesPreview`'s per-release row (the `.map` over `releases`), add the thumbnail as the leading element of the row and ensure the row is a `flex items-center` with a gap. Insert at the start of the row's inner content:

```tsx
              {rel.thumbnail && <ReleaseThumb src={rel.thumbnail.url} alt={rel.thumbnail.alt ?? ""} size="sm" />}
```

If the existing row container is not already a horizontal flex row with vertical centering, wrap the text content so layout is `image → text (flex-1) → date`, mirroring the coverage rail: apply `flex items-center gap-3` to the row element and `min-w-0 flex-1` to the text block. Preserve all existing classes/hrefs; only add the flex/gap needed to seat the image.

- [ ] **Step 3: Typecheck**

Run: `bun run check`
Expected: no new errors. `rel.thumbnail` is typed via the api-types bump.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/lookup-rail.tsx
git commit -m "feat(web): show media thumbnail on lookup-rail release preview"
```

---

### Task 10: Full verification

Run the whole suite, lint/format/type, and drive the app to confirm real behavior.

- [ ] **Step 1: Full check + tests**

Run: `bun run check`
Expected: PASS (lint + format + type-check).
Run: `bun test workers/api/src/utils.test.ts workers/api/test/release-coverage.test.ts workers/api/test/lookup-payload.test.ts web/src/lib/media.test.ts web/src/components/release-thumb.test.tsx`
Expected: all PASS.
Run (isolation-sensitive suites, per AGENTS.md): `bun test` at repo root if practical, confirming no regressions.

- [ ] **Step 2: Drive the app (verify skill)**

Use the `verify`/`run` skill to launch the web app and confirm:
- Home page RECENT ticker: cards for releases with image/gif media show a small thumbnail; cards without media are unchanged (no empty box, no shift).
- An org overview page with recent media-bearing releases: teaser rows show thumbnails.
- A release-detail page that has a coverage cluster and/or related items: "also covered by" rows show thumbnails when the sibling has media.
- A repo-lookup / search surface that returns a lookup rail: recent/newly-indexed rows show thumbnails when present.

Capture a before/after screenshot of the ticker for the PR (per the github-screenshots convention).

- [ ] **Step 3: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to open the PR. PR body: summarize the surfaces touched, note the additive api-types `thumbnail` fields folded into the existing changeset, and embed the ticker screenshot. Do not request a CodeRabbit review by default (per repo policy) unless the reviewer asks.
```

