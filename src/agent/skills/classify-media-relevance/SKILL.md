---
name: classify-media-relevance
description: Decide whether an image or video found on a release page is editorial content (screenshots, demos, diagrams, product shots) or site chrome (avatars, logos, tracking pixels, decorative badges). Used during parsing to populate a release's media array.
---

# Classifying Media Relevance

Release pages contain two kinds of media: **editorial content** that belongs in the release (screenshots of the feature, demo videos, diagrams explaining a change) and **site chrome** that doesn't (author avatars, nav logos, tracking pixels, decorative separators). This skill governs which items end up in a release's `media[]` array.

The goal is precision-over-recall: a dropped editorial image is recoverable (users click through to the source page), but a kept junk image pollutes the UI and wastes storage.

## When this runs

- During the parse pipeline, after the AI extracts release content from a fetched page.
- During crawl-mode fetches, when the extractor reads full-page markdown from a linked article and produces a fresh `media[]`.
- Not during feed fetches where the feed already scoped media to per-entry content (trust the feed).

## Cheap pre-checks (keep in code, don't spend AI tokens)

These checks are deterministic, free, and catch the overwhelming majority of obvious junk. Always run them **before** invoking this skill. If a pre-check drops an item, no AI call is needed.

1. **Tracking domains** — URL host matches a known tracking/analytics domain (`px.ads.linkedin.com`, `t.co`, `www.facebook.com/tr`, `analytics.twitter.com`, `bat.bing.com`). Drop with reason `tracking domain: <host>`.
2. **Unsupported content-type** — after HEAD/GET, content-type isn't in the uploadable set (`image/png|jpeg|gif|webp|svg+xml|avif`, `video/mp4|webm`). Drop with reason `unsupported type`.
3. **Size bounds** — body < 5 KB (tracking pixels, spacers) or > 10 MB (won't upload anyway). Drop.
4. **Streaming embeds** — YouTube, Vimeo, Loom URLs are kept as `type: "video"` references without downloading. Never route through R2 upload or this skill.
5. **ETag / content hash seen before** — if the R2 key derived from content hash already exists, reuse it and skip reclassification.

Everything else — the ambiguous middle where URL patterns overlap between chrome and content — goes through the skill.

## Heuristic nudges (optional, low-confidence)

The old code treated path substrings like `/avatar`, `/logo`, `/icon`, `/badge`, `/favicon`, `1x1` as hard drops. That was wrong often enough to matter: a post titled "New icon set" shipped images under `/icons/` that were the actual product. **Do not hard-drop on path substrings.** Pass them through as weak negative signals and let the classifier weigh them against context.

The one exception: `/favicon.ico` and exact `/favicon*` at the site root are always chrome. Keep that single check in code.

## Classification rules

For each remaining media item, decide **keep** or **drop** based on these signals, in rough order of importance:

**Strong keep signals**
- Image or video appears in the middle of release body content (not header/footer of the page).
- Alt text describes a feature, UI state, code, or demo ("New dashboard showing filters", "Architecture diagram", "CLI output").
- Filename suggests editorial content (`screenshot-*`, `demo-*`, `feature-*`, `*-hero.png`, version numbers in name).
- Dimensions consistent with screenshots/diagrams (wider than 400px, aspect ratio not 1:1 perfect square).
- Hosted on the org's CDN *under a posts/releases/blog path* (e.g., `cdn.example.com/posts/2026/new-thing.png`).

**Strong drop signals**
- Alt text is a person's name, a company name alone, or empty and the URL contains `avatar|profile|author|contributor`.
- Filename is generic site chrome (`logo.svg`, `wordmark.png`, `header-bg.jpg`, `footer-icon.svg`).
- Perfect 1:1 square under 200×200 with no contextual link to release content (likely avatar/badge).
- URL path includes `/wp-content/plugins/` or `/_next/static/media/` with no posts path — usually framework chrome.
- Appears in every release on the source (detectable by callers passing a frequency hint) — site-wide chrome bleeding into parses.

**Weak / context-dependent**
- `/icon`, `/icons/` paths — only chrome if the release isn't about icons; keep if the release announces icon/design updates.
- `/badge`, `/badges/` — drop if it's a shields.io CI badge, keep if the release is about achievements/credentials.
- SVGs at the top of the page — usually logos, but can be diagrams. Use surrounding alt text and position.

## Output format

Return a JSON array, one entry per input item, in the same order:

```json
[
  { "url": "https://...", "decision": "keep", "confidence": "high", "reason": "screenshot of new dashboard, alt text describes feature" },
  { "url": "https://...", "decision": "drop", "confidence": "high", "reason": "author avatar, 80x80 square at top of post" }
]
```

`confidence` is `high` when signals align, `low` when it's a judgment call. Callers treat `low` drops conservatively — they may keep low-confidence drops on high-value sources.

## Anti-patterns

- **Don't** build a new substring blocklist inside the skill — that's what we're replacing.
- **Don't** drop based on URL alone without considering alt text, position, and release context.
- **Don't** request the image bytes to classify — work from URL + alt + surrounding content only. The byte-level decisions happen in the cheap pre-checks.
- **Don't** keep "just in case" — over-keeping pollutes the grid view more than under-keeping hurts individual releases.
