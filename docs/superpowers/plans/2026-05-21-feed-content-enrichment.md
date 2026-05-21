# Feed Content Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `type: feed` source ships summary-only items, follow each new item's link, fetch the real article, and store it as the release `content` — fixing thin one-liner releases like Webflow's.

**Architecture:** Detection (`assessFeedDepth`) auto-flags a feed `summary-only` and persists `metadata.feedContentDepth`. A worker orchestrator (`enrichFeedItem`) does a cheap `fetch()` → `htmlToMarkdown()` → single-article AI cleanup (`extractArticle`), escalating to Cloudflare Browser Rendering only when still thin. Forward enrichment runs inline in `fetchOne` before insert; an admin endpoint backfills already-thin rows. Gated off behind `FEED_ENRICH_ENABLED`.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle/D1, Anthropic SDK (`@anthropic-ai/sdk`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-21-feed-content-enrichment-design.md`

---

## File Structure

**Create:**

- `packages/adapters/src/feed-depth.ts` — pure detection (`isThinItem`, `assessFeedDepth`, `DEFAULT_FEED_THIN_CHARS`).
- `packages/ai/src/article-extract.ts` — `extractArticle()` single-article AI cleanup.
- `workers/api/src/cron/feed-enrich.ts` — `enrichFeedItem()` orchestrator + `enrichNewThinItems()` (the `fetchOne` integration helper) + `EnrichmentMarker` type.
- Tests: `tests/unit/feed-depth.test.ts`, `tests/unit/article-extract.test.ts`, `tests/unit/feed-enrich.test.ts`, `tests/unit/feed-enrich-backfill.test.ts`.

**Modify:**

- `packages/adapters/src/types.ts` — add `contentFromSummary?` to `RawRelease`.
- `packages/adapters/src/feed.ts` — set `contentFromSummary` in `parseRss`/`parseJsonFeed`.
- `packages/adapters/package.json` — export `./feed-depth`.
- `packages/ai/package.json` — export `./article-extract`.
- `workers/api/src/cron/poll-fetch.ts` — `FetchOneEnv` (CF creds + FEED*ENRICH*\* envs), persist detection flag, run forward enrichment, apply enriched content/media/metadata in row mapping.
- `workers/api/src/routes/workflows.ts` — `POST /v1/workflows/enrich-feed-content` (registered on the sub-app as `/workflows/enrich-feed-content`; the `/v1` prefix comes from mounting).
- `workers/api/wrangler.jsonc` — bind `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (prod + staging).
- `.env.example`, `AGENTS.md` — document the feature.

---

## Task 1: `RawRelease.contentFromSummary` + parser wiring

Detection must distinguish "real body" from "the teaser repeated as content." The feed parser maps `content:encoded`/`content_html` first, falling back to `description`/`summary`. Record which happened.

**Files:**

- Modify: `packages/adapters/src/types.ts`
- Modify: `packages/adapters/src/feed.ts` (`parseRss` ~492-513, `parseJsonFeed` ~538-568)
- Test: `tests/unit/feed-parsers.test.ts` (existing)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/feed-parsers.test.ts`:

```ts
describe("contentFromSummary flag", () => {
  it("marks RSS items that fall back to <description>", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Has body</title><link>https://x.test/a</link>
        <content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/"><![CDATA[<p>Full body paragraph here.</p>]]></content:encoded>
        <description>teaser</description></item>
      <item><title>Summary only</title><link>https://x.test/b</link>
        <description>just a teaser sentence</description></item>
    </channel></rss>`;
    const [withBody, summaryOnly] = parseRss(xml);
    expect(withBody.contentFromSummary).toBe(false);
    expect(summaryOnly.contentFromSummary).toBe(true);
  });

  it("marks JSON Feed items that fall back to summary", () => {
    const json = JSON.stringify({
      items: [
        {
          title: "Has body",
          url: "https://x.test/a",
          content_html: "<p>Full body here.</p>",
          summary: "teaser",
        },
        { title: "Summary only", url: "https://x.test/b", summary: "just a teaser" },
      ],
    });
    const [withBody, summaryOnly] = parseJsonFeed(json);
    expect(withBody.contentFromSummary).toBe(false);
    expect(summaryOnly.contentFromSummary).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/feed-parsers.test.ts -t "contentFromSummary"`
Expected: FAIL — `contentFromSummary` is `undefined`.

- [ ] **Step 3: Add the field to `RawRelease`**

In `packages/adapters/src/types.ts`, inside `interface RawRelease`, after `categories?`:

```ts
  /**
   * True when `content` was derived from the item's short `<description>` /
   * JSON-feed `summary` because no distinct `content:encoded` / `content_html`
   * body was present. Drives summary-only feed detection (`assessFeedDepth`).
   * Transient — never persisted on the release row.
   */
  contentFromSummary?: boolean;
```

- [ ] **Step 4: Set it in `parseRss`**

In `packages/adapters/src/feed.ts`, `parseRss`, change the body line and the pushed object:

```ts
const hasDistinctBody = Boolean(item.content && item.content.trim().length > 0);
const body = item.content ?? item.description ?? "";
// ... existing dateRaw / categories ...
releases.push({
  title: item.title,
  content: htmlToMarkdown(body),
  contentFromSummary: !hasDistinctBody,
  url: feedItemUrl(item),
  // ... rest unchanged ...
});
```

- [ ] **Step 5: Set it in `parseJsonFeed`**

In `parseJsonFeed`, inside the `.map(...)`:

```ts
const hasDistinctBody = Boolean(item.content_html && item.content_html.trim().length > 0);
const html = item.content_html ?? item.summary ?? "";
// ... existing ...
return {
  title: item.title!,
  content: item.content_text ?? htmlToMarkdown(html),
  contentFromSummary: !hasDistinctBody && !item.content_text,
  url: item.url,
  // ... rest unchanged ...
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/feed-parsers.test.ts`
Expected: PASS (including the new cases, no regressions).

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/types.ts packages/adapters/src/feed.ts tests/unit/feed-parsers.test.ts
git commit -m "feat(adapters): flag feed items whose content fell back to the summary"
```

---

## Task 2: `feed-depth.ts` detection helpers

**Files:**

- Create: `packages/adapters/src/feed-depth.ts`
- Modify: `packages/adapters/package.json` (exports)
- Test: `tests/unit/feed-depth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/feed-depth.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import {
  isThinItem,
  assessFeedDepth,
  DEFAULT_FEED_THIN_CHARS,
} from "@releases/adapters/feed-depth";
import type { RawRelease } from "@releases/adapters/types";

function item(partial: Partial<RawRelease>): RawRelease {
  return { title: "t", content: "", isBreaking: false, ...partial };
}

const opts = { thinChars: DEFAULT_FEED_THIN_CHARS };

describe("isThinItem", () => {
  it("is thin when content is empty", () => {
    expect(isThinItem(item({ content: "   " }), opts)).toBe(true);
  });
  it("is thin when content fell back to the summary", () => {
    expect(isThinItem(item({ content: "x".repeat(2000), contentFromSummary: true }), opts)).toBe(
      true,
    );
  });
  it("is thin when content is below the char floor", () => {
    expect(isThinItem(item({ content: "short body" }), opts)).toBe(true);
  });
  it("is not thin with a long distinct body", () => {
    expect(isThinItem(item({ content: "x".repeat(2000), contentFromSummary: false }), opts)).toBe(
      false,
    );
  });
});

describe("assessFeedDepth", () => {
  const thin = item({ content: "teaser", contentFromSummary: true });
  const full = item({ content: "x".repeat(2000), contentFromSummary: false });

  it("returns null below the minimum batch size", () => {
    expect(assessFeedDepth([thin, thin], opts)).toBeNull();
  });
  it("returns summary-only when >=60% are thin", () => {
    expect(assessFeedDepth([thin, thin, full], opts)).toBe("summary-only");
  });
  it("returns full when most items carry bodies", () => {
    expect(assessFeedDepth([full, full, thin], opts)).toBe("full");
  });
  it("returns full when any item has a distinct body and thin ratio is under threshold", () => {
    expect(assessFeedDepth([full, full, full], opts)).toBe("full");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/feed-depth.test.ts`
Expected: FAIL — module `@releases/adapters/feed-depth` not found.

- [ ] **Step 3: Create the module**

Create `packages/adapters/src/feed-depth.ts`:

```ts
/**
 * Summary-only feed detection. A "thin" item carries no real body beyond its
 * own teaser; a feed is "summary-only" when a strong majority of a batch is
 * thin. Pure and side-effect-free so the decision matrix is unit-testable.
 */
import type { RawRelease } from "./types.js";

/** Below this many characters, an item's content is treated as a teaser. */
export const DEFAULT_FEED_THIN_CHARS = 600;

/** Minimum batch size before we trust a summary-only verdict. */
export const MIN_BATCH_FOR_ASSESSMENT = 3;

/** Fraction of thin items that flips a batch to "summary-only". */
export const SUMMARY_ONLY_THIN_RATIO = 0.6;

export interface ThinOpts {
  thinChars: number;
}

export function isThinItem(raw: RawRelease, opts: ThinOpts): boolean {
  const content = (raw.content ?? "").trim();
  if (content.length === 0) return true;
  if (raw.contentFromSummary === true) return true;
  return content.length < opts.thinChars;
}

/**
 * Verdict for a parsed batch. `null` means "not enough signal" — too few items
 * to trust, so callers must not flip the persisted flag.
 */
export function assessFeedDepth(
  items: readonly RawRelease[],
  opts: ThinOpts,
): "full" | "summary-only" | null {
  if (items.length < MIN_BATCH_FOR_ASSESSMENT) return null;
  const thinCount = items.filter((it) => isThinItem(it, opts)).length;
  return thinCount / items.length >= SUMMARY_ONLY_THIN_RATIO ? "summary-only" : "full";
}
```

- [ ] **Step 4: Add the export**

In `packages/adapters/package.json`, add to the `exports` map (after `"./feed"`):

```json
    "./feed-depth": "./src/feed-depth.ts",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/feed-depth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/feed-depth.ts packages/adapters/package.json tests/unit/feed-depth.test.ts
git commit -m "feat(adapters): summary-only feed detection helpers"
```

---

## Task 3: `extractArticle` single-article AI cleanup

Mirrors `marketing-classifier.ts` (caller passes the Anthropic client; worker-safe; tagged output parsed via `extractTagged`).

**Files:**

- Create: `packages/ai/src/article-extract.ts`
- Modify: `packages/ai/package.json` (exports)
- Test: `tests/unit/article-extract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/article-extract.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { extractArticle } from "@releases/ai-internal/article-extract";

function fakeClient(text: string): Anthropic {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

describe("extractArticle", () => {
  it("returns the verbatim body inside <article> and reports usage", async () => {
    const client = fakeClient(
      "<article>## Heading\n\nFull paragraph one.\n\nFull paragraph two.</article>",
    );
    const { content, usage } = await extractArticle(client, {
      markdown: "nav junk\n## Heading\n\nFull paragraph one.\n\nFull paragraph two.\nfooter",
      title: "Heading",
      model: "claude-haiku-4-5",
    });
    expect(content).toContain("Full paragraph one.");
    expect(content).toContain("Full paragraph two.");
    expect(content).not.toContain("nav junk");
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
  });

  it("returns empty content when the model emits no <article>", async () => {
    const client = fakeClient("sorry, no content");
    const { content } = await extractArticle(client, {
      markdown: "x",
      title: "t",
      model: "claude-haiku-4-5",
    });
    expect(content).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/article-extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `packages/ai/src/article-extract.ts`:

```ts
/**
 * Single-article extraction — turn the markdown of one web page into the clean,
 * verbatim main article body, dropping nav / sidebars / footers / "more posts"
 * lists. Used by feed enrichment when a summary-only feed item's full content
 * lives at its link. Worker-safe: caller constructs the Anthropic client.
 *
 * Deliberately NOT the multi-entry extractor (`@releases/adapters/extract`) —
 * this is one known article, so a single one-shot text call with a verbatim
 * (extract-not-rewrite) instruction is cheaper and higher-fidelity.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { extractTagged } from "./release-content";

export const MODEL = "claude-haiku-4-5";

/** Cap on page markdown sent to the model. Article pages are small; this guards
 *  against the occasional page that inlines a huge nav tree or comment thread. */
export const MAX_INPUT_CHARS = 60_000;

/** Articles rarely exceed a few thousand tokens of clean body. */
export const MAX_OUTPUT_TOKENS = 4000;

export interface ArticleExtractUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export const SYSTEM_PROMPT = `You extract the main article body from the markdown of a single web page.

The page is one changelog / release-note / product-update article. Its markdown also contains page chrome: top nav, breadcrumbs, sidebars, cookie banners, newsletter sign-ups, footers, and lists of OTHER articles ("more updates", "related posts"). Your job is to return ONLY the body of the one article named by the title.

<rules>
- Output the article body VERBATIM as markdown. Do NOT summarize, paraphrase, translate, or reorder. Preserve headings, lists, code blocks, and inline links exactly.
- Drop all page chrome and any list of other articles. If a "more updates" list would pull in other releases' text, exclude it.
- Keep images that are part of the article body (markdown image syntax).
- If the page has no recognizable article body (e.g. it's a JS shell or an index page), output an empty <article></article>.
</rules>

<output_structure>
Output exactly:

<article>
...the article body as verbatim markdown...
</article>

Output nothing else — no preamble, no explanation, no other tags.
</output_structure>`;

export function buildArticleInput(args: { markdown: string; title: string }): string {
  const md =
    args.markdown.length > MAX_INPUT_CHARS
      ? args.markdown.slice(0, MAX_INPUT_CHARS) + "\n\n[truncated]"
      : args.markdown;
  return `Article title: ${args.title}\n\nPage markdown:\n${md}`;
}

export async function extractArticle(
  client: Anthropic,
  args: { markdown: string; title: string; model?: string },
): Promise<{ content: string; usage: ArticleExtractUsage }> {
  const res = await client.messages.create({
    model: args.model ?? MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: buildArticleInput({ markdown: args.markdown, title: args.title }) },
    ],
  });

  const raw = res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  let content = "";
  try {
    content = extractTagged(raw, "article").trim();
  } catch {
    content = "";
  }

  return {
    content,
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheCreate: res.usage.cache_creation_input_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
  };
}
```

> **Note on `extractTagged`:** confirm it returns `""` (or throws, which we catch) when the tag is absent. If it throws on a missing tag, the `try/catch` above already handles it — the test "returns empty content when the model emits no `<article>`" is the gate.

- [ ] **Step 4: Add the export**

In `packages/ai/package.json`, add to `exports` (after `"./marketing-classifier"`):

```json
    "./article-extract": "./src/article-extract.ts",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/article-extract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/article-extract.ts packages/ai/package.json tests/unit/article-extract.test.ts
git commit -m "feat(ai): single-article verbatim extraction for feed enrichment"
```

---

## Task 4: `enrichFeedItem` orchestrator

Fully injectable so it unit-tests without network/AI: `fetchImpl`, `extractArticleFn`, and `renderFn` are all parameters.

**Files:**

- Create: `workers/api/src/cron/feed-enrich.ts`
- Test: `tests/unit/feed-enrich.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/feed-enrich.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { enrichFeedItem, type EnrichDeps } from "../../workers/api/src/cron/feed-enrich.js";

const noop = (() => {}) as unknown as EnrichDeps["logEvent"];

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function baseDeps(over: Partial<EnrichDeps>): EnrichDeps {
  return {
    thinChars: 600,
    fetchImpl: async () => htmlResponse("<p>shell</p>"),
    extractArticleFn: async () => ({ content: "", media: [] }),
    renderFn: null,
    logEvent: noop,
    ...over,
  };
}

const item = { url: "https://x.test/a", title: "A", summary: "one line teaser" };

describe("enrichFeedItem", () => {
  it("accepts the cheap path when content clears the bar", async () => {
    const deps = baseDeps({
      fetchImpl: async () => htmlResponse("<article>full</article>"),
      extractArticleFn: async () => ({
        content: "x".repeat(800),
        media: [{ type: "image", url: "https://x.test/i.png" }],
      }),
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("enriched");
    expect(res.via).toBe("fetch");
    expect(res.content!.length).toBe(800);
    expect(res.media).toHaveLength(1);
  });

  it("escalates to render when the cheap path is still thin", async () => {
    let calls = 0;
    const deps = baseDeps({
      extractArticleFn: async ({ markdown }) => {
        calls++;
        return { content: markdown === "RENDERED" ? "y".repeat(800) : "tiny", media: [] };
      },
      renderFn: async () => "RENDERED",
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("enriched");
    expect(res.via).toBe("render");
    expect(calls).toBe(2);
  });

  it("skips render escalation when renderFn is null", async () => {
    const deps = baseDeps({
      extractArticleFn: async () => ({ content: "tiny", media: [] }),
      renderFn: null,
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("no_improvement");
  });

  it("fails open on a thrown fetch error", async () => {
    const deps = baseDeps({
      fetchImpl: async () => {
        throw new Error("network");
      },
      renderFn: null,
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("no_improvement");
  });

  it("clears the bar relative to a long summary", async () => {
    const longSummary = { ...item, summary: "z".repeat(700) };
    const deps = baseDeps({
      extractArticleFn: async () => ({ content: "z".repeat(800), media: [] }),
    });
    // bar = max(600, 700*1.5=1050) = 1050; 800 < 1050 => no improvement
    expect((await enrichFeedItem(longSummary, deps)).status).toBe("no_improvement");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/feed-enrich.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the orchestrator**

Create `workers/api/src/cron/feed-enrich.ts`:

```ts
/**
 * Feed content enrichment — follow a summary-only feed item's link, fetch the
 * real article, and return clean body + media. Cheap path first (plain fetch +
 * htmlToMarkdown + single-article AI cleanup); escalate to Cloudflare Browser
 * Rendering only when the cheap path is still thin. Fail-open everywhere: any
 * error or no-improvement returns without content so the caller keeps the feed
 * summary and never loses the item.
 */
import { htmlToMarkdown, extractMediaFromMarkdown } from "@releases/adapters/feed.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import type { logEvent as LogEvent } from "@releases/lib/log-event";

type ReleaseMedia = { type: "image" | "video" | "gif"; url: string; alt?: string };

export interface EnrichDeps {
  /** Improvement bar floor — an enriched body must clear `max(thinChars, 1.5*summaryLen)`. */
  thinChars: number;
  /** Plain HTTP fetch (injectable for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Turn page markdown into clean article content + media. */
  extractArticleFn: (args: {
    markdown: string;
    title: string;
  }) => Promise<{ content: string; media: ReleaseMedia[] }>;
  /** Rendered-markdown fetch for escalation; `null` when CF creds are not bound. */
  renderFn: ((url: string) => Promise<string | null>) | null;
  logEvent: typeof LogEvent;
}

export interface EnrichResult {
  status: "enriched" | "no_improvement" | "error";
  via?: "fetch" | "render";
  content?: string;
  media?: ReleaseMedia[];
}

export interface EnrichItem {
  url: string;
  title: string;
  summary: string;
}

function bar(summary: string, thinChars: number): number {
  return Math.max(thinChars, Math.ceil(summary.length * 1.5));
}

export async function enrichFeedItem(item: EnrichItem, deps: EnrichDeps): Promise<EnrichResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const floor = bar(item.summary, deps.thinChars);

  // Cheap path: plain fetch → markdown → AI cleanup.
  try {
    const res = await fetchImpl(item.url, { headers: { "User-Agent": RELEASES_BOT_UA } });
    if (res.ok) {
      const html = await res.text();
      const markdown = htmlToMarkdown(html);
      const { content, media } = await deps.extractArticleFn({ markdown, title: item.title });
      if (content.length >= floor) {
        return { status: "enriched", via: "fetch", content, media };
      }
    }
  } catch (err) {
    deps.logEvent("warn", {
      component: "feed-enrich",
      event: "cheap-fetch-failed",
      url: item.url,
      err,
    });
  }

  // Escalate to Browser Rendering, only when creds are bound.
  if (deps.renderFn) {
    try {
      const markdown = await deps.renderFn(item.url);
      if (markdown) {
        const { content, media } = await deps.extractArticleFn({ markdown, title: item.title });
        if (content.length >= floor) {
          return { status: "enriched", via: "render", content, media };
        }
      }
    } catch (err) {
      deps.logEvent("warn", {
        component: "feed-enrich",
        event: "render-fetch-failed",
        url: item.url,
        err,
      });
    }
  }

  return { status: "no_improvement" };
}

/** Helper so callers don't re-import the media extractor: wrap an `extractArticle`
 *  call + markdown media extraction into the `extractArticleFn` shape. */
export function makeExtractArticleFn(
  runExtract: (markdown: string, title: string) => Promise<{ content: string }>,
): EnrichDeps["extractArticleFn"] {
  return async ({ markdown, title }) => {
    const { content } = await runExtract(markdown, title);
    return { content, media: extractMediaFromMarkdown(markdown) };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/feed-enrich.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/cron/feed-enrich.ts tests/unit/feed-enrich.test.ts
git commit -m "feat(api): enrichFeedItem orchestrator (cheap fetch + render escalation)"
```

---

## Task 5: `FetchOneEnv` config — CF creds + enrichment envs

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (`FetchOneEnv` ~535)

- [ ] **Step 1: Extend `FetchOneEnv`**

In `workers/api/src/cron/poll-fetch.ts`, inside `interface FetchOneEnv extends IndexNowEnv, AnthropicEnv {`, add:

```ts
  // Feed content enrichment (#feed-enrich). Kill switch + cap as strings (Workers
  // env vars are strings). CF creds are bound from the same Secrets Store entries
  // the discovery worker uses; absent => render escalation is skipped.
  FEED_ENRICH_ENABLED?: string;
  FEED_ENRICH_MAX_PER_FIRE?: string;
  FEED_THIN_CHARS?: string;
  CLOUDFLARE_ACCOUNT_ID?: { get(): Promise<string> };
  CLOUDFLARE_API_TOKEN?: { get(): Promise<string> };
```

> **Note:** the discovery worker binds these via `secrets_store_secrets`, which the SDK surfaces as `{ get(): Promise<string> }`. Match that shape; resolve with `await env.CLOUDFLARE_ACCOUNT_ID?.get()`.

- [ ] **Step 2: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS (no new errors from the added optional fields).

- [ ] **Step 3: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts
git commit -m "feat(api): FetchOneEnv config for feed enrichment"
```

---

## Task 6: Persist the detection flag in `fetchOne`

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (feed metadata-persist block ~1018-1031)
- Test: `tests/unit/feed-depth.test.ts` (covers `assessFeedDepth`; this step wires it)

This step has no new unit test of its own (the decision logic is already tested in Task 2); it wires `assessFeedDepth` into the existing metadata merge. Verify by type-check + the full suite.

- [ ] **Step 1: Import the detector**

In `poll-fetch.ts`, add to the `@releases/adapters` imports near the top:

```ts
import { assessFeedDepth, DEFAULT_FEED_THIN_CHARS } from "@releases/adapters/feed-depth";
```

- [ ] **Step 2: Set the flag in the metadata merge**

In the feed branch's `if (!dryRun) { const metaUpdates ... }` block (currently ~1019-1023), after the `feed4xxStreak` line and before `if (Object.keys(metaUpdates).length > 0)`:

```ts
// Auto-detect summary-only feeds once and persist the flag (#feed-enrich).
// Only set it; never clear it here (a feed that upgrades to full bodies
// clearing the flag is future work). Skip if already decided.
if (!meta.feedContentDepth) {
  const thinChars =
    Number(env.FEED_THIN_CHARS ?? DEFAULT_FEED_THIN_CHARS) || DEFAULT_FEED_THIN_CHARS;
  const depth = assessFeedDepth(rawReleases, { thinChars });
  if (depth === "summary-only") {
    metaUpdates.feedContentDepth = "summary-only";
    logEvent("info", {
      component: "cron-poll-fetch",
      event: "feed-depth-detected",
      sourceSlug: source.slug,
      feedItemCount: rawReleases.length,
    });
  }
}
```

- [ ] **Step 3: Type-check + full suite**

Run: `cd workers/api && npx tsc --noEmit && cd ../.. && bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts
git commit -m "feat(api): auto-detect and persist summary-only feed depth"
```

---

## Task 7: Forward enrichment in `fetchOne`

Add `enrichNewThinItems()` to `feed-enrich.ts` (the worker-side glue: gate, new-URL filter, cap, client build, marker), then call it in `fetchOne` and apply results in the row mapping.

**Files:**

- Modify: `workers/api/src/cron/feed-enrich.ts` (add `enrichNewThinItems` + `EnrichmentMarker`)
- Modify: `workers/api/src/cron/poll-fetch.ts` (call it ~after 1124; apply in row mapping ~1126-1150)
- Test: `tests/unit/feed-enrich.test.ts` (add `enrichNewThinItems` cases)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/feed-enrich.test.ts`:

```ts
import {
  enrichNewThinItems,
  type EnrichmentMarker,
} from "../../workers/api/src/cron/feed-enrich.js";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { beforeAll, beforeEach, afterAll } from "bun:test";

let tdb: TestDatabase;
beforeAll(() => {
  tdb = createTestDb();
});
beforeEach(() => clearAllTables(tdb.db));
afterAll(() => tdb.cleanup());

async function seedSource() {
  await tdb.db
    .insert(organizations)
    .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
  await tdb.db.insert(sources).values({
    id: "src_1",
    slug: "acme-feed",
    name: "Acme Feed",
    type: "feed",
    url: "https://x.test",
    orgId: "org_1",
    discovery: "curated",
  });
  await tdb.db.insert(releases).values({
    id: "rel_existing",
    sourceId: "src_1",
    type: "feature",
    title: "old",
    content: "old body",
    url: "https://x.test/seen",
  });
  return { id: "src_1", slug: "acme-feed", orgId: "org_1" };
}

describe("enrichNewThinItems", () => {
  const raw = (url: string, thin: boolean) => ({
    title: "t",
    content: thin ? "teaser" : "x".repeat(2000),
    contentFromSummary: thin,
    url,
    isBreaking: false,
  });
  const env = { FEED_ENRICH_ENABLED: "true", FEED_THIN_CHARS: "600" } as any;

  it("returns empty when the kill switch is off", async () => {
    const source = await seedSource();
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      [raw("https://x.test/new", true)],
      { ...env, FEED_ENRICH_ENABLED: "false" },
      { enrichFn: async () => ({ status: "enriched", content: "X".repeat(800), media: [] }) },
    );
    expect(map.size).toBe(0);
  });

  it("enriches only new thin URLs and records markers", async () => {
    const source = await seedSource();
    const items = [
      raw("https://x.test/seen", true),
      raw("https://x.test/new", true),
      raw("https://x.test/full", false),
    ];
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      items,
      env,
      {
        enrichFn: async () => ({
          status: "enriched",
          via: "fetch",
          content: "X".repeat(800),
          media: [],
        }),
      },
    );
    // index 0 = already in DB (skip), index 2 = not thin (skip), index 1 = enriched.
    expect([...map.keys()]).toEqual([1]);
    expect(map.get(1)!.content!.length).toBe(800);
    expect(map.get(1)!.marker.succeeded).toBe(true);
  });

  it("records a failed marker but no content on no_improvement", async () => {
    const source = await seedSource();
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      [raw("https://x.test/new", true)],
      env,
      { enrichFn: async () => ({ status: "no_improvement" }) },
    );
    expect(map.get(0)!.content).toBeUndefined();
    expect(map.get(0)!.marker.succeeded).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/feed-enrich.test.ts -t "enrichNewThinItems"`
Expected: FAIL — `enrichNewThinItems` not exported.

- [ ] **Step 3: Add `enrichNewThinItems` + `EnrichmentMarker` to `feed-enrich.ts`**

Append to `workers/api/src/cron/feed-enrich.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import type { drizzle } from "drizzle-orm/d1";
import type { Source } from "@buildinternet/releases-core/schema";
import type { SourceMetadata } from "@releases/adapters/feed.js";
import type { RawRelease } from "@releases/adapters/types.js";
import { isThinItem, DEFAULT_FEED_THIN_CHARS } from "@releases/adapters/feed-depth";

export const DEFAULT_ENRICH_MAX_PER_FIRE = 10;
export const RELEASES_URL_IN_CHUNK_SIZE = 90; // D1 bind-param safety (matches RELEASES_ID_IN_CHUNK_SIZE)

export interface EnrichmentMarker {
  attemptedAt: string;
  succeeded: boolean;
  via?: "fetch" | "render";
}

export interface EnrichOutcome {
  content?: string;
  media?: ReleaseMedia[];
  marker: EnrichmentMarker;
}

interface EnrichNewThinEnv {
  FEED_ENRICH_ENABLED?: string;
  FEED_ENRICH_MAX_PER_FIRE?: string;
  FEED_THIN_CHARS?: string;
}

/**
 * Forward-path enrichment: pick new, thin items (URL not already in D1), enrich
 * up to the per-fire cap, and return an index→outcome map the caller applies
 * during row mapping. Reads existing URLs via the passed drizzle handle (works
 * under the test DB; see repo memory on makeD1Shim read limits). Never throws —
 * per-item failures are fail-open inside `enrichFeedItem`.
 */
export async function enrichNewThinItems(
  db: ReturnType<typeof drizzle>,
  source: Source,
  meta: SourceMetadata,
  rawReleases: readonly RawRelease[],
  env: EnrichNewThinEnv,
  deps: { enrichFn: (item: EnrichItem, ...rest: never[]) => Promise<EnrichResult> },
): Promise<Map<number, EnrichOutcome>> {
  const out = new Map<number, EnrichOutcome>();
  if (env.FEED_ENRICH_ENABLED !== "true") return out;
  if (meta.feedContentDepth !== "summary-only") return out;

  const thinChars =
    Number(env.FEED_THIN_CHARS ?? DEFAULT_FEED_THIN_CHARS) || DEFAULT_FEED_THIN_CHARS;
  const cap =
    Number(env.FEED_ENRICH_MAX_PER_FIRE ?? DEFAULT_ENRICH_MAX_PER_FIRE) ||
    DEFAULT_ENRICH_MAX_PER_FIRE;

  // Candidate indices: has URL + thin. Resolve which URLs are already in D1 so we
  // never pay enrichment cost on items onConflictDoNothing would drop.
  const candidates = rawReleases
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => raw.url && isThinItem(raw, { thinChars }));
  if (candidates.length === 0) return out;

  const urls = [...new Set(candidates.map((c) => c.raw.url!))];
  const existing = new Set<string>();
  for (let i = 0; i < urls.length; i += RELEASES_URL_IN_CHUNK_SIZE) {
    const chunk = urls.slice(i, i + RELEASES_URL_IN_CHUNK_SIZE);
    // eslint-disable-next-line no-await-in-loop -- chunked to respect D1 bind-param cap
    const rows = await db
      .select({ url: releases.url })
      .from(releases)
      .where(inArray(releases.url, chunk));
    for (const r of rows) if (r.url) existing.add(r.url);
  }

  const fresh = candidates.filter(({ raw }) => !existing.has(raw.url!)).slice(0, cap);
  for (const { raw, index } of fresh) {
    const attemptedAt = new Date().toISOString();
    // eslint-disable-next-line no-await-in-loop -- bounded by `cap`; sequential keeps cost predictable
    const res = await deps.enrichFn({
      url: raw.url!,
      title: raw.title,
      summary: raw.content ?? "",
    });
    if (res.status === "enriched") {
      out.set(index, {
        content: res.content,
        media: res.media,
        marker: { attemptedAt, succeeded: true, via: res.via },
      });
    } else {
      out.set(index, { marker: { attemptedAt, succeeded: false } });
    }
  }
  return out;
}
```

> **Note:** `eq` is imported for symmetry with other call sites; if oxlint flags it as unused, drop it. The `enrichFn` signature uses `...rest: never[]` so the test can pass a 1-arg stub; the real caller passes a closure that already binds `deps`.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `bun test tests/unit/feed-enrich.test.ts`
Expected: PASS (orchestrator + `enrichNewThinItems` cases).

- [ ] **Step 5: Wire it into `fetchOne` and apply results**

In `poll-fetch.ts`, add imports:

```ts
import { buildAnthropicClient } from "../lib/anthropic.js"; // confirm: it's already used at ~860; add to the existing import if not present
import { fetchCloudflareMarkdown } from "@releases/adapters/cloudflare";
import { extractArticle, MODEL as ARTICLE_MODEL } from "@releases/ai-internal/article-extract";
import {
  enrichNewThinItems,
  enrichFeedItem,
  makeExtractArticleFn,
  type EnrichOutcome,
} from "./feed-enrich.js";
```

Immediately after the `marketingMap` assignment (~1124), build the enrichment map:

```ts
const enrichMap = await buildEnrichMap(db, source, meta, rawReleases, env);
```

Add this private helper near the bottom of `poll-fetch.ts` (module scope), which resolves CF creds + the Anthropic client and delegates to `enrichNewThinItems`:

```ts
async function buildEnrichMap(
  db: ReturnType<typeof drizzle>,
  source: Source,
  meta: SourceMetadata,
  rawReleases: readonly RawRelease[],
  env: FetchOneEnv,
): Promise<Map<number, EnrichOutcome>> {
  if (env.FEED_ENRICH_ENABLED !== "true" || meta.feedContentDepth !== "summary-only") {
    return new Map();
  }
  const apiKey = await getAnthropicKey(env);
  if (!apiKey) return new Map();
  const client = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(env)) });

  const accountId = await env.CLOUDFLARE_ACCOUNT_ID?.get().catch(() => undefined);
  const apiToken = await env.CLOUDFLARE_API_TOKEN?.get().catch(() => undefined);
  const renderFn =
    accountId && apiToken
      ? (url: string) => fetchCloudflareMarkdown(url, accountId, apiToken)
      : null;

  const extractArticleFn = makeExtractArticleFn(async (markdown, title) => {
    const { content } = await extractArticle(client, { markdown, title, model: ARTICLE_MODEL });
    return { content };
  });
  const thinChars = Number(env.FEED_THIN_CHARS ?? 600) || 600;

  return enrichNewThinItems(db, source, meta, rawReleases, env, {
    enrichFn: (item) => enrichFeedItem(item, { thinChars, extractArticleFn, renderFn, logEvent }),
  });
}
```

Then update the row mapping (~1126-1150) to consume `enrichMap`:

```ts
const rows = rawReleases.map((raw, index) => {
  const enrich = enrichMap.get(index);
  const content = enrich?.content ?? raw.content;
  const media = enrich?.content ? (enrich.media ?? []) : (raw.media ?? []);
  const size = computeContentSize(content);
  const verdict = marketingMap.get(index);
  return {
    sourceId: source.id,
    version: raw.version ?? null,
    versionSort: computeVersionSort(raw.version),
    title: raw.title,
    content,
    url: raw.url ?? null,
    contentHash: contentHash({ ...raw, content }),
    contentChars: size.contentChars,
    contentTokens: size.contentTokens,
    publishedAt: raw.publishedAt?.toISOString() ?? null,
    prerelease: raw.prerelease ?? isPrereleaseVersion(raw.version),
    media: JSON.stringify(
      // oxlint-disable-next-line no-map-spread -- copy-on-write required; m is an adapter-returned object
      media.map((m) => ({ ...m, url: normalizeMediaUrl(m.url) })),
    ),
    ...(enrich ? { metadata: JSON.stringify({ enrichment: enrich.marker }) } : {}),
    suppressed: verdict?.isMarketing === true,
    suppressedReason: verdict?.isMarketing ? `marketing_classifier:${verdict.reason}` : null,
  };
});
```

> **Note:** spreading `...(enrich ? { metadata } : {})` leaves `metadata` unset for non-enriched rows, so D1's column default (`"{}"`) applies. Confirm `contentHash` reads `.content` from its argument (it's imported from `@releases/adapters/content-hash` and called as `contentHash(raw)` today); `{ ...raw, content }` overrides the body so the hash reflects the enriched content.

- [ ] **Step 6: Type-check + full suite**

Run: `cd workers/api && npx tsc --noEmit && cd ../.. && bun test tests/unit/feed-enrich.test.ts && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/cron/feed-enrich.ts workers/api/src/cron/poll-fetch.ts tests/unit/feed-enrich.test.ts
git commit -m "feat(api): forward feed enrichment before insert"
```

---

## Task 8: Backfill endpoint `POST /v1/workflows/enrich-feed-content`

**Files:**

- Modify: `workers/api/src/routes/workflows.ts`
- Test: `tests/unit/feed-enrich-backfill.test.ts`

The endpoint resolves a source, selects thin un-enriched releases, enriches up to `limit`, updates rows, nulls `summary`/`titleGenerated`/`titleShort` + `embeddedAt`, then calls `generateContentForReleases`. For testability, extract the core into an exported `runEnrichBackfill()` function that takes a drizzle handle + an injected `enrichFn`, and have the route be a thin wrapper.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/feed-enrich-backfill.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { runEnrichBackfill } from "../../workers/api/src/routes/workflows.js";

let tdb: TestDatabase;
beforeAll(() => {
  tdb = createTestDb();
});
beforeEach(() => clearAllTables(tdb.db));
afterAll(() => tdb.cleanup());

async function seed() {
  await tdb.db
    .insert(organizations)
    .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
  await tdb.db.insert(sources).values({
    id: "src_1",
    slug: "f",
    name: "F",
    type: "feed",
    url: "https://x.test",
    orgId: "org_1",
    discovery: "curated",
  });
  // thin (content == summary) un-enriched
  await tdb.db.insert(releases).values({
    id: "rel_thin",
    sourceId: "src_1",
    type: "feature",
    title: "T",
    content: "teaser",
    summary: "teaser",
    url: "https://x.test/a",
    titleGenerated: "old gen",
    embeddedAt: "2026-01-01",
  });
  // already enriched (marker present) — must be skipped
  await tdb.db.insert(releases).values({
    id: "rel_done",
    sourceId: "src_1",
    type: "feature",
    title: "T2",
    content: "big body ".repeat(200),
    url: "https://x.test/b",
    metadata: JSON.stringify({ enrichment: { attemptedAt: "x", succeeded: true } }),
  });
}

describe("runEnrichBackfill", () => {
  it("dryRun reports candidates without writing", async () => {
    await seed();
    const report = await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: true, thinChars: 600 },
      {
        enrichFn: async () => ({ status: "enriched", content: "X".repeat(800), media: [] }),
        regenerate: async () => {},
      },
    );
    expect(report.scanned).toBe(1);
    expect(report.enriched).toBe(0);
    const [row] = await tdb.db
      .select({ content: releases.content })
      .from(releases)
      .where(eq(releases.id, "rel_thin"));
    expect(row.content).toBe("teaser"); // unchanged
  });

  it("real run updates content, nulls summary/embeddedAt, and regenerates", async () => {
    await seed();
    let regenIds: string[] = [];
    const report = await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: false, thinChars: 600 },
      {
        enrichFn: async () => ({
          status: "enriched",
          via: "fetch",
          content: "X".repeat(800),
          media: [],
        }),
        regenerate: async (ids) => {
          regenIds = ids;
        },
      },
    );
    expect(report.enriched).toBe(1);
    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_thin"));
    expect(row.content.length).toBe(800);
    expect(row.titleGenerated).toBeNull();
    expect(row.embeddedAt).toBeNull();
    expect(JSON.parse(row.metadata!).enrichment.succeeded).toBe(true);
    expect(regenIds).toEqual(["rel_thin"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/feed-enrich-backfill.test.ts`
Expected: FAIL — `runEnrichBackfill` not exported.

- [ ] **Step 3: Implement `runEnrichBackfill` + the route**

In `workers/api/src/routes/workflows.ts`, add imports (note: `sources`,
`sourceMatchByIdOrSlug`, and `createDb` are already imported in this file by the
`summarize` handler — only add what's missing):

```ts
import { releases } from "@buildinternet/releases-core/schema"; // `sources` likely already imported
import { sourceMatchByIdOrSlug } from "../utils.js"; // likely already imported
import { and, eq, sql, inArray } from "drizzle-orm";
import { computeContentSize } from "@buildinternet/releases-core/tokens";
import { contentHash } from "@releases/adapters/content-hash";
import { normalizeMediaUrl } from "@releases/rendering/media-url.js";
import { fetchCloudflareMarkdown } from "@releases/adapters/cloudflare";
import { extractArticle, MODEL as ARTICLE_MODEL } from "@releases/ai-internal/article-extract";
import { enrichFeedItem, makeExtractArticleFn, type EnrichResult } from "../cron/feed-enrich.js";
import { generateContentForReleases } from "../workflows/poll-and-fetch.js";
import { buildAnthropicClient, getAnthropicKey, resolveGatewayOpts } from "../lib/anthropic.js";
import { logEvent } from "@releases/lib/log-event";
```

Add the core function (exported for tests):

```ts
interface EnrichBackfillOpts {
  limit: number;
  dryRun: boolean;
  thinChars: number;
}
interface EnrichBackfillDeps {
  enrichFn: (item: { url: string; title: string; summary: string }) => Promise<EnrichResult>;
  regenerate: (ids: string[]) => Promise<void>;
}
export interface EnrichBackfillReport {
  scanned: number;
  enriched: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
}

export async function runEnrichBackfill(
  db: ReturnType<typeof createDb>,
  sourceId: string,
  opts: EnrichBackfillOpts,
  deps: EnrichBackfillDeps,
): Promise<EnrichBackfillReport> {
  // Thin + un-enriched: content equals summary (the teaser-as-content case) and
  // no enrichment marker yet. `json_extract` keeps genuinely one-line releases
  // from being retried once attempted.
  const candidates = await db
    .select({
      id: releases.id,
      title: releases.title,
      content: releases.content,
      url: releases.url,
    })
    .from(releases)
    .where(
      and(
        eq(releases.sourceId, sourceId),
        sql`${releases.url} IS NOT NULL`,
        sql`json_extract(${releases.metadata}, '$.enrichment') IS NULL`,
        sql`(${releases.summary} IS NULL OR ${releases.content} = ${releases.summary})`,
      ),
    )
    .orderBy(sql`${releases.publishedAt} DESC`)
    .limit(opts.limit);

  const report: EnrichBackfillReport = {
    scanned: candidates.length,
    enriched: 0,
    skipped: 0,
    failed: 0,
    dryRun: opts.dryRun,
  };
  if (opts.dryRun) return report;

  const enrichedIds: string[] = [];
  for (const row of candidates) {
    const attemptedAt = new Date().toISOString();
    // eslint-disable-next-line no-await-in-loop -- bounded by `limit`
    const res = await deps.enrichFn({ url: row.url!, title: row.title, summary: row.content });
    if (res.status !== "enriched" || !res.content) {
      report.skipped++;
      // eslint-disable-next-line no-await-in-loop
      await db
        .update(releases)
        .set({ metadata: JSON.stringify({ enrichment: { attemptedAt, succeeded: false } }) })
        .where(eq(releases.id, row.id));
      continue;
    }
    const size = computeContentSize(res.content);
    // eslint-disable-next-line no-await-in-loop
    await db
      .update(releases)
      .set({
        content: res.content,
        contentChars: size.contentChars,
        contentTokens: size.contentTokens,
        contentHash: contentHash({ title: row.title, content: res.content } as never),
        ...(res.media && res.media.length > 0
          ? {
              media: JSON.stringify(
                res.media.map((m) => ({ ...m, url: normalizeMediaUrl(m.url) })),
              ),
            }
          : {}),
        metadata: JSON.stringify({ enrichment: { attemptedAt, succeeded: true, via: res.via } }),
        // Force summary + embedding refresh on the richer body.
        summary: null,
        titleGenerated: null,
        titleShort: null,
        embeddedAt: null,
      })
      .where(eq(releases.id, row.id));
    report.enriched++;
    enrichedIds.push(row.id);
  }

  if (enrichedIds.length > 0) await deps.regenerate(enrichedIds);
  return report;
}
```

Add the route handler (mirrors the `summarize` handler's structure — body parse, source resolve, secret resolve, JSON response):

```ts
interface EnrichFeedContentBody {
  sourceId?: string;
  orgSlug?: string;
  sourceSlug?: string;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/enrich-feed-content", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<EnrichFeedContentBody>().catch(() => ({}) as EnrichFeedContentBody);

  // Resolve the source. Accept a typed id / bare slug via the existing
  // `sourceMatchByIdOrSlug` (imported at the top of this file — it's already used
  // by the summarize handler), or `orgSlug` + `sourceSlug`. Reject when neither.
  const ident = body.sourceId?.trim() || body.sourceSlug?.trim();
  if (!ident) {
    return c.json({ error: "bad_request", message: "Provide `sourceId` or `sourceSlug`" }, 400);
  }
  const [src] = await db
    .select({ id: sources.id, slug: sources.slug, name: sources.name, orgId: sources.orgId })
    .from(sources)
    .where(sourceMatchByIdOrSlug(ident));
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const limit = Math.min(Math.max(Number(body.limit ?? 25), 1), 200);
  const dryRun = body.dryRun !== false; // default to a dry run for safety
  const thinChars = Number(c.env.FEED_THIN_CHARS ?? 600) || 600;

  const apiKey = await getAnthropicKey(c.env);
  if (!apiKey)
    return c.json(
      { error: "service_unavailable", message: "ANTHROPIC_API_KEY not configured" },
      503,
    );
  const client = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(c.env)) });
  const accountId = await c.env.CLOUDFLARE_ACCOUNT_ID?.get().catch(() => undefined);
  const apiToken = await c.env.CLOUDFLARE_API_TOKEN?.get().catch(() => undefined);
  const renderFn =
    accountId && apiToken
      ? (url: string) => fetchCloudflareMarkdown(url, accountId, apiToken)
      : null;
  const extractArticleFn = makeExtractArticleFn(async (markdown, title) => {
    const { content } = await extractArticle(client, { markdown, title, model: ARTICLE_MODEL });
    return { content };
  });

  const report = await runEnrichBackfill(
    db,
    src.id,
    { limit, dryRun, thinChars },
    {
      enrichFn: (item) => enrichFeedItem(item, { thinChars, extractArticleFn, renderFn, logEvent }),
      regenerate: (ids) => generateContentForReleases(db, c.env, src as never, ids),
    },
  );

  return c.json({ source: { id: src.id, slug: src.slug }, ...report });
});
```

> **Notes:**
>
> - `resolveBackfillSource(db, body)` — reuse the existing source-resolution helper in this file (the `summarize` handler resolves a source by id/slug via `sourceMatchByIdOrSlug`). If only a bare `slug` form exists, accept `sourceId` (typed id) and `orgSlug`+`sourceSlug`; select `{ id, slug, name, orgId }` from `sources`. Match the field set `generateContentForReleases` expects of its `source` arg.
> - `generateContentForReleases(db, c.env, source, ids)` already filters on `org.autoGenerateContent` and `title_generated IS NULL` — nulling `titleGenerated` above lets it re-fill. Confirm `c.env` satisfies its `PollAndFetchWorkflowEnv` param (it needs the Anthropic env + DB; cast with `as never` only if the structural check is over-strict, and leave a comment).
> - This route is admin-gated automatically: `workflows` is in the `adminRoutes` allowlist (`route-namespaces.ts`), so `authMiddleware` already applies (`index.ts:275`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/feed-enrich-backfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/workflows.ts tests/unit/feed-enrich-backfill.test.ts
git commit -m "feat(api): backfill endpoint for feed content enrichment"
```

---

## Task 9: Config bindings + docs

**Files:**

- Modify: `workers/api/wrangler.jsonc` (prod + `[env.staging]` vars + secret bindings)
- Modify: `.env.example`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add the CF secret bindings to the API worker**

In `workers/api/wrangler.jsonc`, in the `secrets_store_secrets` array (the prod block, near the `ANTHROPIC_API_KEY` / `AI_GATEWAY_TOKEN` entries), add two entries mirroring `workers/discovery/wrangler.jsonc:96-103` — **reuse the same `store_id` + `secret_name` values the discovery worker uses** (no new secret values):

```jsonc
    { "binding": "CLOUDFLARE_ACCOUNT_ID", "store_id": "<same as discovery>", "secret_name": "CLOUDFLARE_ACCOUNT_ID" },
    { "binding": "CLOUDFLARE_API_TOKEN", "store_id": "<same as discovery>", "secret_name": "CLOUDFLARE_API_TOKEN" }
```

Repeat in the `[env.staging]` secrets block (use the staging `secret_name` if the discovery staging block uses a suffixed name; otherwise the same).

Add the feature flags to the `vars` block (prod **off**):

```jsonc
    "FEED_ENRICH_ENABLED": "false",
    "FEED_ENRICH_MAX_PER_FIRE": "10",
    "FEED_THIN_CHARS": "600",
```

> **Decision gate:** binding a Browser-Rendering-capable token to the API worker is a capability change. If deferred, skip this step — the feature still ships and fixes SSR feeds via the cheap path (render escalation is simply skipped). Flag this to the operator.

- [ ] **Step 2: Document env vars in `.env.example`**

Add (this is the committed template, not a live `.env`):

```bash
# Feed content enrichment (#feed-enrich). Follow summary-only feed item links to
# capture the full article. Ship off; flip on after staging validation.
FEED_ENRICH_ENABLED=false
FEED_ENRICH_MAX_PER_FIRE=10
FEED_THIN_CHARS=600
```

- [ ] **Step 3: Add an AGENTS.md bullet**

Under the conventions list in `AGENTS.md` (near the marketing-classifier bullet), add a short paragraph describing summary-only detection (`feedContentDepth`), `enrichFeedItem` (cheap fetch → render escalation), the per-fire cap + `FEED_ENRICH_ENABLED` kill switch, the `metadata.enrichment` marker, and the `POST /v1/workflows/enrich-feed-content` backfill. Keep it to ~6 lines matching the surrounding density.

- [ ] **Step 4: Commit**

```bash
git add workers/api/wrangler.jsonc .env.example AGENTS.md
git commit -m "chore: bind CF creds + document feed enrichment config"
```

---

## Task 10: Final verification

- [ ] **Step 1: Type-check root + api worker**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit && cd ../..`
Expected: PASS (note: root `tsc` only checks `src/`; tests/scripts aren't gate-checked — rely on `bun test`).

- [ ] **Step 2: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. Fix any oxlint findings (e.g. unused `eq` import from Task 7).

- [ ] **Step 3: Full test suite**

Run: `bun test`
Expected: PASS, including the four new test files.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore: lint/typecheck fixups for feed enrichment"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Detection (Task 2 + 6), `extractArticle` (Task 3), `enrichFeedItem` cheap+render (Task 4), new-URL filter + cap + kill switch + marker (Task 7), forward apply with content/media/contentHash/metadata (Task 7), backfill with null-then-regenerate + embed clear (Task 8), CF binding + config + docs (Task 9).
- **Manual rollout (not automated here):** staging — set `feedContentDepth: "summary-only"` on the Webflow source, `FEED_ENRICH_ENABLED=true`, dry-run then real `limit` against `POST /v1/workflows/enrich-feed-content`, eyeball enriched content + regenerated summaries; then flip prod. See spec → Rollout.
- **Type-consistency anchors:** `EnrichResult.status ∈ {"enriched","no_improvement","error"}`; `EnrichmentMarker = { attemptedAt, succeeded, via? }`; `extractArticle` returns `{ content, usage }`; `enrichNewThinItems` returns `Map<number, EnrichOutcome>`; `runEnrichBackfill` returns `EnrichBackfillReport`. Keep these names identical across tasks.
- **Repo gotchas:** worker tests that READ via the query builder pass `createTestDb().db` directly as the drizzle handle (the D1 shim's `.raw()` returns `[]`); CLI tests aren't in scope. `RELEASES_BOT_UA` is the standard outbound UA.
