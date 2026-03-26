# Agent SDK Changelog Ingestion

## Context

Released currently ingests changelogs from non-GitHub sources using a multi-step pipeline:

1. **Cloudflare Browser Rendering** renders the page to markdown
2. **AI parsing** (`src/ai/ingest.ts`) extracts structured releases from the markdown
3. **The scrape adapter** (`src/adapters/scrape.ts`) assigns URLs and maps to `RawRelease[]`

This pipeline has known limitations:
- Individual entry URLs are lost (all releases get the source URL or synthetic fragments)
- Cloudflare's crawl API is unreliable for some sites (e.g., Resend — only returned the index page)
- The rendering and parsing steps are separated, losing page context (links, structure) between them
- Quality varies between runs (AI found 5 entries one run, 72 the next from the same page)

**Proven alternative:** A simple WebFetch + AI extraction in a single pass successfully extracted 68 entries from Resend's changelog with real URLs, dates, and summaries — using a small/fast model. This worked better than the entire Cloudflare + AI pipeline.

## Goal

Add a new `agent` adapter type alongside the existing `scrape` adapter (don't remove `scrape`). The agent adapter uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) to create a specialized changelog-fetching agent that can:

1. Fetch and read a changelog page
2. Extract structured release data (title, date, content, URL) in one pass
3. Adaptively handle different changelog formats (single-page, blog-index, paginated)
4. Follow individual entry links when needed for full content
5. Use sitemap data when available to discover the full set of entry URLs

## Architecture

### New adapter: `src/adapters/agent.ts`

Uses the Claude Agent SDK's `query()` function with:
- **Tools:** `WebFetch`, `WebSearch` (for sitemap discovery)
- **Model:** Haiku-class (proven sufficient for extraction)
- **System prompt:** Structured extraction instructions with output schema
- **Permission mode:** Read-only (no file writes, no bash)

### Flow

```
source.url
    │
    ▼
Agent receives prompt:
"Extract all changelog entries from {url}.
 For each: title, date, individual URL, summary, full content.
 If entries link to individual pages, extract the real URLs.
 If a sitemap is available at the domain, check it for additional entry URLs."
    │
    ▼
Agent uses WebFetch to read the page
    │
    ▼
Agent extracts structured JSON
(titles, dates, real URLs, summaries)
    │
    ▼
RawRelease[] returned to fetch command
```

### Integration points

- **`src/adapters/agent.ts`** — New adapter implementing the `Adapter` interface
- **`src/adapters/types.ts`** — Add `"agent"` to the source type union (if needed, or reuse `scrape` with a metadata flag)
- **`src/cli/commands/add.ts`** — Auto-detection during add: when blog-index pattern is detected, could default to agent adapter instead of scrape
- **`src/cli/commands/fetch.ts`** — No changes needed if adapter interface is followed
- **Source metadata** — Store `adapterPreference: "agent" | "scrape"` so users can override

### Agent SDK setup

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = `Extract all changelog entries from ${source.url}.

For each entry return a JSON object with:
- title: the entry title
- date: publication date in ISO 8601 format (or null)
- url: the real URL to the individual entry page (not the index page)
- summary: 1-2 sentence summary
- content: the full entry content as markdown

Return a JSON array of entries, newest first.

If the page is a blog-index linking to individual entry pages, extract the real URLs.
If a sitemap exists at the domain root, check it for additional changelog entry URLs
that may not be linked from the index page.`;

const messages = [];
for await (const message of query({
  prompt,
  options: {
    allowedTools: ["WebFetch", "WebSearch"],
    model: "haiku",  // or configured via RELEASED_INGEST_MODEL
    permissionMode: "default",
  },
})) {
  messages.push(message);
}
// Parse the final result message for the JSON array
```

### Key considerations

- **Cost:** Haiku-class model keeps per-fetch cost low. WebFetch is a single HTTP call, not Cloudflare rendering.
- **Reliability:** Single-pass extraction avoids the two-step render → parse pipeline where context is lost.
- **Sitemap integration:** The agent can check `/sitemap.xml` or `/sitemap_index.xml` to discover entry URLs that aren't linked from the index page. This is especially useful for large changelogs where the index only shows recent entries.
- **Backwards compatibility:** Existing `scrape` adapter stays as-is. The `agent` adapter is additive.
- **Token tracking:** Agent SDK queries should be logged to the existing `usageLog` table.

### What NOT to change

- Don't remove the `scrape` adapter or `feed` adapter
- Don't change the `github` adapter
- Don't change the database schema (the existing `releases` table structure works fine)
- Don't change the fetch command's insert/dedup logic

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — new dependency
- `ANTHROPIC_API_KEY` — already required for existing AI features

## Reference

- Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript SDK: `@anthropic-ai/claude-agent-sdk`
- Built-in tools available: WebFetch, WebSearch, Read, Glob, Grep, etc.
- Current adapters: `src/adapters/github.ts`, `src/adapters/feed.ts`, `src/adapters/scrape.ts`
- Adapter interface: `src/adapters/types.ts`
- AI ingest (current): `src/ai/ingest.ts`
- Existing source metadata pattern: `src/adapters/feed.ts` (`getSourceMeta`, `updateSourceMeta`)
