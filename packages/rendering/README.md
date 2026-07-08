# @releases/rendering

Atom feed helpers, markdown/JSON formatters, and media URL helpers.

## Exports

Imported as `@releases/rendering/<subpath>`.

| Subpath            | Purpose                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `atom`             | Atom 1.0 (RFC 4287) feed formatters built from the shared API response shapes.              |
| `atom-http`        | Runtime-agnostic HTTP helpers for Atom feeds (ETag, conditional requests, headers).         |
| `formatters`       | Agent-friendly markdown and JSON output formatters (CLI, MCP, web).                         |
| `markdown-plugins` | remark plugins for release content (GFM, gemoji, GitHub alerts, issue/PR refs).             |
| `media`            | `MediaRef` / upload-result types and media normalization re-exports for the R2 pipeline.    |
| `media-url`        | Portable media URL handling — hydrates stored `/_media/{r2Key}` refs to the current origin. |
| `media-filter`     | URL-based junk-media detection (avatar crops, gravatar thumbnails).                         |
| `video-embed`      | Inline hosted-video detection (Wistia/Loom/Vimeo/YouTube) + oEmbed poster resolution.       |
| `rewrite-links`    | Absolutizes vendor-relative URLs in ingested markdown against a base URL.                   |
| `slack-message`    | Slack incoming-webhook Block Kit formatter for release notifications.                       |

**Private, workspace-only — not published to npm.**
