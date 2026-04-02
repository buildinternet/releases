# Feed Change Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight HEAD-request-based change detection for feed sources, decoupled from the expensive fetch/parse/AI pipeline.

**Architecture:** A new `headCheckFeed()` function in the feed adapter compares HTTP HEAD response headers (ETag, Last-Modified, Content-Length) against stored values to detect changes without downloading content. A new `changeDetectedAt` column on sources flags which feeds have upstream changes. A new `released poll` CLI command runs these checks across sources, and the existing `fetch` flow uses HEAD as a pre-filter.

**Tech Stack:** TypeScript, Bun, Commander CLI, Drizzle ORM, SQLite/D1

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/adapters/feed.ts` | Modify | Add `headCheckFeed()` function, `feedContentLength` to `SourceMetadata`, integrate HEAD pre-check into `fetchViaFeed()` |
| `src/db/schema.ts` | Modify | Add `changeDetectedAt` column to `sources` table |
| `src/db/queries.ts` | Modify | Add `setChangeDetected()`, `clearChangeDetected()`, `listSourcesWithChanges()`, `listFeedSources()` helpers |
| `src/cli/commands/poll.ts` | Create | New `released poll` CLI command |
| `src/cli/program.ts` | Modify | Register poll command |
| `src/db/migrations/0002_*.sql` | Create | Local migration for `changeDetectedAt` |
| `workers/api/migrations/0002_add_change_detected_at.sql` | Create | D1 migration for `changeDetectedAt` |

---

### Task 1: Add `changeDetectedAt` Column

**Files:**
- Modify: `src/db/schema.ts:89-111`
- Create: `src/db/migrations/0002_add_change_detected_at.sql`
- Create: `workers/api/migrations/0002_add_change_detected_at.sql`

- [ ] **Step 1: Add column to schema**

In `src/db/schema.ts`, add `changeDetectedAt` to the `sources` table definition, after `nextFetchAfter`:

```typescript
  changeDetectedAt: text("change_detected_at"),
```

- [ ] **Step 2: Generate local migration**

Run: `bunx drizzle-kit generate --name add_change_detected_at`

Verify a new migration file was created in `src/db/migrations/` containing:

```sql
ALTER TABLE sources ADD COLUMN change_detected_at text;
```

- [ ] **Step 3: Create D1 migration**

Create `workers/api/migrations/0002_add_change_detected_at.sql`:

```sql
-- Add change_detected_at column for feed change detection
ALTER TABLE sources ADD COLUMN change_detected_at text;
```

- [ ] **Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors related to `changeDetectedAt`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/migrations/ workers/api/migrations/0002_add_change_detected_at.sql
git commit -m "feat: add changeDetectedAt column to sources table"
```

---

### Task 2: Add `headCheckFeed()` Function

**Files:**
- Modify: `src/adapters/feed.ts:15-45` (SourceMetadata interface)
- Modify: `src/adapters/feed.ts` (new function after `fetchAndParseFeed`)

- [ ] **Step 1: Add `feedContentLength` to SourceMetadata**

In `src/adapters/feed.ts`, add to the `SourceMetadata` interface in the feed fields section (after `feedLastModified`):

```typescript
  feedContentLength?: string;
```

- [ ] **Step 2: Write the `headCheckFeed()` function**

Add this function in `src/adapters/feed.ts` after the `fetchAndParseFeed` function (after line 250):

```typescript
export type ChangeStatus = "changed" | "unchanged" | "unknown";

export interface HeadCheckResult {
  status: ChangeStatus;
  etag?: string;
  lastModified?: string;
  contentLength?: string;
  responseMs: number;
}

/**
 * Send a HEAD request to a feed URL and compare response headers against
 * stored values to detect changes without downloading the feed body.
 */
export async function headCheckFeed(
  feedUrl: string,
  stored: { etag?: string; lastModified?: string; contentLength?: string },
): Promise<HeadCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = Date.now();

  try {
    const res = await fetch(feedUrl, {
      method: "HEAD",
      headers: { "User-Agent": "released/0.1" },
      signal: controller.signal,
      redirect: "follow",
    });

    const responseMs = Date.now() - start;
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    const contentLength = res.headers.get("content-length") ?? undefined;

    if (!res.ok) {
      return { status: "unknown", etag, lastModified, contentLength, responseMs };
    }

    // If no stored values to compare against, can't determine change
    const hasStored = stored.etag || stored.lastModified || stored.contentLength;
    if (!hasStored) {
      return { status: "unknown", etag, lastModified, contentLength, responseMs };
    }

    // Compare each available header against stored value
    if (etag && stored.etag) {
      if (etag !== stored.etag) return { status: "changed", etag, lastModified, contentLength, responseMs };
    }
    if (lastModified && stored.lastModified) {
      if (lastModified !== stored.lastModified) return { status: "changed", etag, lastModified, contentLength, responseMs };
    }
    if (contentLength && stored.contentLength) {
      if (contentLength !== stored.contentLength) return { status: "changed", etag, lastModified, contentLength, responseMs };
    }

    // If we had stored values and all matching headers agree, unchanged
    const anyHeaderMatched =
      (etag && stored.etag) ||
      (lastModified && stored.lastModified) ||
      (contentLength && stored.contentLength);

    if (anyHeaderMatched) {
      return { status: "unchanged", etag, lastModified, contentLength, responseMs };
    }

    // Server returned none of the headers we have stored — can't tell
    return { status: "unknown", etag, lastModified, contentLength, responseMs };
  } catch {
    return { status: "unknown", responseMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/feed.ts
git commit -m "feat: add headCheckFeed() for lightweight feed change detection"
```

---

### Task 3: Add Query Helpers

**Files:**
- Modify: `src/db/queries.ts`

- [ ] **Step 1: Add `listFeedSources()` helper**

Add after the `listFetchableSources` function in `src/db/queries.ts`:

```typescript
/** List sources that have a discovered feed URL in metadata. */
export async function listFeedSources(): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listFeedSources();
  }
  const db = getDb();
  return db.select().from(sources).where(
    and(
      sql`json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL`,
      sql`${sources.fetchPriority} != 'paused'`,
      notDisabled,
    )
  );
}
```

- [ ] **Step 2: Add `setChangeDetected()` helper**

```typescript
export async function setChangeDetected(source: Source): Promise<void> {
  const now = new Date().toISOString();
  if (isRemoteMode()) {
    await apiClient.updateSource(source.slug, { changeDetectedAt: now });
    return;
  }
  const db = getDb();
  await db.update(sources).set({ changeDetectedAt: now }).where(eq(sources.id, source.id));
}
```

- [ ] **Step 3: Add `clearChangeDetected()` helper**

```typescript
export async function clearChangeDetected(source: Source): Promise<void> {
  if (isRemoteMode()) {
    await apiClient.updateSource(source.slug, { changeDetectedAt: null });
    return;
  }
  const db = getDb();
  await db.update(sources).set({ changeDetectedAt: null }).where(eq(sources.id, source.id));
}
```

- [ ] **Step 4: Add `listSourcesWithChanges()` helper**

```typescript
export async function listSourcesWithChanges(): Promise<Source[]> {
  if (isRemoteMode()) {
    return apiClient.listSourcesWithChanges();
  }
  const db = getDb();
  return db.select().from(sources).where(
    and(
      sql`${sources.changeDetectedAt} IS NOT NULL`,
      notDisabled,
    )
  );
}
```

- [ ] **Step 5: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors. (Remote mode API client stubs may not exist yet — if type errors appear for `apiClient.listFeedSources` etc., add stub methods that throw `new Error("Not implemented")` in `src/api/client.ts`.)

- [ ] **Step 6: Commit**

```bash
git add src/db/queries.ts src/api/client.ts
git commit -m "feat: add query helpers for feed change detection"
```

---

### Task 4: Create `released poll` CLI Command

**Files:**
- Create: `src/cli/commands/poll.ts`
- Modify: `src/cli/program.ts`

- [ ] **Step 1: Create poll command**

Create `src/cli/commands/poll.ts`:

```typescript
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { findSourceBySlug, listFeedSources, setChangeDetected, listSourcesWithChanges } from "../../db/queries.js";
import { getSourceMeta, updateSourceMeta, headCheckFeed } from "../../adapters/feed.js";
import type { ChangeStatus } from "../../adapters/feed.js";
import { timeAgo } from "../../lib/dates.js";
import { logger } from "../../lib/logger.js";
import { stripAnsi } from "../../lib/sanitize.js";
import type { Source } from "../../db/schema.js";

interface PollResult {
  name: string;
  slug: string;
  feedUrl: string;
  status: ChangeStatus;
  responseMs: number;
  lastFetchedAt: string | null;
}

async function pollSource(source: Source): Promise<PollResult | null> {
  const meta = getSourceMeta(source);
  if (!meta.feedUrl) return null;

  const result = await headCheckFeed(meta.feedUrl, {
    etag: meta.feedEtag,
    lastModified: meta.feedLastModified,
    contentLength: meta.feedContentLength,
  });

  // Persist updated header values
  const metaUpdates: Record<string, string | undefined> = {};
  if (result.etag) metaUpdates.feedEtag = result.etag;
  if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
  if (result.contentLength) metaUpdates.feedContentLength = result.contentLength;
  if (Object.keys(metaUpdates).length > 0) {
    await updateSourceMeta(source, metaUpdates);
  }

  // Flag sources with detected changes (or unknown — conservative)
  if (result.status === "changed" || result.status === "unknown") {
    await setChangeDetected(source);
  }

  logger.debug(`Poll ${source.slug}: ${result.status} (${result.responseMs}ms)`);

  return {
    name: source.name,
    slug: source.slug,
    feedUrl: meta.feedUrl,
    status: result.status,
    responseMs: result.responseMs,
    lastFetchedAt: source.lastFetchedAt,
  };
}

function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case "changed": return chalk.yellow("changed");
    case "unchanged": return chalk.green("unchanged");
    case "unknown": return chalk.dim("unknown");
  }
}

export function registerPollCommand(program: Command) {
  program
    .command("poll [slug]")
    .description("Check feed sources for upstream changes via HEAD requests")
    .option("--json", "Output as JSON")
    .option("--changed", "Only show sources with detected changes")
    .addHelpText("after", `
Examples:
  released poll                      Poll all feed sources
  released poll my-source            Poll a specific source
  released poll --changed            Show only sources with changes
  released poll --json               Output as JSON`)
    .action(async (slug: string | undefined, opts: { json?: boolean; changed?: boolean }) => {
      let sourcesToPoll: Source[];

      if (slug) {
        const source = await findSourceBySlug(slug);
        if (!source) {
          console.error(`Source not found: ${slug}`);
          process.exit(1);
        }
        sourcesToPoll = [source];
      } else {
        sourcesToPoll = await listFeedSources();
        if (sourcesToPoll.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log("No feed sources found.");
          }
          return;
        }
      }

      // Run polls with concurrency limit of 5
      const CONCURRENCY = 5;
      const results: PollResult[] = [];
      for (let i = 0; i < sourcesToPoll.length; i += CONCURRENCY) {
        const batch = sourcesToPoll.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(pollSource));
        for (const r of batchResults) {
          if (r) results.push(r);
        }
      }

      // Filter to changed-only if requested
      const display = opts.changed
        ? results.filter((r) => r.status === "changed" || r.status === "unknown")
        : results;

      if (opts.json) {
        console.log(JSON.stringify(display, null, 2));
        return;
      }

      if (display.length === 0) {
        console.log("No changes detected.");
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan("Source"),
          chalk.cyan("Status"),
          chalk.cyan("Response"),
          chalk.cyan("Last Fetch"),
        ],
      });

      for (const r of display) {
        table.push([
          stripAnsi(r.name),
          statusLabel(r.status),
          chalk.dim(`${r.responseMs}ms`),
          r.lastFetchedAt ? timeAgo(r.lastFetchedAt) : chalk.dim("never"),
        ]);
      }

      console.log(table.toString());

      const changed = results.filter((r) => r.status === "changed").length;
      const unchanged = results.filter((r) => r.status === "unchanged").length;
      const unknown = results.filter((r) => r.status === "unknown").length;
      console.log(`\n${results.length} polled: ${chalk.yellow(`${changed} changed`)}, ${chalk.green(`${unchanged} unchanged`)}, ${chalk.dim(`${unknown} unknown`)}`);
    });
}
```

- [ ] **Step 2: Register in program.ts**

In `src/cli/program.ts`, add the import after the existing imports:

```typescript
import { registerPollCommand } from "./commands/poll.js";
```

Add the registration call after `registerTaskCommand(program);`:

```typescript
registerPollCommand(program);
```

Update the help text in `printStyledHelp()` — add after the `check` row:

```typescript
  lines.push(row("poll [slug]", "Poll feed sources for upstream changes"));
```

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Smoke test**

Run: `bun src/index.ts poll --help`
Expected: Help text showing poll command options.

Run: `bun src/index.ts poll`
Expected: Table output showing feed sources and their change status.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/poll.ts src/cli/program.ts
git commit -m "feat: add released poll command for feed change detection"
```

---

### Task 5: Integrate HEAD Pre-Check into Fetch Flow

**Files:**
- Modify: `src/adapters/feed.ts:258-330` (`fetchViaFeed` function)

- [ ] **Step 1: Add HEAD pre-check to `fetchViaFeed()`**

In `src/adapters/feed.ts`, inside `fetchViaFeed()`, add a HEAD pre-check block between the conditional headers setup (line ~298) and the `fetchAndParseFeed()` call (line ~302). Insert after line 298 (`if (meta.feedLastModified) conditionalHeaders["If-Modified-Since"] = meta.feedLastModified;`):

```typescript
  // HEAD pre-check: skip full fetch if feed hasn't changed
  const hasStoredHeaders = meta.feedEtag || meta.feedLastModified || meta.feedContentLength;
  if (hasStoredHeaders && !options?.full) {
    const headResult = await headCheckFeed(feedUrl, {
      etag: meta.feedEtag,
      lastModified: meta.feedLastModified,
      contentLength: meta.feedContentLength,
    });

    // Persist any new header values from HEAD response
    if (headResult.contentLength) metaUpdates.feedContentLength = headResult.contentLength;
    if (headResult.etag) metaUpdates.feedEtag = headResult.etag;
    if (headResult.lastModified) metaUpdates.feedLastModified = headResult.lastModified;

    if (headResult.status === "unchanged") {
      logger.info(`HEAD check: feed unchanged, skipping full fetch`);
      if (Object.keys(metaUpdates).length > 0) {
        await updateSourceMeta(source, metaUpdates);
      }
      return [];
    }

    logger.info(`HEAD check: ${headResult.status}, proceeding to full fetch`);
  }
```

- [ ] **Step 2: Clear `changeDetectedAt` on successful fetch**

In `src/cli/commands/fetch.ts`, after the `updateSource` call on the success path (line ~537-542 where `consecutiveNoChange` is reset to 0), add `changeDetectedAt: null` to the update:

```typescript
  await updateSource(source, {
    lastFetchedAt: new Date().toISOString(),
    consecutiveNoChange: 0,
    consecutiveErrors: 0,
    nextFetchAfter: null,
    changeDetectedAt: null,
  });
```

Also clear it on the no_change path (line ~381-385):

```typescript
  await updateSource(source, {
    consecutiveNoChange: newNoChange,
    consecutiveErrors: 0,
    nextFetchAfter: nextFetch,
    changeDetectedAt: null,
  });
```

- [ ] **Step 3: Store `feedContentLength` during full feed fetches**

In `src/adapters/feed.ts`, inside `fetchAndParseFeed()`, capture the content-length header alongside etag and lastModified (after line 223):

```typescript
  const contentLength = res.headers.get("content-length") ?? undefined;
```

Update the return type and return statement to include `contentLength`:

```typescript
): Promise<{ releases: RawRelease[]; etag?: string; lastModified?: string; contentLength?: string }> {
```

```typescript
  return { releases, etag, lastModified, contentLength };
```

In `fetchViaFeed()`, after the existing `if (etag)` and `if (lastModified)` lines (~325-326), add:

```typescript
  const { releases, etag, lastModified, contentLength } = await fetchAndParseFeed(...);
  // (update the existing destructure to include contentLength)
  if (contentLength) metaUpdates.feedContentLength = contentLength;
```

- [ ] **Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Smoke test the fetch pre-check**

Run: `bun src/index.ts fetch <a-slug-with-known-feed> --max 1 2>&1 | grep "HEAD check"`
Expected: Log line showing HEAD check result (changed/unchanged/unknown).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/feed.ts src/cli/commands/fetch.ts
git commit -m "feat: integrate HEAD pre-check into fetch flow"
```

---

### Task 6: Update Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (if CLI command reference exists)

- [ ] **Step 1: Add `poll` to CLAUDE.md CLI patterns**

In the "Common CLI Patterns" section of `CLAUDE.md`, add:

```bash
bun src/index.ts poll                   # Check all feed sources for upstream changes
bun src/index.ts poll --changed         # Show only sources with detected changes
bun src/index.ts poll --json            # Machine-readable output
```

- [ ] **Step 2: Document `changeDetectedAt` behavior**

In the "Conventions" section of `CLAUDE.md`, add a bullet:

```
- Feed change detection: `released poll` uses HTTP HEAD requests to flag sources with upstream changes (`changeDetectedAt` column). The `fetch` command uses HEAD as a pre-filter to skip unchanged feeds. Both are purely mechanical — no AI or content parsing.
```

- [ ] **Step 3: Update README.md if it has a CLI reference section**

Check if `README.md` lists CLI commands. If so, add `poll` to the list.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: add poll command and feed change detection to docs"
```
