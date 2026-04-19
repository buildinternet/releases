# Crawl Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cloudflare `/crawl` endpoint support for multi-page changelogs, with `--crawl` flag on the fetch command that persists and parallelizes per-page AI parsing.

**Architecture:** New `src/adapters/crawl.ts` handles the crawl lifecycle (start → poll → parse). The scrape adapter gains a crawl path before its existing single-page path. Metadata type is widened from `FeedMetadata` to `SourceMetadata` to hold crawl state.

**Tech Stack:** Cloudflare Browser Rendering `/crawl` API, existing `parseChangelog()` from `src/ai/ingest.ts`, Bun runtime.

**Spec:** `docs/superpowers/specs/2026-03-26-crawl-integration-design.md`

---

## Task 1: Rename FeedMetadata → SourceMetadata and add crawl fields

This is a prerequisite for all other tasks. Widens the metadata type so crawl fields are valid.

**Files:**

- Modify: `src/adapters/feed.ts` — rename interface + helpers, add crawl fields
- Modify: `src/adapters/types.ts` — add `crawl` to `FetchOptions`

- [ ] **Step 1: Rename `FeedMetadata` → `SourceMetadata` in `src/adapters/feed.ts`**

Replace the interface definition at line 17:

```ts
export interface SourceMetadata {
  // Feed fields
  feedUrl?: string;
  feedType?: FeedType;
  feedDiscoveredAt?: string;
  feedEtag?: string;
  feedLastModified?: string;
  noFeedFound?: boolean;

  // Crawl fields
  crawlEnabled?: boolean;
  crawlPattern?: string;
  lastCrawlJobId?: string;
  lastCrawlAt?: string;
}
```

- [ ] **Step 2: Rename helpers in `src/adapters/feed.ts`**

`getSourceFeedMeta` → `getSourceMeta` (line 428), `updateSourceFeedMeta` → `updateSourceMeta` (line 437). Update the return type and parameter type to use `SourceMetadata`. Update all internal call sites in `feed.ts` (lines 225, 226, 239, 276, 438).

- [ ] **Step 3: Add `crawl` to `FetchOptions` in `src/adapters/types.ts`**

```ts
export interface FetchOptions {
  since?: Date;
  maxEntries?: number;
  /** --crawl (true) / --no-crawl (false) / unset (use persisted setting) */
  crawl?: boolean;
}
```

- [ ] **Step 4: Run type-check**

Run: `npx tsc --noEmit`
Expected: clean (no errors)

- [ ] **Step 5: Commit**

```
git add src/adapters/feed.ts src/adapters/types.ts
git commit -m "Rename FeedMetadata to SourceMetadata, add crawl fields and FetchOptions.crawl"
```

---

## Task 2: Create crawl adapter (`src/adapters/crawl.ts`)

Core crawl logic: start job, poll for results, parse pages in parallel.

**Files:**

- Create: `src/adapters/crawl.ts`
- Modify: `src/lib/errors.ts` — add `CrawlTimeoutError` and `CrawlJobError`

- [ ] **Step 1: Add error classes to `src/lib/errors.ts`**

Append to the file:

```ts
export class CrawlTimeoutError extends Error {
  constructor(jobId: string, timeoutMs: number) {
    super(`Crawl job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "CrawlTimeoutError";
  }
}

export class CrawlJobError extends Error {
  constructor(
    jobId: string,
    public jobStatus: string,
  ) {
    super(`Crawl job ${jobId} ended with status: ${jobStatus}`);
    this.name = "CrawlJobError";
  }
}
```

- [ ] **Step 2: Create `src/adapters/crawl.ts`**

```ts
import { config } from "../lib/config.js";
import { AdapterError, CrawlTimeoutError, CrawlJobError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parseChangelog } from "../ai/ingest.js";
import type { RawRelease, FetchOptions } from "./types.js";

// NOTE: The crawl flow is currently synchronous (poll until done). This is
// designed to be split into start/retrieve phases for background execution.
// See deferred items in the crawl integration spec.

interface CrawlOptions {
  includePatterns?: string[];
  limit?: number;
  modifiedSince?: number; // unix timestamp
}

interface CrawlPage {
  url: string;
  markdown: string;
  title?: string;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "errored",
  "cancelled_due_to_timeout",
  "cancelled_due_to_limits",
  "cancelled_by_user",
]);

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

function cfHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.cloudflareApiToken()}`,
    "Content-Type": "application/json",
  };
}

function crawlBaseUrl(): string {
  const accountId = config.cloudflareAccountId();
  if (!accountId) {
    throw new AdapterError("crawl", "CLOUDFLARE_ACCOUNT_ID must be set");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl`;
}

export async function startCrawl(url: string, options: CrawlOptions): Promise<string> {
  const body: Record<string, unknown> = {
    url,
    formats: ["markdown"],
    rejectResourceTypes: ["image", "media", "font", "stylesheet"],
  };

  if (options.includePatterns?.length) {
    body.options = { includePatterns: options.includePatterns };
  }
  if (options.limit) {
    body.limit = options.limit;
  }
  if (options.modifiedSince) {
    body.modifiedSince = options.modifiedSince;
  }

  const res = await fetch(crawlBaseUrl(), {
    method: "POST",
    headers: cfHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AdapterError("crawl", `Failed to start crawl: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { success: boolean; result: string };
  if (!data.success || !data.result) {
    throw new AdapterError("crawl", "Crawl API returned unexpected response");
  }

  return data.result;
}

export async function pollCrawlResults(jobId: string): Promise<CrawlPage[]> {
  const url = `${crawlBaseUrl()}/${jobId}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: cfHeaders() });
    if (!res.ok) {
      throw new AdapterError("crawl", `Failed to poll crawl ${jobId}: ${res.status}`);
    }

    const data = (await res.json()) as {
      success: boolean;
      result: {
        status: string;
        total?: number;
        finished?: number;
        records?: Array<{
          url: string;
          status: string;
          markdown?: string;
          metadata?: { title?: string; status?: number };
        }>;
      };
    };

    const jobStatus = data.result.status;
    logger.debug(
      `Crawl ${jobId}: ${jobStatus} (${data.result.finished ?? 0}/${data.result.total ?? "?"})`,
    );

    if (TERMINAL_STATUSES.has(jobStatus)) {
      if (jobStatus !== "completed") {
        throw new CrawlJobError(jobId, jobStatus);
      }

      // Filter to completed records with markdown content
      const pages: CrawlPage[] = (data.result.records ?? [])
        .filter((r) => r.status === "completed" && r.markdown?.trim())
        .map((r) => ({
          url: r.url,
          markdown: r.markdown!,
          title: r.metadata?.title,
        }));

      return pages;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new CrawlTimeoutError(jobId, POLL_TIMEOUT_MS);
}

export async function parseCrawlPages(
  pages: CrawlPage[],
  sourceSlug: string,
  options?: FetchOptions,
): Promise<RawRelease[]> {
  if (pages.length === 0) return [];

  logger.info(`Parsing ${pages.length} crawled page(s) with AI...`);

  // Parse pages in parallel with concurrency limit of 5
  const CONCURRENCY = 5;
  const allReleases: RawRelease[] = [];

  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (page) => {
        logger.debug(`Parsing page: ${page.url} (${page.markdown.length} chars)`);
        const parsed = await parseChangelog(page.markdown, sourceSlug);
        return parsed.map(
          (entry) =>
            ({
              version: entry.version,
              title: entry.title,
              content: entry.content,
              url: page.url,
              publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
              isBreaking: entry.isBreaking,
            }) as RawRelease,
        );
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        allReleases.push(...result.value);
      } else {
        logger.warn(`Failed to parse crawled page: ${result.reason}`);
      }
    }
  }

  // Apply filters after aggregation
  let filtered = allReleases;
  if (options?.since) {
    filtered = filtered.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    filtered = filtered.slice(0, options.maxEntries);
  }

  return filtered;
}
```

- [ ] **Step 3: Run type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```
git add src/adapters/crawl.ts src/lib/errors.ts
git commit -m "Add crawl adapter: start, poll, and parallel page parsing"
```

---

## Task 3: Integrate crawl into scrape adapter

Wire the crawl path into the scrape adapter's fetch cascade.

**Files:**

- Modify: `src/adapters/scrape.ts`

- [ ] **Step 1: Update imports in `src/adapters/scrape.ts`**

Add after the `fetchViaFeed` import:

```ts
import { startCrawl, pollCrawlResults, parseCrawlPages } from "./crawl.js";
import { getSourceMeta, updateSourceMeta } from "./feed.js";
import { CrawlTimeoutError, CrawlJobError } from "../lib/errors.js";
```

- [ ] **Step 2: Add crawl path at the top of the `fetch` method**

Replace the current body of `scrape.fetch` (lines 14-124) with:

```ts
  async fetch(source: Source, options?: FetchOptions): Promise<RawRelease[]> {
    const meta = getSourceMeta(source);
    const crawlActive = options?.crawl === true || (options?.crawl !== false && meta.crawlEnabled);

    // ── Crawl path (multi-page, per-page AI parsing) ──────────
    if (crawlActive) {
      try {
        return await fetchViaCrawl(source, meta, options);
      } catch (err) {
        if (err instanceof CrawlTimeoutError) {
          logger.warn(`${err.message} — returning empty`);
          return [];
        }
        if (err instanceof CrawlJobError) {
          logger.warn(`${err.message} — falling back to single-page scrape`);
          // Fall through to single-page below
        } else {
          throw err;
        }
      }
    }

    // ── Feed path (fast, free, deterministic) ─────────────────
    if (!crawlActive) {
      try {
        const feedResult = await fetchViaFeed(source, options);
        if (feedResult !== null) {
          logger.info(`Feed returned ${feedResult.length} releases (no AI needed)`);
          return feedResult;
        }
      } catch (err) {
        logger.warn(`Feed fetch/parse failed, falling back to Cloudflare + AI: ${err}`);
      }
    }

    // ── Single-page Cloudflare + AI path ──────────────────────
    return fetchViaSinglePage(source, options);
  },
```

- [ ] **Step 3: Extract existing single-page logic into `fetchViaSinglePage`**

Move the current Cloudflare + AI code (everything from the `const accountId` line onward) into a standalone function at the bottom of the file:

```ts
async function fetchViaSinglePage(source: Source, options?: FetchOptions): Promise<RawRelease[]> {
  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();
  // ... (existing code verbatim from current lines 27-123)
}
```

- [ ] **Step 4: Add `fetchViaCrawl` function**

```ts
async function fetchViaCrawl(
  source: Source,
  meta: ReturnType<typeof getSourceMeta>,
  options?: FetchOptions,
): Promise<RawRelease[]> {
  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();

  if (!accountId || !apiToken) {
    throw new AdapterError(
      "scrape",
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set to use crawl mode.",
    );
  }

  const pattern = meta.crawlPattern ?? `${source.url.replace(/\/$/, "")}/**`;
  const modifiedSince = meta.lastCrawlAt
    ? Math.floor(new Date(meta.lastCrawlAt).getTime() / 1000)
    : undefined;

  logger.info(`Starting crawl for ${source.url} (pattern: ${pattern})...`);
  const jobId = await startCrawl(source.url, {
    includePatterns: [pattern],
    limit: options?.maxEntries,
    modifiedSince,
  });

  logger.info(`Crawl started (job ${jobId}), polling for results...`);
  const pages = await pollCrawlResults(jobId);

  if (pages.length === 0) {
    logger.info(`Crawl returned no pages`);
    await updateSourceMeta(source, {
      lastCrawlJobId: jobId,
      lastCrawlAt: new Date().toISOString(),
    });
    return [];
  }

  logger.info(`Crawl returned ${pages.length} page(s), parsing...`);
  const releases = await parseCrawlPages(pages, source.slug, options);

  await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });

  logger.info(`Parsed ${releases.length} release(s) from crawl`);
  return releases;
}
```

- [ ] **Step 5: Run type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 6: Smoke test with CLI**

Run: `bun src/index.ts --help`
Expected: CLI loads without errors

- [ ] **Step 7: Commit**

```
git add src/adapters/scrape.ts
git commit -m "Integrate crawl path into scrape adapter fetch cascade"
```

---

## Task 4: Add CLI flags and metadata persistence

Wire `--crawl`, `--no-crawl`, `--crawl-pattern` into the fetch command.

**Files:**

- Modify: `src/cli/commands/fetch.ts`

- [ ] **Step 1: Add imports**

Add to existing imports in `fetch.ts`:

```ts
import { getSourceMeta, updateSourceMeta } from "../../adapters/feed.js";
```

- [ ] **Step 2: Add CLI options**

After the existing `.option("--all", ...)` line, add:

```ts
    .option("--crawl", "Enable crawl mode for multi-page changelogs (scrape sources only, persists)")
    .option("--no-crawl", "One-off override to skip crawl mode for this invocation")
    .option("--crawl-pattern <pattern>", "URL pattern to scope crawl (e.g. https://example.com/changelog/*)")
```

- [ ] **Step 3: Update the action signature**

Update opts type to include the new flags:

```ts
    .action(async (slug: string | undefined, opts: {
      json?: boolean; since?: string; max?: string; all?: boolean;
      crawl?: boolean; crawlPattern?: string;
    }) => {
```

Note: Commander handles `--no-crawl` by setting `opts.crawl = false`. When neither `--crawl` nor `--no-crawl` is passed, `opts.crawl` is `undefined`.

- [ ] **Step 4: Pass crawl to FetchOptions and persist metadata**

Inside the source loop, before calling `adapter.fetch`, add crawl handling:

```ts
      // Build fetch options with defaults
      const fetchOptions: FetchOptions = {};
      if (!opts.all) {
        if (opts.since) {
          fetchOptions.since = new Date(opts.since);
        }
        fetchOptions.maxEntries = parseInt(opts.max ?? "100", 10);
      }

      for (const source of targetSources) {
        const adapter = getAdapter(source.type);
        if (!adapter) continue;

        // Handle --crawl flag: persist on scrape sources, warn on others
        if (opts.crawl === true && source.type !== "scrape") {
          if (!opts.json) {
            logger.warn(`--crawl is only supported for scrape sources, skipping for ${source.name} (${source.type})`);
          }
        }

        if (opts.crawl === true && source.type === "scrape") {
          const pattern = opts.crawlPattern ?? `${source.url.replace(/\/$/, "")}/**`;
          await updateSourceMeta(source, {
            crawlEnabled: true,
            crawlPattern: pattern,
          });
          // Clear stale content hash to prevent it from suppressing single-page fallback
          const db = getDb();
          await db.update(sources).set({ lastContentHash: null }).where(eq(sources.id, source.id));
          if (!opts.json) {
            logger.info(`Crawl mode enabled for ${source.name} (pattern: ${pattern})`);
          }
        }

        // Pass crawl override to adapter
        fetchOptions.crawl = opts.crawl;
```

Move the closing of `fetchOptions.crawl` assignment to before the adapter call. The rest of the loop body stays the same.

- [ ] **Step 5: Run type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 6: Smoke test**

Run: `bun src/index.ts fetch --help`
Expected: shows `--crawl`, `--no-crawl`, `--crawl-pattern` options

- [ ] **Step 7: Commit**

```
git add src/cli/commands/fetch.ts
git commit -m "Add --crawl, --no-crawl, --crawl-pattern flags to fetch command"
```

---

## Task 5: Update docs

**Files:**

- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update README.md**

Add a "Crawl mode" section after the "Fetch releases" section:

```markdown
### Crawl mode

For changelogs spread across multiple pages, crawl mode follows links and parses each page individually:

\`\`\`bash
released fetch linear --crawl # enable crawl, auto-detect pattern
released fetch linear --crawl --crawl-pattern "https://linear.app/changelog/*"
released fetch linear --no-crawl # one-off skip, keeps setting
\`\`\`

Crawl mode persists on the source — subsequent `released fetch linear` calls will automatically crawl. Only works with `scrape` sources.
```

- [ ] **Step 2: Update CLAUDE.md conventions**

Add after the existing source types line:

```
- Crawl mode (`--crawl`) uses Cloudflare's `/crawl` endpoint for multi-page changelogs. Persists in `source.metadata` as `crawlEnabled`. The crawl flow is synchronous (poll until done) — background mode is deferred. See `src/adapters/crawl.ts`.
```

- [ ] **Step 3: Commit**

```
git add README.md CLAUDE.md
git commit -m "Document crawl mode in README and CLAUDE.md"
```
