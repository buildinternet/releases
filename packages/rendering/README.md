# @releases/rendering

Atom feed helpers, markdown/JSON formatters, and media URL helpers.

## Exports

- `@releases/rendering/atom` — Atom 1.0 (RFC 4287) feed formatters built from the shared API response shapes.
- `@releases/rendering/atom-http` — runtime-agnostic HTTP response helpers for Atom feeds (ETag generation, conditional-request matching, header formatting).
- `@releases/rendering/formatters` — agent-friendly markdown and JSON output formatters shared by the CLI, MCP server, and web frontend.
- `@releases/rendering/markdown-plugins` — remark plugins for release content (GFM, gemoji, GitHub alerts, GitHub issue/PR reference resolution).
- `@releases/rendering/media` — `MediaRef`/upload-result types and media normalization re-exports used by the ingest R2 pipeline.
- `@releases/rendering/media-url` — portable media URL handling: hydrates stored `/_media/{r2Key}` references to the current media origin, with Cloudflare Image Transformation params.
- `@releases/rendering/media-filter` — URL-based junk-media detection (avatar crops, gravatar thumbnails) shared by ingest and the Open Graph hero-image picker.
- `@releases/rendering/video-embed` — inline hosted-video detection (Wistia/Loom/Vimeo/YouTube) and oEmbed poster resolution for release bodies.
- `@releases/rendering/rewrite-links` — absolutizes vendor-relative URLs in ingested markdown against a base URL.
- `@releases/rendering/slack-message` — Slack incoming-webhook Block Kit formatter for release notifications.

**Private, workspace-only — imported via `@releases/rendering`, not published to npm.**
