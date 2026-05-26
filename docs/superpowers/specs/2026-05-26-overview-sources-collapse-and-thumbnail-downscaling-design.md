# 2026-05-26 — Overview Sources collapse + release-feed thumbnail downscaling

Two independent web-frontend polish items, shipped in one PR.

1. **Sources collapse** — the AI-overview "Sources" footer renders every citation
   as a full-width chip. With many long-titled citations it stacks into a tall
   list (the screenshot that prompted this had 14). Collapse to the first 6 with
   a "Show N more sources" toggle.
2. **Thumbnail downscaling** — release-feed thumbnails ship the full-resolution
   original and let the browser cram it into a 120×72 box. Heavy one-pass
   downscales of detailed screenshots alias ("jagged" thumbs). Serve a properly
   downscaled image via Cloudflare Image Transformations; keep the full version
   on click (already implemented).

---

## Feature 1 — Collapse long Sources list

### Where

`web/src/components/overview-view.tsx`, the `SourceChips` component. It renders
`RenderedCitation[]` as a `flex flex-wrap` of rounded-full anchor chips, each
`<a id="user-content-fn-${label}" href={sourceUrl}>`. The matching
`user-content-fn-${label}` ids are the jump targets for the in-body GFM footnote
superscripts (e.g. the `¹³` markers), so click-to-jump from a cited claim lands
on its chip.

### Behavior

- `COLLAPSE_THRESHOLD = 6`. Collapsing only engages when `items.length > 6`
  (i.e. 7+ sources); ≤6 renders exactly as today.
- When collapsible and collapsed: show the first 6 chips; the remaining chips
  stay **mounted** in the DOM but get a collapsed display class (Tailwind
  `hidden` = `display:none`, swapped for `inline-flex` when expanded) — not the
  `hidden` _attribute_, which loses to the `inline-flex` author class.
  `display:none` still removes them from layout and the a11y tree. A toggle
  button reads `Show {items.length - 6} more sources`.
- When expanded: all chips visible; toggle reads `Show fewer`.
- The toggle is its own line below the chip grid, styled like the existing body
  "Show more" affordance: `text-[12px] font-medium text-stone-500
hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200`. It is a
  real `<button type="button">` with `aria-expanded`.

### Anchor-jump correctness (the subtle part)

The screenshot shows citations past #6 (`¹³`, `¹⁴`) referenced in the body. A
naive "render only the first 6" collapse would break click-to-jump for those
hidden sources — the `#user-content-fn-<label>` target wouldn't exist, so the
browser scrolls nowhere.

Two-part fix, kept self-contained inside `SourceChips`:

1. **Keep all chips mounted.** Hide the tail by swapping its display class
   (`inline-flex` → `hidden`) rather than using the `hidden` attribute or
   conditional rendering, so every `id` is always present in the DOM.
2. **Auto-expand + scroll on jump.** A `useEffect` listens for `hashchange` and
   runs once on mount. When `location.hash` matches `#user-content-fn-<label>`
   for a label in the collapsed tail (`items.slice(6)`), it `setExpanded(true)`,
   then on the next animation frame calls
   `document.getElementById(hash)?.scrollIntoView({ block: "nearest" })` so the
   freshly-revealed chip is brought into view (the browser's own scroll already
   fired against a then-`display:none` element and gave up).

`SourceChips` becomes a stateful client component (it lives in an existing
`"use client"` module). No new dependencies. The markdown `section` override in
`OverviewView` that swaps the GFM footnotes block for `<SourceChips>` is
unchanged.

### Out of scope (YAGNI)

- Animated expand/collapse height transition — instant toggle is fine.
- Persisting expanded state across navigations.

---

## Feature 2 — Crisp downscaled release-feed thumbnails

### Root cause

`web/src/components/release-item.tsx` renders the feed thumbnail and
`MediaGallery` images through `FallbackImage` → `next/image`. For source hosts
not in the `isOptimizableImage()` allowlist (`web/src/lib/sanitize.ts`:
`githubusercontent.com`, `media.releases.sh`, `/v1/media/`, `github.com/*.png`),
it sets `unoptimized`, emitting a plain `<img>` with the **full-resolution
original** URL sized down by CSS (`object-cover w-[120px] h-[72px]`). Most
release media is third-party CDN URLs (no R2 copy yet — ingest-time R2 upload is
roadmap #1033), so they all fall through to full-res, and the big one-pass
downscale aliases.

### Existing infra we reuse

`packages/rendering/src/media-url.ts` already defines
`IMAGE_TRANSFORM = "cdn-cgi/image/width=1200,quality=80,format=auto"` and
`hydrateMediaUrls()` applies it to **content-body** images stored on our R2
origin (`MEDIA_ORIGIN = https://media.releases.sh`). Cloudflare Image
Transformations is confirmed live on that zone:

```text
GET https://media.releases.sh/cdn-cgi/image/width=240,quality=80,format=auto/orgs/github.png
→ 200 image/jpeg, 4 KB   (same-origin: works)
GET https://media.releases.sh/cdn-cgi/image/width=240,.../<external-url>
→ 403                     (cross-origin source: blocked today)
```

The `media[]` thumbnails deliberately skip the transform (`resolveR2Url` returns
plain URLs, comment: "gallery images go through next/image"). That's the gap.

### Prerequisite — owner action (Cloudflare dashboard)

Cross-origin transforms 403 today. **Path 2a (chosen):** enable transforming
images from other origins on the `media.releases.sh` zone:

> Cloudflare dashboard → the zone serving `media.releases.sh` →
> **Images → Transformations** → under **Sources / allowed origins**, allow the
> third-party origins (or "any origin"). After this, the
> `/cdn-cgi/image/<opts>/<absolute-source-url>` URL format resolves for remote
> sources.

This is the only out-of-repo step. Cost stays on the already-paid Cloudflare
account; CF lets you scope allowed origins to limit abuse.

### Code

**New pure helper** `cfImageUrl(src, { origin, width })` in
`packages/rendering/src/media-url.ts` — no env, no flag (the package is
runtime-neutral; the web caller owns origin + the flag, mirroring how
`hydrateMediaUrls` already takes `mediaOrigin`):

- Returns `${origin}/cdn-cgi/image/width=<W>,quality=80,format=auto/<src>` for an
  absolute http(s) raster image (`IMAGE_EXTENSIONS`: png/jpe?g/gif/webp/avif).
- Returns `src` unchanged when: `src` is not an absolute http(s) URL; `src` is
  not a raster image (e.g. SVG, video poster); or `src` already contains
  `/cdn-cgi/image/` (no double-wrap).
- Width-only transform: CF scales preserving aspect ratio; the existing CSS
  `object-cover` on the 120×72 box does the crop. No `height`/`fit` needed.

**Web-side gate + origin.** A small web wrapper (in `web/src/lib/`, e.g.
`releaseThumbUrl(src, width)`) reads the build-time flag
`NEXT_PUBLIC_RELEASES_IMG_TRANSFORM` (default **off**) and the media origin
constant (`https://media.releases.sh`). When the flag is off it returns `src`
unchanged → today's behavior (jagged but never broken); when on it delegates to
`cfImageUrl`. Activation is two ordered steps: (1) owner enables cross-origin
transforms in CF, (2) flip the flag. This avoids a window where the flag is on
but CF still 403s — which would otherwise trip `FallbackImage`'s `onError` and
replace thumbs with the "Image unavailable" placeholder (a worse regression than
the jagged thumb).

**Wiring in `web/src/components/release-item.tsx`:**

- Feed thumbnail (120×72 display) → `cfImageUrl(src, { width: 240 })` (covers 2×
  DPR). Render as `unoptimized` so Vercel's optimizer doesn't re-process an
  already-CF-optimized image (`media.releases.sh` is in `remotePatterns`, so
  without `unoptimized` next/image would double-optimize and re-incur Vercel
  image billing).
- `MediaGallery` images (max-h-48 ≈ 400px display) → `cfImageUrl(src, { width:
800 })`, likewise `unoptimized`.
- **Lightbox unchanged** — keeps the full original `src`. "Show full version on
  click/expand" already works (both the thumbnail button and gallery buttons
  open the `Lightbox`).
- `FallbackImage` gains a way to force `unoptimized` (a prop) for the
  CF-transform path; its existing `onError` → placeholder stays as the safety
  net.

### Out of scope (YAGNI)

- Ingest-time R2 upload of release media (roadmap #1033) — orthogonal; this is a
  read-time render fix.
- CF `fit=cover`/height transforms — width-only + CSS crop is sufficient.
- Signed/SSRF-guarded worker proxy (the 2b alternative) — not chosen.

---

## Files touched

- `packages/rendering/src/media-url.ts` — add pure `cfImageUrl`; add unit tests
  in `media-url.test.ts` (passthrough cases: relative URL, SVG, already
  transformed; transform case: absolute raster URL → expected `/cdn-cgi/image/`
  URL).
- `web/src/lib/` — small `releaseThumbUrl(src, width)` wrapper (flag + origin).
- `web/src/components/overview-view.tsx` — `SourceChips` collapse + anchor-jump
  effect.
- `web/src/components/release-item.tsx` — thumbnail + gallery use `cfImageUrl`.
- `web/src/components/fallback-image.tsx` — optional `unoptimized` prop.
- `web/.env.example` (+ doc) — `NEXT_PUBLIC_RELEASES_IMG_TRANSFORM`. (Owner sets
  the real Vercel env value; per project rule we do not edit `.env` directly.)

## Testing

- `bun test` for the `media-url` helper unit tests.
- `npx tsc --noEmit` (root + web).
- Manual: overview page with 7+ sources collapses to 6 + toggle; clicking a
  body superscript for a hidden source expands and scrolls to its chip. Feed
  thumbnails render crisp once flag + CF setting are on; with the flag off,
  behavior is identical to today.

## Verification gate (before claiming done)

- Helper unit tests pass; tsc clean.
- With flag **off**, a local overview page and feed render exactly as on `main`
  (no thumbnail regression, no broken images).
- Sources collapse + expand-on-jump verified in the browser.
