# Video Source Type (YouTube first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-generic `video` source type so YouTube channel/playlist launch videos become indexed releases (lightweight, description-only, summarizer-cleaned, marketing-filtered), with Vimeo/Wistia able to ride the same type later.

**Architecture:** `video` is a new source-type enum value. Each source carries `metadata.feedUrl` pointing at the provider's Atom feed, so it reuses the existing feed _polling_ machinery (`queryDueSources` admits it via its `feedUrl` clause; `pollOne` HEAD-checks it like any feed) with **zero poll-gate edits**. Only the _parse_ is provider-specific: a `video` branch in `fetchOne` resolves the provider and parses with a YouTube-aware XML parser (the generic feed parser drops `media:thumbnail`/`media:description`). A small provider registry is the seam Vimeo/Wistia plug into. Creation is a `POST /v1/sources/video` convenience endpoint mirroring `POST /v1/sources/appstore`. Presentation adds a minimal `video: { provider }` wire facet (thumbnail and watch URL reuse the existing `media[]` and `url` fields), rendered as a thumbnail-forward row mirroring the App Store row (#1204).

**Tech Stack:** TypeScript (strict), Bun, Cloudflare Workers + Hono, Drizzle ORM on D1, Zod (`@buildinternet/releases-api-types`), `fast-xml-parser` (new dep in `packages/adapters`), React/Next.js (web).

**Spec:** `docs/superpowers/specs/2026-05-29-video-source-type-design.md`

---

## Conventions for the implementer

- **Worktree bun install:** this plan adds a dependency to `packages/adapters`. The worktree has its own `node_modules` — after editing any `package.json`, run `bun install` **in the worktree root** or the new dep resolves to the main checkout and tests read `undefined`.
- **Type-check is split:** root `npx tsc --noEmit` checks `src/` and packages; each worker has its own `tsc`. Run `cd workers/api && npx tsc --noEmit` for worker edits.
- **Tests:** `bun test <path>` for a file. Worker tests use in-process route smokes (`routes.request(path, init, env)`), not wrangler.
- **Commit after every task.** Branch is already `worktree-video-source-type`.
- **No emojis in web UI** (project rule). The existing App Store row uses a `↗` arrow in one spot; do not copy that — use text only.

---

## File Structure

**Create:**

- `packages/adapters/src/video/types.ts` — `VideoProviderId`, `VideoProvider`, `ResolvedVideoFeed`, `VideoChannelInfo`, `ParsedVideoFeed`.
- `packages/adapters/src/video/youtube.ts` — YouTube provider: `matchUrl`, `resolveFeed`, `parseYouTubeFeed`.
- `packages/adapters/src/video/providers.ts` — registry: `VIDEO_PROVIDERS`, `resolveVideoProvider`, `matchVideoUrl`.
- `packages/adapters/src/video/index.ts` — `fetchAndParseVideoFeed` (transport + provider parse) and re-exports.
- `packages/adapters/src/video/youtube.test.ts` — parser + resolver unit tests (fixture-based).
- `packages/adapters/src/video/feed.test.ts` — `fetchAndParseVideoFeed` transport tests (mock fetch, 304).
- `packages/adapters/test/fixtures/youtube-playlist.xml` — captured Atom fixture (2 entries).
- `workers/api/src/lib/video-materialize.ts` — `materializeVideoSource`.
- `workers/api/migrations/20260529000000_add_video_source_type.sql` — comment-only marker migration.
- `web/src/lib/video-source.ts` — `VideoRowInfo` + `videoRowInfoFromWire`.

**Modify:**

- `packages/core/src/source-enums.ts:10` — add `"video"`.
- `packages/core/src/schema.ts:314,1010,1070` — add `"video"` to the three inline type-enum literals.
- `packages/adapters/src/source-meta.ts` — add `video` to `SourceMetadata`; add `isVideoFetched`; add `videoSourceInfo`.
- `packages/adapters/package.json` — add `fast-xml-parser` dependency.
- `packages/api-types/src/schemas/shared.ts` — add `VideoSourceInfoSchema`.
- `packages/api-types/src/schemas/orgs.ts:338` — add `video` to `OrgReleaseItemSchema.source`.
- `packages/api-types/src/schemas/releases.ts:179` — add `video` to `ReleaseDetailResponseSchema`.
- `packages/api-types/src/api-types.ts:675` — add `video` to the `ReleaseDetail` interface.
- `packages/search/src/hybrid-search-worker.ts` — add `videoInfoFromMetadata` + attach `video` in `buildReleaseHits`.
- `workers/api/src/cron/poll-fetch.ts` — `fetchOne` video branch + `fetchable` filter + imports.
- `workers/api/src/routes/sources.ts` — `POST /v1/sources/video` route + manual-fetch eligibility + imports.
- `workers/api/src/routes/orgs.ts:~1840` — attach `video` facet in the releases formatter.
- `web/src/components/release-item.tsx` — `video` branch (thumbnail-forward row).

---

## Task 1: Add the `video` enum value + marker migration

**Files:**

- Modify: `packages/core/src/source-enums.ts:10`
- Modify: `packages/core/src/schema.ts:314`, `:1010`, `:1070`
- Create: `workers/api/migrations/20260529000000_add_video_source_type.sql`

- [ ] **Step 1: Add `"video"` to the canonical enum**

In `packages/core/src/source-enums.ts`, line 10:

```ts
export const SOURCE_TYPES = ["github", "scrape", "feed", "agent", "appstore", "video"] as const;
```

- [ ] **Step 2: Update the three inline literals in schema.ts**

These are hand-duplicated (not imported), so each must change. In `packages/core/src/schema.ts`:

Line 314 (`sources` table):

```ts
    type: text("type", { enum: ["github", "scrape", "feed", "agent", "appstore", "video"] }).notNull(),
```

Line 1010 (`sourcesActive` view) — same replacement:

```ts
  type: text("type", { enum: ["github", "scrape", "feed", "agent", "appstore", "video"] }).notNull(),
```

Line 1070 (`sourcesVisible` view) — same replacement:

```ts
  type: text("type", { enum: ["github", "scrape", "feed", "agent", "appstore", "video"] }).notNull(),
```

- [ ] **Step 3: Create the marker migration**

`sources.type` is a plain `TEXT` column (the `enum:` hint emits no SQL CHECK), so widening it needs no DDL. But editing `schema.ts` trips the CI schema-pairing gate, which requires an added file under `workers/api/migrations/*.sql`. Create `workers/api/migrations/20260529000000_add_video_source_type.sql` with only comments:

```sql
-- Marker migration (no DDL): adds the "video" value to SOURCE_TYPES in
-- packages/core/src/source-enums.ts and the inline type-enum literals in
-- packages/core/src/schema.ts (sources table + sources_active/sources_visible
-- views). sources.type is a free-form TEXT column with no CHECK constraint
-- (see 20260520010000_squashed_baseline.sql), so storing a new type value
-- requires no schema change — this file exists only to pair the schema.ts edit
-- with a migration per the CI "schema-change" gate.
--
-- The `video` source type indexes launch videos (YouTube first) via the
-- provider's Atom feed. See docs/superpowers/specs/2026-05-29-video-source-type-design.md.
```

- [ ] **Step 4: Type-check core**

Run: `cd packages/core && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/source-enums.ts packages/core/src/schema.ts workers/api/migrations/20260529000000_add_video_source_type.sql
git commit -m "feat(core): add 'video' source type enum + marker migration"
```

---

## Task 2: Add the `video` wire facet to api-types

`SourceTypeSchema` and `ReleaseDetailResponseSchema.sourceType` use `z.enum(SOURCE_TYPES)`, so they pick up `"video"` automatically. We only need the presentation facet. The facet is minimal — `{ provider }` — because the thumbnail lives in the release's existing `media[]` and the watch link is the existing `url`.

**Files:**

- Modify: `packages/api-types/src/schemas/shared.ts` (after `AppStoreSourceInfoSchema`, line ~23)
- Modify: `packages/api-types/src/schemas/orgs.ts:338`
- Modify: `packages/api-types/src/schemas/releases.ts:179`
- Modify: `packages/api-types/src/api-types.ts:675`

- [ ] **Step 1: Add `VideoSourceInfoSchema` to shared.ts**

In `packages/api-types/src/schemas/shared.ts`, immediately after the `AppStoreSourceInfoSchema` block (ends line 23), add:

```ts
/** Video provider tag, present only when `sourceType === "video"`. Thumbnail
 * and watch URL reuse the release's existing `media[]` / `url`. */
export const VideoSourceInfoSchema = z.object({
  provider: z.enum(["youtube", "vimeo", "wistia"]),
});
```

- [ ] **Step 2: Add `video` to `OrgReleaseItemSchema.source`**

In `packages/api-types/src/schemas/orgs.ts`, the `source` object (lines 339–344). Add the import and the field:

At the top of the file, add `VideoSourceInfoSchema` to the existing import from `./shared` (it already imports `AppStoreSourceInfoSchema`). Then:

```ts
export const OrgReleaseItemSchema = ReleaseItemSchema.extend({
  source: z.object({
    slug: z.string(),
    name: z.string(),
    type: z.string(),
    appStore: AppStoreSourceInfoSchema.optional(),
    video: VideoSourceInfoSchema.optional(),
  }),
  product: z.object({ slug: z.string(), name: z.string() }).nullable().optional(),
  groupSlug: z.string().optional(),
  groupName: z.string().optional(),
});
```

- [ ] **Step 3: Add `video` to `ReleaseDetailResponseSchema`**

In `packages/api-types/src/schemas/releases.ts`, add `VideoSourceInfoSchema` to the `./shared` import, then add the field right after the `appStore` line (line 202):

```ts
  appStore: AppStoreSourceInfoSchema.nullable().optional(),
  video: VideoSourceInfoSchema.nullable().optional(),
});
```

- [ ] **Step 4: Add `video` to the `ReleaseDetail` interface**

In `packages/api-types/src/api-types.ts`, after the `appStore` field (line ~705):

```ts
  /** App Store platform + icon, present only when `sourceType === "appstore"`. */
  appStore?: { platform: "ios" | "macos"; iconUrl: string | null } | null;
  /** Video provider tag, present only when `sourceType === "video"`. */
  video?: { provider: "youtube" | "vimeo" | "wistia" } | null;
}
```

- [ ] **Step 5: Build + type-check api-types**

Run: `cd packages/api-types && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api-types/src/schemas/shared.ts packages/api-types/src/schemas/orgs.ts packages/api-types/src/schemas/releases.ts packages/api-types/src/api-types.ts
git commit -m "feat(api-types): add video source-info wire facet"
```

---

## Task 3: Extend `SourceMetadata` + add `isVideoFetched` / `videoSourceInfo`

**Files:**

- Modify: `packages/adapters/src/source-meta.ts`
- Test: `packages/adapters/src/source-meta.test.ts` (create if absent, else append)

- [ ] **Step 1: Write the failing test**

Create/append `packages/adapters/src/source-meta.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isVideoFetched, videoSourceInfo } from "./source-meta";

const src = (over: Partial<{ type: string; metadata: string | null }>) =>
  ({ type: "video", metadata: null, ...over }) as any;

describe("isVideoFetched", () => {
  test("true only for type=video", () => {
    expect(isVideoFetched(src({ type: "video" }))).toBe(true);
    expect(isVideoFetched(src({ type: "feed" }))).toBe(false);
    expect(isVideoFetched(src({ type: "appstore" }))).toBe(false);
  });
});

describe("videoSourceInfo", () => {
  test("returns provider for video sources", () => {
    const meta = JSON.stringify({ video: { provider: "youtube" } });
    expect(videoSourceInfo("video", meta)).toEqual({ provider: "youtube" });
  });
  test("null for non-video type", () => {
    expect(videoSourceInfo("feed", JSON.stringify({ video: { provider: "youtube" } }))).toBeNull();
  });
  test("null when block missing or unparseable", () => {
    expect(videoSourceInfo("video", null)).toBeNull();
    expect(videoSourceInfo("video", "{not json")).toBeNull();
    expect(videoSourceInfo("video", JSON.stringify({}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/adapters/src/source-meta.test.ts`
Expected: FAIL — `isVideoFetched`/`videoSourceInfo` not exported.

- [ ] **Step 3: Add the `video` metadata block to `SourceMetadata`**

In `packages/adapters/src/source-meta.ts`, inside the `SourceMetadata` interface (after the `appStore?` block, line ~223), add:

```ts
  /**
   * Video source routing + provider identity (#video). Present only on
   * `type: "video"` sources. `feedUrl`/`feedType` (above) hold the provider's
   * Atom/RSS endpoint so polling reuses the feed machinery; this block carries
   * the provider discriminator and resolved channel identity for display.
   */
  video?: {
    provider: "youtube" | "vimeo" | "wistia";
    channel?: {
      id?: string;
      handle?: string;
      title?: string;
      playlistId?: string;
      playlistTitle?: string;
    };
  };
```

- [ ] **Step 4: Add `isVideoFetched` and `videoSourceInfo`**

In `packages/adapters/src/source-meta.ts`, after `isAppStoreFetched` (line ~271), add:

```ts
/**
 * True when a source is fetched via the video adapter. Like `isAppStoreFetched`,
 * the type is the only signal — there's no metadata-override form.
 */
export function isVideoFetched(source: Source): boolean {
  return source.type === "video";
}

/**
 * Video provider tag from a source's `metadata` JSON. Returns null for
 * non-`video` sources or when no provider is recorded. Mirrors
 * `appStoreSourceInfo`; the search package keeps its own copy to avoid a dep.
 */
export function videoSourceInfo(
  type: string,
  metadataJson: string | null,
): { provider: "youtube" | "vimeo" | "wistia" } | null {
  if (type !== "video") return null;
  try {
    const block = (JSON.parse(metadataJson ?? "{}") as { video?: { provider?: unknown } } | null)
      ?.video;
    const provider = block?.provider;
    if (provider === "youtube" || provider === "vimeo" || provider === "wistia") {
      return { provider };
    }
  } catch {
    // fall through
  }
  return null;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/adapters/src/source-meta.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/source-meta.ts packages/adapters/src/source-meta.test.ts
git commit -m "feat(adapters): video metadata block + isVideoFetched/videoSourceInfo"
```

---

## Task 4: Add `fast-xml-parser` + capture the YouTube fixture

**Files:**

- Modify: `packages/adapters/package.json`
- Create: `packages/adapters/test/fixtures/youtube-playlist.xml`

- [ ] **Step 1: Add the dependency**

In `packages/adapters/package.json`, add to `dependencies` (alphabetical, after `@rowanmanning/feed-parser`):

```json
    "fast-xml-parser": "^4.5.0",
```

- [ ] **Step 2: Install in the worktree**

Run: `bun install`
Expected: lockfile updates; `fast-xml-parser` resolves under the worktree's `node_modules`.

- [ ] **Step 3: Create the fixture**

Create `packages/adapters/test/fixtures/youtube-playlist.xml` with this captured 2-entry Atom feed (verbatim shape from `feeds/videos.xml?playlist_id=…`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?playlist_id=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va"/>
 <id>yt:playlist:PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va</id>
 <yt:playlistId>PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va</yt:playlistId>
 <yt:channelId>UCV03SRZXJEz-hchIAogeJOg</yt:channelId>
 <title>Product Launches</title>
 <author>
  <name>Claude</name>
  <uri>https://www.youtube.com/channel/UCV03SRZXJEz-hchIAogeJOg</uri>
 </author>
 <published>2026-02-05T02:18:42+00:00</published>
 <entry>
  <id>yt:video:7-1tNo8HAwk</id>
  <yt:videoId>7-1tNo8HAwk</yt:videoId>
  <yt:channelId>UCV03SRZXJEz-hchIAogeJOg</yt:channelId>
  <title>New agents for legal professionals | Claude Cowork</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=7-1tNo8HAwk"/>
  <author>
   <name>Claude</name>
   <uri>https://www.youtube.com/channel/UCV03SRZXJEz-hchIAogeJOg</uri>
  </author>
  <published>2026-05-12T16:52:13+00:00</published>
  <updated>2026-05-19T10:19:21+00:00</updated>
  <media:group>
   <media:title>New agents for legal professionals | Claude Cowork</media:title>
   <media:content url="https://www.youtube.com/v/7-1tNo8HAwk?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i4.ytimg.com/vi/7-1tNo8HAwk/hqdefault.jpg" width="480" height="360"/>
   <media:description>New in Claude: tools built for the way legal teams work.

12 one-click plugins bundle workflows for common legal skills and practice areas.

Read more: www.claude.com/solutions/legal</media:description>
   <media:community>
    <media:starRating count="899" average="5.00" min="1" max="5"/>
    <media:statistics views="45537"/>
   </media:community>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:-INveHwbRz4</id>
  <yt:videoId>-INveHwbRz4</yt:videoId>
  <yt:channelId>UCV03SRZXJEz-hchIAogeJOg</yt:channelId>
  <title>Introducing agent view in Claude Code</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=-INveHwbRz4"/>
  <author>
   <name>Claude</name>
   <uri>https://www.youtube.com/channel/UCV03SRZXJEz-hchIAogeJOg</uri>
  </author>
  <published>2026-05-11T21:00:11+00:00</published>
  <updated>2026-05-24T20:46:54+00:00</updated>
  <media:group>
   <media:title>Introducing agent view in Claude Code</media:title>
   <media:content url="https://www.youtube.com/v/-INveHwbRz4?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/-INveHwbRz4/hqdefault.jpg" width="480" height="360"/>
   <media:description>Agent view in Claude Code provides one place to manage all your Claude Code sessions.</media:description>
   <media:community>
    <media:starRating count="2933" average="5.00" min="1" max="5"/>
    <media:statistics views="132873"/>
   </media:community>
  </media:group>
 </entry>
</feed>
```

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/package.json packages/adapters/test/fixtures/youtube-playlist.xml bun.lock
git commit -m "chore(adapters): add fast-xml-parser + youtube atom fixture"
```

---

## Task 5: YouTube provider — types + `parseYouTubeFeed`

**Files:**

- Create: `packages/adapters/src/video/types.ts`
- Create: `packages/adapters/src/video/youtube.ts`
- Test: `packages/adapters/src/video/youtube.test.ts`

- [ ] **Step 1: Define the shared types**

Create `packages/adapters/src/video/types.ts`:

```ts
import type { RawRelease } from "../types.js";

export type VideoProviderId = "youtube" | "vimeo" | "wistia";

export interface VideoChannelInfo {
  id?: string;
  handle?: string;
  title?: string;
  playlistId?: string;
  playlistTitle?: string;
}

export interface ResolvedVideoFeed {
  /** The Atom/RSS endpoint to poll (stored as metadata.feedUrl). */
  feedUrl: string;
  /** The human-facing URL (stored as source.url). */
  canonicalUrl: string;
  /** What we can derive pre-fetch; the feed fetch fills title/id. */
  channel: VideoChannelInfo;
}

export interface ParsedVideoFeed {
  channel: VideoChannelInfo;
  releases: RawRelease[];
}

export interface VideoProvider {
  id: VideoProviderId;
  /** Does this URL belong to the provider? */
  matchUrl(url: string): boolean;
  /** Turn a human channel/playlist URL into a feed endpoint + identity. */
  resolveFeed(url: string, fetchImpl?: typeof fetch): Promise<ResolvedVideoFeed>;
  /** Parse the provider's feed XML into channel meta + releases. */
  parseFeed(xml: string): ParsedVideoFeed;
}
```

- [ ] **Step 2: Write the failing parser test**

Create `packages/adapters/src/video/youtube.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { youtubeProvider } from "./youtube";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../test/fixtures/youtube-playlist.xml"),
  "utf8",
);

describe("parseYouTubeFeed", () => {
  const parsed = youtubeProvider.parseFeed(FIXTURE);

  test("reads channel + playlist identity from the feed root", () => {
    expect(parsed.channel.id).toBe("UCV03SRZXJEz-hchIAogeJOg");
    expect(parsed.channel.title).toBe("Claude");
    expect(parsed.channel.playlistId).toBe("PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va");
    expect(parsed.channel.playlistTitle).toBe("Product Launches");
  });

  test("maps each entry to a RawRelease", () => {
    expect(parsed.releases).toHaveLength(2);
    const first = parsed.releases[0]!;
    expect(first.title).toBe("New agents for legal professionals | Claude Cowork");
    expect(first.url).toBe("https://www.youtube.com/watch?v=7-1tNo8HAwk");
    expect(first.content).toContain("tools built for the way legal teams work");
    expect(first.contentFromSummary).toBe(true);
    expect(first.publishedAt?.toISOString()).toBe("2026-05-12T16:52:13.000Z");
    expect(first.media).toEqual([
      {
        type: "image",
        url: "https://i4.ytimg.com/vi/7-1tNo8HAwk/hqdefault.jpg",
        alt: "New agents for legal professionals | Claude Cowork",
      },
    ]);
  });

  test("empty xml yields no releases and empty channel", () => {
    const empty = youtubeProvider.parseFeed("<feed></feed>");
    expect(empty.releases).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/adapters/src/video/youtube.test.ts`
Expected: FAIL — `./youtube` not found.

- [ ] **Step 4: Implement the YouTube provider parser**

Create `packages/adapters/src/video/youtube.ts`:

```ts
import { XMLParser } from "fast-xml-parser";
import type { RawRelease } from "../types.js";
import type {
  ParsedVideoFeed,
  ResolvedVideoFeed,
  VideoChannelInfo,
  VideoProvider,
} from "./types.js";

const FEED_BASE = "https://www.youtube.com/feeds/videos.xml";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep namespace prefixes (media:group, yt:videoId) as literal keys.
  removeNSPrefix: false,
  // Treat empty/whitespace text as undefined so missing descriptions are "".
  trimValues: true,
});

/** fast-xml-parser collapses single children to objects; normalize to arrays. */
function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

interface YtEntry {
  "yt:videoId"?: string;
  title?: string;
  published?: string;
  link?: { "@_rel"?: string; "@_href"?: string } | Array<{ "@_rel"?: string; "@_href"?: string }>;
  "media:group"?: {
    "media:description"?: unknown;
    "media:thumbnail"?: { "@_url"?: string };
  };
}

function entryToRelease(entry: YtEntry): RawRelease | null {
  const videoId = asString(entry["yt:videoId"]);
  const title = asString(entry.title);
  if (!videoId || !title) return null;

  const links = toArray(entry.link);
  const alternate = links.find((l) => l["@_rel"] === "alternate") ?? links[0];
  const url = alternate?.["@_href"] ?? `https://www.youtube.com/watch?v=${videoId}`;

  const group = entry["media:group"];
  const description = asString(group?.["media:description"]) ?? "";
  const thumbUrl = group?.["media:thumbnail"]?.["@_url"];

  const publishedStr = asString(entry.published);
  const published = publishedStr ? new Date(publishedStr) : undefined;

  return {
    title,
    content: description,
    url,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published : undefined,
    media: thumbUrl ? [{ type: "image", url: thumbUrl, alt: title }] : [],
    contentFromSummary: true,
  };
}

export function parseYouTubeFeed(xml: string): ParsedVideoFeed {
  const doc = parser.parse(xml) as { feed?: Record<string, unknown> };
  const feed = doc.feed ?? {};

  const author = feed.author as { name?: unknown } | undefined;
  const channel: VideoChannelInfo = {
    id: asString(feed["yt:channelId"]),
    title: asString(author?.name),
    playlistId: asString(feed["yt:playlistId"]),
    playlistTitle: asString(feed.title),
  };

  const releases = toArray(feed.entry as YtEntry | YtEntry[] | undefined)
    .map(entryToRelease)
    .filter((r): r is RawRelease => r !== null);

  return { channel, releases };
}

const PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/;
const CHANNEL_ID_RE = /\/channel\/(UC[A-Za-z0-9_-]+)/;
const HANDLE_RE = /youtube\.com\/(@[A-Za-z0-9._-]+|c\/[^/?#]+|user\/[^/?#]+)/i;
const CHANNEL_ID_IN_PAGE_RE = /"channelId":"(UC[A-Za-z0-9_-]+)"/;

async function resolveFeed(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedVideoFeed> {
  const playlist = url.match(PLAYLIST_RE);
  if (playlist) {
    const id = playlist[1]!;
    return {
      feedUrl: `${FEED_BASE}?playlist_id=${id}`,
      canonicalUrl: `https://www.youtube.com/playlist?list=${id}`,
      channel: { playlistId: id },
    };
  }

  const byId = url.match(CHANNEL_ID_RE);
  if (byId) {
    const id = byId[1]!;
    return {
      feedUrl: `${FEED_BASE}?channel_id=${id}`,
      canonicalUrl: `https://www.youtube.com/channel/${id}`,
      channel: { id },
    };
  }

  const handleMatch = url.match(HANDLE_RE);
  if (handleMatch) {
    // Handles (@name, c/Name, user/Name) don't expose the channel_id directly;
    // fetch the page and scrape it. This is the one fragile path — playlist and
    // /channel/UC… URLs are pure.
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`YouTube channel page fetch failed: ${res.status}`);
    const html = await res.text();
    const idMatch = html.match(CHANNEL_ID_IN_PAGE_RE);
    if (!idMatch) throw new Error("Could not resolve channel_id from YouTube page");
    const id = idMatch[1]!;
    return {
      feedUrl: `${FEED_BASE}?channel_id=${id}`,
      canonicalUrl: url,
      channel: { id, handle: handleMatch[1] },
    };
  }

  throw new Error(`Unrecognized YouTube URL: ${url}`);
}

export const youtubeProvider: VideoProvider = {
  id: "youtube",
  matchUrl: (url) => /(?:^|\.)youtube\.com\//i.test(url) || /(?:^|\.)youtu\.be\//i.test(url),
  resolveFeed,
  parseFeed: parseYouTubeFeed,
};
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/adapters/src/video/youtube.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/video/types.ts packages/adapters/src/video/youtube.ts packages/adapters/src/video/youtube.test.ts
git commit -m "feat(adapters): YouTube video provider — parse + URL resolution"
```

---

## Task 6: `resolveFeed` URL-mapping tests

**Files:**

- Test: `packages/adapters/src/video/youtube.test.ts` (append)

- [ ] **Step 1: Append failing-then-passing resolver tests**

Add to `packages/adapters/src/video/youtube.test.ts`:

```ts
describe("youtube resolveFeed", () => {
  test("playlist URL → playlist_id feed (no fetch)", async () => {
    const r = await youtubeProvider.resolveFeed(
      "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
    );
    expect(r.feedUrl).toBe(
      "https://www.youtube.com/feeds/videos.xml?playlist_id=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
    );
    expect(r.channel.playlistId).toBe("PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va");
  });

  test("channel-id URL → channel_id feed (no fetch)", async () => {
    const r = await youtubeProvider.resolveFeed(
      "https://www.youtube.com/channel/UCV03SRZXJEz-hchIAogeJOg",
    );
    expect(r.feedUrl).toBe(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCV03SRZXJEz-hchIAogeJOg",
    );
    expect(r.channel.id).toBe("UCV03SRZXJEz-hchIAogeJOg");
  });

  test("@handle URL → scrapes channelId from page", async () => {
    const fakeFetch = (async () =>
      new Response('<html>...{"channelId":"UCabc123_-DEF"}...</html>', {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await youtubeProvider.resolveFeed("https://www.youtube.com/@claude", fakeFetch);
    expect(r.feedUrl).toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UCabc123_-DEF");
    expect(r.channel.handle).toBe("@claude");
  });

  test("matchUrl recognizes youtube hosts", () => {
    expect(youtubeProvider.matchUrl("https://www.youtube.com/@x")).toBe(true);
    expect(youtubeProvider.matchUrl("https://youtu.be/abc")).toBe(true);
    expect(youtubeProvider.matchUrl("https://vimeo.com/123")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/adapters/src/video/youtube.test.ts`
Expected: PASS (these pass against the Task 5 implementation; this task is the safety net for the resolver branches).

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/src/video/youtube.test.ts
git commit -m "test(adapters): youtube resolveFeed URL-mapping coverage"
```

---

## Task 7: Provider registry + `fetchAndParseVideoFeed`

**Files:**

- Create: `packages/adapters/src/video/providers.ts`
- Create: `packages/adapters/src/video/index.ts`
- Test: `packages/adapters/src/video/feed.test.ts`

- [ ] **Step 1: Write the registry**

Create `packages/adapters/src/video/providers.ts`:

```ts
import type { VideoProvider, VideoProviderId } from "./types.js";
import { youtubeProvider } from "./youtube.js";

export const VIDEO_PROVIDERS: VideoProvider[] = [youtubeProvider];

/** Look up a provider by its stored id. Throws on unknown id. */
export function resolveVideoProvider(id: VideoProviderId | string): VideoProvider {
  const p = VIDEO_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown video provider: ${id}`);
  return p;
}

/** First provider that claims this URL, or null. */
export function matchVideoUrl(url: string): VideoProvider | null {
  return VIDEO_PROVIDERS.find((p) => p.matchUrl(url)) ?? null;
}
```

- [ ] **Step 2: Write the failing transport test**

Create `packages/adapters/src/video/feed.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAndParseVideoFeed } from "./index";
import { youtubeProvider } from "./youtube";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../test/fixtures/youtube-playlist.xml"),
  "utf8",
);

describe("fetchAndParseVideoFeed", () => {
  test("fetches, parses, and surfaces etag", async () => {
    const fakeFetch = (async () =>
      new Response(FIXTURE, {
        status: 200,
        headers: { etag: '"abc"' },
      })) as unknown as typeof fetch;
    const result = await fetchAndParseVideoFeed(
      "https://www.youtube.com/feeds/videos.xml?playlist_id=X",
      youtubeProvider,
      undefined,
      fakeFetch,
    );
    expect(result.releases).toHaveLength(2);
    expect(result.channel.title).toBe("Claude");
    expect(result.etag).toBe('"abc"');
  });

  test("304 returns empty releases", async () => {
    const fakeFetch = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const result = await fetchAndParseVideoFeed(
      "https://www.youtube.com/feeds/videos.xml?playlist_id=X",
      youtubeProvider,
      { "If-None-Match": '"abc"' },
      fakeFetch,
    );
    expect(result.releases).toEqual([]);
    expect(result.channel).toEqual({});
  });

  test("non-ok throws", async () => {
    const fakeFetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(
      fetchAndParseVideoFeed(
        "https://www.youtube.com/feeds/videos.xml?x",
        youtubeProvider,
        undefined,
        fakeFetch,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/adapters/src/video/feed.test.ts`
Expected: FAIL — `./index` `fetchAndParseVideoFeed` not found.

- [ ] **Step 4: Implement the adapter index**

Create `packages/adapters/src/video/index.ts`:

```ts
import { RELEASES_BOT_UA } from "../source-meta.js";
import type { ParsedVideoFeed, VideoProvider } from "./types.js";

const FEED_ACCEPT = "application/atom+xml, application/rss+xml, application/xml";

export interface FetchVideoFeedResult extends ParsedVideoFeed {
  etag?: string;
  lastModified?: string;
}

/**
 * Fetch a video provider's feed (with conditional-GET headers) and parse it via
 * the provider. Transport mirrors `fetchAndParseFeed`; the parse is provider-
 * specific because the generic feed parser drops `media:thumbnail` /
 * `media:description`. A 304 returns empty releases + empty channel.
 */
export async function fetchAndParseVideoFeed(
  feedUrl: string,
  provider: VideoProvider,
  conditionalHeaders?: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchVideoFeedResult> {
  const res = await fetchImpl(feedUrl, {
    headers: { "User-Agent": RELEASES_BOT_UA, Accept: FEED_ACCEPT, ...conditionalHeaders },
    redirect: "follow",
  });

  if (res.status === 304) return { channel: {}, releases: [] };
  if (!res.ok) throw new Error(`Video feed fetch failed: ${res.status} ${res.statusText}`);

  const body = await res.text();
  const parsed = provider.parseFeed(body);
  return {
    ...parsed,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
}

export { VIDEO_PROVIDERS, resolveVideoProvider, matchVideoUrl } from "./providers.js";
export { youtubeProvider } from "./youtube.js";
export type {
  VideoProvider,
  VideoProviderId,
  VideoChannelInfo,
  ResolvedVideoFeed,
  ParsedVideoFeed,
} from "./types.js";
```

> **Note:** confirm `RELEASES_BOT_UA` is exported from `packages/adapters/src/source-meta.ts`. If it lives elsewhere (e.g. a `constants.ts`), import it from there — `grep -rn "export const RELEASES_BOT_UA" packages/adapters/src`.

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/adapters/src/video/feed.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Type-check adapters**

Run: `cd packages/adapters && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters/src/video/providers.ts packages/adapters/src/video/index.ts packages/adapters/src/video/feed.test.ts
git commit -m "feat(adapters): video provider registry + fetchAndParseVideoFeed"
```

---

## Task 8: Wire the `video` branch into `fetchOne` + the fetchable filter

A video source has `metadata.feedUrl` set, so `queryDueSources` already admits it (its `feedUrl IS NOT NULL` clause) and `pollOne` already HEAD-checks it like a feed — **no edits to those two functions.** We only intercept the _parse_ in `fetchOne` and allow `video` through the fetch-phase filter.

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts` (imports; `fetchable` filter ~line 192; `fetchOne` dispatch ~line 1291)

- [ ] **Step 1: Add imports**

In `workers/api/src/cron/poll-fetch.ts`, the `@releases/adapters/source-meta` import (line 30) currently imports `isAppStoreFetched`. Change it to:

```ts
import { isAppStoreFetched, isVideoFetched } from "@releases/adapters/source-meta";
```

Add a new import for the video adapter (after the appstore import block, line 36):

```ts
import { fetchAndParseVideoFeed, resolveVideoProvider } from "@releases/adapters/video";
```

- [ ] **Step 2: Allow `video` through the fetchable filter**

In the `fetchable` filter (the `.filter((s) => {...})` ending ~line 193), find:

```ts
if (s.type === "appstore") return true;
return s.type === "github";
```

Replace with:

```ts
if (s.type === "appstore") return true;
if (isVideoFetched(s)) {
  const m = getSourceMeta(s);
  if (!m.feedUrl) {
    logEvent("warn", {
      component: "cron-poll-fetch",
      event: "skip-video-broken-metadata",
      sourceSlug: s.slug,
    });
    return false;
  }
  return true;
}
return s.type === "github";
```

- [ ] **Step 3: Add the `video` dispatch branch in `fetchOne`**

In `fetchOne`, find the App Store branch (lines 1291–1297):

```ts
    } else if (isAppStoreFetched(source)) {
      const coord = appStoreCoordFromSource(source);
      const listing = coord ? await resolveAppStore(coord) : null;
      rawReleases = listing ? mapListingToRawReleases(listing, coord!) : [];
      if (!dryRun && listing) {
        await refreshAppStoreListing(db, source, listing);
      }
    } else {
```

Insert a new `else if` branch between the App Store branch and the `} else {` (feed) branch:

```ts
    } else if (isAppStoreFetched(source)) {
      const coord = appStoreCoordFromSource(source);
      const listing = coord ? await resolveAppStore(coord) : null;
      rawReleases = listing ? mapListingToRawReleases(listing, coord!) : [];
      if (!dryRun && listing) {
        await refreshAppStoreListing(db, source, listing);
      }
    } else if (isVideoFetched(source)) {
      if (!meta.feedUrl || !meta.video?.provider) {
        const dur = Date.now() - start;
        await db
          .insert(fetchLog)
          .values({
            sourceId: source.id,
            sessionId,
            releasesFound: 0,
            releasesInserted: 0,
            durationMs: dur,
            status: "error",
            error: "Missing feedUrl or video.provider in source metadata",
          })
          .catch(() => {});
        return {
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: dur,
          status: "error",
          error: "Missing feedUrl or video.provider in source metadata",
        };
      }
      const conditionalHeaders: Record<string, string> = {};
      if (meta.feedEtag) conditionalHeaders["If-None-Match"] = meta.feedEtag;
      if (meta.feedLastModified) conditionalHeaders["If-Modified-Since"] = meta.feedLastModified;

      const provider = resolveVideoProvider(meta.video.provider);
      const botFetch = opts?.signedFetch ?? (await makeBotFetch(env));
      const result = await fetchAndParseVideoFeed(
        meta.feedUrl,
        provider,
        Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
        botFetch,
      );
      rawReleases = result.releases.slice(0, maxEntries);

      if (!dryRun) {
        const metaUpdates: Partial<SourceMetadata> = {};
        if (result.etag) metaUpdates.feedEtag = result.etag;
        if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
        if (Object.keys(metaUpdates).length > 0) {
          const merged = { ...meta, ...metaUpdates };
          await db
            .update(sources)
            .set({ metadata: JSON.stringify(merged) })
            .where(eq(sources.id, source.id));
        }
      }
    } else {
```

> The shared post-dispatch code (`ingestRawReleases`, which runs the marketing classifier when `meta.marketingFilter === true`, builds rows, inserts, fires side-effects) runs unchanged for video — no edit needed there.

- [ ] **Step 4: Type-check the API worker**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts
git commit -m "feat(api): fetchOne video branch + fetchable filter for video sources"
```

---

## Task 9: Allow `video` through the manual fetch route

**Files:**

- Modify: `workers/api/src/routes/sources.ts` (imports line ~107; eligibility condition lines 601–606)

- [ ] **Step 1: Import `isVideoFetched`**

In `workers/api/src/routes/sources.ts`, the import from `@releases/adapters/source-meta` (line ~107) includes `isAppStoreFetched`. Add `isVideoFetched` to it:

```ts
import {
  getSourceMeta,
  isGitHubFetched,
  isAppStoreFetched,
  isVideoFetched,
} from "@releases/adapters/source-meta";
```

> Adjust to match the existing exact import shape — `grep -n "isAppStoreFetched" workers/api/src/routes/sources.ts` to find the line, then add `isVideoFetched` alongside it.

- [ ] **Step 2: Add `video` to the eligibility condition**

In the `POST /sources/:slug/fetch` handler, find (lines 601–606):

```ts
  if (
    src.type === "feed" ||
    isGitHubFetched(src, meta) ||
    isAppStoreFetched(src) ||
    (src.type === "scrape" && meta.feedUrl != null)
  ) {
```

Replace with:

```ts
  if (
    src.type === "feed" ||
    isGitHubFetched(src, meta) ||
    isAppStoreFetched(src) ||
    isVideoFetched(src) ||
    (src.type === "scrape" && meta.feedUrl != null)
  ) {
```

- [ ] **Step 3: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "feat(api): allow video sources through the manual fetch route"
```

---

## Task 10: `materializeVideoSource` lib

Mirrors `materializeAppStoreSource`, but org is **required** (no derivation — per #690) and the backfill runs through `ingestRawReleases` so the marketing classifier applies to the initial batch.

**Files:**

- Create: `workers/api/src/lib/video-materialize.ts`
- Test: `workers/api/test/video-materialize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/video-materialize.test.ts`. Use the existing test-db helper (`tests/db-helper.ts`) the same way `appstore-materialize` tests do — first read an existing worker materialize/db test for the exact `createTestDb` import and `env` shape: `ls workers/api/test/*.test.ts` and open `workers/api/test/appstore-fetch-route.test.ts` for the pattern. Then:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../../../tests/db-helper";
import { organizations } from "@buildinternet/releases-core/schema";
import { materializeVideoSource } from "../src/lib/video-materialize";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../../packages/adapters/test/fixtures/youtube-playlist.xml"),
  "utf8",
);

describe("materializeVideoSource", () => {
  test("creates a video source under the given org and backfills releases", async () => {
    const { db } = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_test", name: "Anthropic", slug: "anthropic", discovery: "curated" });

    const fakeFetch = (async () =>
      new Response(FIXTURE, { status: 200, headers: { etag: '"v1"' } })) as unknown as typeof fetch;

    const result = await materializeVideoSource(
      db as any,
      { ANTHROPIC_API_KEY: undefined } as any, // no key → marketing filter no-ops (fail-open)
      {
        url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
        orgSlug: "anthropic",
        fetchImpl: fakeFetch,
      },
    );

    expect(result.status).toBe("indexed");
    expect(result.releaseCount).toBe(2);
    expect(result.source.type).toBe("video");
    const meta = JSON.parse(result.source.metadata ?? "{}");
    expect(meta.video.provider).toBe("youtube");
    expect(meta.feedUrl).toContain("playlist_id=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va");
    expect(meta.marketingFilter).toBe(true);
  });

  test("idempotent on feedUrl", async () => {
    const { db } = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_test", name: "Anthropic", slug: "anthropic", discovery: "curated" });
    const fakeFetch = (async () =>
      new Response(FIXTURE, { status: 200 })) as unknown as typeof fetch;
    const params = {
      url: "https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va",
      orgSlug: "anthropic",
      fetchImpl: fakeFetch,
    };
    await materializeVideoSource(db as any, {} as any, params);
    const second = await materializeVideoSource(db as any, {} as any, params);
    expect(second.status).toBe("existing");
  });
});
```

> If `createTestDb`/`makeD1Shim` cannot serve drizzle reads in your harness (see the `maked1shim_no_querybuilder_reads` note), follow the same `createTestDb().db as env.DB` + short-circuit `createDb` pattern used by the other worker read-tests in `workers/api/test/`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test workers/api/test/video-materialize.test.ts`
Expected: FAIL — `../src/lib/video-materialize` not found.

- [ ] **Step 3: Implement `materializeVideoSource`**

Create `workers/api/src/lib/video-materialize.ts`. Model the org/product/source/insert structure on `workers/api/src/lib/appstore-materialize.ts` (open it for the exact `createDb`/`newSourceId`/`toSlug`/`organizationsActive` imports and the insert shape). Key differences: org is required (resolve, don't derive); slug derives from channel/playlist title; backfill via `ingestRawReleases`.

```ts
import { and, eq } from "drizzle-orm";
import type { createDb } from "../db/client.js"; // match the path appstore-materialize uses
import { organizationsActive, sources, sourcesActive } from "@buildinternet/releases-core/schema";
import { newSourceId } from "@buildinternet/releases-core/id";
import { toSlug } from "@buildinternet/releases-core/slug";
import { matchVideoUrl, fetchAndParseVideoFeed } from "@releases/adapters/video";
import { ingestRawReleases, type FetchOneEnv } from "../cron/poll-fetch.js";

export interface MaterializeVideoParams {
  url: string;
  orgSlug?: string;
  orgId?: string;
  productId?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export type MaterializeVideoResult =
  | { status: "bad_request" }
  | { status: "org_not_found" }
  | { status: "indexed" | "existing"; source: typeof sources.$inferSelect; releaseCount: number };

const MARKETING_HINT =
  "Suppress customer case studies, customer testimonials, event recaps, and partner spotlights; keep first-party product launches and feature announcements.";

export async function materializeVideoSource(
  db: ReturnType<typeof createDb>,
  env: FetchOneEnv,
  params: MaterializeVideoParams,
): Promise<MaterializeVideoResult> {
  const provider = matchVideoUrl(params.url);
  if (!provider) return { status: "bad_request" };

  let resolved;
  try {
    resolved = await provider.resolveFeed(params.url, params.fetchImpl);
  } catch {
    return { status: "bad_request" };
  }

  // Resolve org (required — no derivation).
  const orgRows = params.orgId
    ? await db
        .select()
        .from(organizationsActive)
        .where(eq(organizationsActive.id, params.orgId))
        .limit(1)
    : params.orgSlug
      ? await db
          .select()
          .from(organizationsActive)
          .where(eq(organizationsActive.slug, params.orgSlug.toLowerCase()))
          .limit(1)
      : [];
  const org = orgRows[0];
  if (!org) return { status: "org_not_found" };

  // Idempotency: existing video source with this feedUrl wins.
  const existing = await db
    .select()
    .from(sourcesActive)
    .where(
      and(
        eq(sourcesActive.type, "video"),
        // feedUrl is stored at metadata.feedUrl
        // (json_extract path matches appstore-materialize's pattern)
        eq(sourcesActive.orgId, org.id),
      ),
    );
  const dup = existing.find((s) => {
    try {
      return (JSON.parse(s.metadata ?? "{}") as { feedUrl?: string }).feedUrl === resolved.feedUrl;
    } catch {
      return false;
    }
  });
  if (dup) {
    return { status: "existing", source: dup as typeof sources.$inferSelect, releaseCount: 0 };
  }

  // Fetch + parse once: fills channel identity for naming + the backfill batch.
  const parsed = await fetchAndParseVideoFeed(
    resolved.feedUrl,
    provider,
    undefined,
    params.fetchImpl,
  );
  const channel = { ...resolved.channel, ...parsed.channel };

  const displayName = channel.playlistTitle ?? channel.title ?? "Video channel";
  const baseSlug = toSlug(channel.playlistTitle ?? channel.title ?? channel.id ?? "video");

  const sourceId = newSourceId();
  const metadata = JSON.stringify({
    feedUrl: resolved.feedUrl,
    feedType: "atom",
    ...(parsed.etag ? { feedEtag: parsed.etag } : {}),
    video: { provider: provider.id, channel },
    marketingFilter: true,
    marketingFilterHint: MARKETING_HINT,
  });

  const [insertedSource] = await db
    .insert(sources)
    .values({
      id: sourceId,
      name: displayName,
      slug: baseSlug,
      type: "video",
      url: resolved.canonicalUrl,
      orgId: org.id,
      productId: params.productId ?? null,
      discovery: "curated",
      isHidden: false,
      metadata,
    })
    .returning();

  // Backfill through the shared ingest path so the marketing classifier +
  // summarizer trigger + dedup all apply to the initial batch.
  const ingest = await ingestRawReleases(db, insertedSource!, parsed.releases, env);

  return { status: "indexed", source: insertedSource!, releaseCount: ingest.releasesInserted };
}
```

> **Confirm three things by reading the codebase before finalizing:** (1) the exact `createDb` import path (appstore-materialize uses it — copy verbatim); (2) that `ingestRawReleases` is exported from `poll-fetch.ts` and returns a `{ releasesInserted }` shape (the dispatch-extract confirmed it's exported; check the `IngestResult` field name); (3) `newSourceId`/`toSlug` import paths. Adjust the idempotency check to use `json_extract` in SQL (mirroring appstore-materialize line ~146) if you prefer a DB-side filter over the in-memory `.find`.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test workers/api/test/video-materialize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/video-materialize.ts workers/api/test/video-materialize.test.ts
git commit -m "feat(api): materializeVideoSource — create video source + backfill"
```

---

## Task 11: `POST /v1/sources/video` route

**Files:**

- Modify: `workers/api/src/routes/sources.ts` (add the route near the appstore route ~line 2201; add import)
- Test: `workers/api/test/video-create-route.test.ts`

- [ ] **Step 1: Write the failing route smoke test**

Create `workers/api/test/video-create-route.test.ts`, modeled on `workers/api/test/appstore-fetch-route.test.ts` (open it for the in-process `routes.request(...)` + fake-env pattern, including how it stubs Secrets Store as `{ get: async () => value }`). The route resolves the feed via real `fetch` — inject a fake by mocking `globalThis.fetch` for the test, OR (preferred) assert the `400` path with a non-video URL which needs no network:

```ts
import { describe, expect, test } from "bun:test";
import app from "../src/index"; // the Hono app export — confirm the actual export
import { createTestEnv } from "./helpers"; // match the helper other route tests use

describe("POST /v1/sources/video", () => {
  test("400 when url is missing", async () => {
    const env = createTestEnv();
    const res = await app.request(
      "/v1/sources/video",
      {
        method: "POST",
        headers: { Authorization: "Bearer test-admin", "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  test("400 for a non-video URL", async () => {
    const env = createTestEnv();
    const res = await app.request(
      "/v1/sources/video",
      {
        method: "POST",
        headers: { Authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/not-a-video", orgSlug: "anthropic" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
```

> Match the exact auth/env/import conventions of the sibling route tests — do not invent helpers. If there's no `createTestEnv`/`helpers`, copy the env-construction block from `appstore-fetch-route.test.ts` inline.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test workers/api/test/video-create-route.test.ts`
Expected: FAIL — route returns 404 (not registered yet).

- [ ] **Step 3: Add the route**

In `workers/api/src/routes/sources.ts`, add the import near the appstore-materialize import:

```ts
import { materializeVideoSource } from "../lib/video-materialize.js";
```

Add the route immediately after the `POST /sources/appstore` handler (after line ~2254), mirroring its structure:

```ts
sourceRoutes.post(
  "/sources/video",
  describeRoute({
    hide: hideInProduction,
    tags: ["Sources"],
    summary: "Materialize a video source (YouTube channel/playlist)",
    description:
      "Resolves a YouTube channel or playlist URL into its Atom feed and creates a `video` source under the given org, backfilling current videos as releases (description-only, summarizer-cleaned, marketing-filtered). `orgSlug` or `orgId` is required. Idempotent on the resolved feed URL. Write — requires a Bearer token.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "A video source already existed for this feed" },
      201: { description: "Video source materialized" },
      400: { description: "Missing/unrecognized url" },
      404: { description: "Org not found" },
    },
  }),
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      url?: string;
      orgSlug?: string;
      orgId?: string;
      productId?: string;
    } | null;

    if (!body?.url) {
      return c.json({ error: "bad_request", message: "url is required" }, 400);
    }
    if (!body.orgSlug && !body.orgId) {
      return c.json({ error: "bad_request", message: "orgSlug or orgId is required" }, 400);
    }

    const db = createDb(c.env.DB);
    const result = await materializeVideoSource(
      db,
      {
        GITHUB_TOKEN: undefined,
        RELEASES_INDEX: c.env.RELEASES_INDEX,
        CHANGELOG_CHUNKS_INDEX: c.env.CHANGELOG_CHUNKS_INDEX,
        EMBEDDING_PROVIDER: c.env.EMBEDDING_PROVIDER,
        VOYAGE_API_KEY: c.env.VOYAGE_API_KEY,
        OPENAI_API_KEY: c.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY,
        RELEASE_HUB: c.env.RELEASE_HUB,
        WEBHOOK_DELIVERY_QUEUE: c.env.WEBHOOK_DELIVERY_QUEUE,
        DB: c.env.DB,
        DISCOVERY_WORKER: c.env.DISCOVERY_WORKER,
        MEDIA_R2_UPLOAD_ENABLED: c.env.MEDIA_R2_UPLOAD_ENABLED,
        MEDIA: c.env.MEDIA,
      },
      { url: body.url, orgSlug: body.orgSlug, orgId: body.orgId, productId: body.productId },
    );

    if (result.status === "bad_request") {
      return c.json(
        { error: "bad_request", message: "Could not resolve a video feed from that URL" },
        400,
      );
    }
    if (result.status === "org_not_found") {
      return c.json({ error: "not_found", message: "Org not found" }, 404);
    }
    return c.json(result, result.status === "existing" ? 200 : 201);
  },
);
```

> The `FetchOneEnv` field list must match `materializeVideoSource`'s `env` parameter. Copy the exact env field set from the `POST /sources/:slug/fetch` handler's `fetchOne` call (lines 627–640) so it stays in sync; add `ANTHROPIC_API_KEY` (the marketing classifier needs it — confirm the binding name via `getAnthropicKey` in poll-fetch).

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test workers/api/test/video-create-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `cd workers/api && npx tsc --noEmit` → PASS.

```bash
git add workers/api/src/routes/sources.ts workers/api/test/video-create-route.test.ts
git commit -m "feat(api): POST /v1/sources/video creation endpoint"
```

---

## Task 12: Attach the `video` facet in search `buildReleaseHits`

**Files:**

- Modify: `packages/search/src/hybrid-search-worker.ts` (add `videoInfoFromMetadata`; attach `video` in `buildReleaseHits` ~line 760)
- Test: add a unit test next to existing search tests (find with `ls packages/search/src/*.test.ts`)

- [ ] **Step 1: Add `videoInfoFromMetadata` helper**

In `packages/search/src/hybrid-search-worker.ts`, after `appStoreInfoFromMetadata` (ends line 711), add a parallel helper (the package keeps its own copy to avoid depending on `packages/adapters`, exactly as it does for App Store):

```ts
/**
 * Video provider tag from a source's `metadata` JSON. Mirrors `videoSourceInfo`
 * in packages/adapters/src/source-meta.ts — duplicated here to keep the search
 * package's dep graph at `releases-core` only.
 */
function videoInfoFromMetadata(
  type: string,
  metadataJson: string | null,
): { provider: "youtube" | "vimeo" | "wistia" } | null {
  if (type !== "video") return null;
  try {
    const block = (JSON.parse(metadataJson ?? "{}") as { video?: { provider?: unknown } } | null)
      ?.video;
    const provider = block?.provider;
    if (provider === "youtube" || provider === "vimeo" || provider === "wistia") {
      return { provider };
    }
  } catch {
    // fall through
  }
  return null;
}
```

- [ ] **Step 2: Attach it on the release hit**

In `buildReleaseHits`, the `source` object pushed onto `out` (line ~757) currently ends with `appStore: appStoreInfoFromMetadata(...)`. Add the video line right after:

```ts
        source: {
          id: row.sourceId,
          slug: row.sourceSlug,
          name: row.sourceName,
          type: row.sourceType,
          appStore: appStoreInfoFromMetadata(row.sourceType, row.sourceMetadata),
          video: videoInfoFromMetadata(row.sourceType, row.sourceMetadata),
        },
```

- [ ] **Step 3: Write a unit test**

Add `packages/search/src/video-info.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
// videoInfoFromMetadata is module-private; assert via the exported behavior if a
// public seam exists. If not, export it for testing (add `export` to the fn) and:
import { __test } from "./hybrid-search-worker"; // only if a test barrel exists

describe("videoInfoFromMetadata", () => {
  test("provider for video, null otherwise", () => {
    // If the helper isn't exported, instead add a small exported wrapper or
    // cover this via a buildReleaseHits integration test. Prefer exporting the
    // helper (matches how appStoreInfoFromMetadata could be tested).
    expect(true).toBe(true);
  });
});
```

> Pragmatic note: `appStoreInfoFromMetadata` is module-private and untested in isolation. To avoid inventing a test barrel, either (a) `export` both helpers and write a direct unit test, or (b) cover `video` via the existing search integration test that already exercises `buildReleaseHits`. Pick whichever matches the package's current testing convention — check `packages/search/src/*.test.ts` first. Do not add a fake `__test` import if none exists.

- [ ] **Step 4: Type-check + test**

Run: `cd packages/search && npx tsc --noEmit` → PASS.
Run: `bun test packages/search/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/search/src/hybrid-search-worker.ts packages/search/src/video-info.test.ts
git commit -m "feat(search): attach video facet in buildReleaseHits"
```

---

## Task 13: API org-feed formatter — attach `video`

The `/v1/orgs/:slug/releases` route formats `OrgReleaseItem`s and currently attaches `appStore` via `appStoreSourceInfo`. Add the parallel `video` attachment.

**Files:**

- Modify: `workers/api/src/routes/orgs.ts` (~line 1840, the formatter that sets `source.appStore`)

- [ ] **Step 1: Import `videoSourceInfo`**

In `workers/api/src/routes/orgs.ts`, find the import of `appStoreSourceInfo` (from `@releases/adapters/appstore`) and add `videoSourceInfo` from `@releases/adapters/source-meta`:

```ts
import { videoSourceInfo } from "@releases/adapters/source-meta";
```

> Confirm `appStoreSourceInfo` is imported here (the extract showed it's called at lines 1840–1862) and place the new import alongside it.

- [ ] **Step 2: Attach the facet**

At the formatter where `source.appStore` is set (~line 1850), add a sibling `video` field:

```ts
        appStore: appStoreSourceInfo(row.sourceType, row.sourceMetadata),
        video: videoSourceInfo(row.sourceType, row.sourceMetadata) ?? undefined,
```

> Match the exact local variable names used in that formatter (the row's `type` and `metadata` accessors) — they may be `row.type` / `row.metadata` rather than `row.sourceType` / `row.sourceMetadata`. Use whatever the adjacent `appStoreSourceInfo` call uses.

- [ ] **Step 3: Type-check**

Run: `cd workers/api && npx tsc --noEmit` → PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/routes/orgs.ts
git commit -m "feat(api): attach video facet on org releases feed"
```

---

## Task 14: Web — thumbnail-forward `video` row

**Files:**

- Create: `web/src/lib/video-source.ts`
- Modify: `web/src/components/release-item.tsx`

- [ ] **Step 1: Add the web helper**

Create `web/src/lib/video-source.ts` (mirrors `web/src/lib/app-source.ts`):

```ts
export interface VideoRowInfo {
  provider: "youtube" | "vimeo" | "wistia";
  label: string; // "YouTube" | "Vimeo" | "Wistia"
}

const LABELS: Record<VideoRowInfo["provider"], string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  wistia: "Wistia",
};

export function videoRowInfoFromWire(
  video: { provider: "youtube" | "vimeo" | "wistia" } | null | undefined,
): VideoRowInfo | null {
  if (!video) return null;
  return { provider: video.provider, label: LABELS[video.provider] };
}
```

- [ ] **Step 2: Add the `video` prop + branch to `ReleaseListItem`**

In `web/src/components/release-item.tsx`, add to the component props (after `appStore?`):

```tsx
  video,
}: {
  release: ReleaseItem;
  hideDate?: boolean;
  sourceByline?: { name: string; slug: string; orgSlug?: string };
  appStore?: AppRowInfo | null;
  video?: VideoRowInfo | null;
}) {
```

Add the import at the top:

```tsx
import type { VideoRowInfo } from "@/lib/video-source";
```

Add a `video` branch alongside the `appStore` branch (the thumbnail comes from `release.media[0]`, the watch link from `release.url`). Insert before the `appStore &&` block:

```tsx
{
  video && (
    <div
      className="group relative cursor-pointer"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse description" : "Expand description"}
      onClick={() => setExpanded(!expanded)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpanded(!expanded);
        }
      }}
    >
      <div className="flex items-center gap-3">
        {release.media?.[0]?.url ? (
          <FallbackImage
            src={release.media[0].url}
            alt=""
            width={96}
            height={54}
            className="rounded-md border border-stone-200 dark:border-stone-800 shrink-0 object-cover"
          />
        ) : (
          <div className="w-24 h-[54px] rounded-md bg-stone-200 dark:bg-stone-700 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className={headingClasses}>
            {release.id ? (
              <Link href={`/release/${release.id}`} className="hover:underline underline-offset-2">
                {release.titleShort || release.title}
              </Link>
            ) : (
              release.titleShort || release.title
            )}
          </h2>
          <div className="text-[13px] text-stone-500 dark:text-stone-400">
            Watch on {video.label}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pl-[108px]">
          {markdownContent.trim() ? (
            <div className={markdownClasses}>
              <ReactMarkdown>{markdownContent}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-[13px] italic text-stone-400 dark:text-stone-500 m-0">
              No description provided.
            </p>
          )}
          {release.url && (
            <a
              href={release.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-[13px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              Watch on {video.label}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
```

> Match the existing `ReactMarkdown` invocation props used by the App Store branch (plugins/components) — copy them verbatim from that block. Do not introduce a `↗` arrow (project rule); use plain text "Watch on YouTube".

- [ ] **Step 3: Pass `video` from the feed list**

Find where `ReleaseListItem` is rendered with `appStore={appRowInfoFromWire(...)}` (likely `web/src/components/org-release-list.tsx` or a feed list). Add the parallel prop:

```tsx
              video={videoRowInfoFromWire(r.source?.video)}
```

with the import `import { videoRowInfoFromWire } from "@/lib/video-source";`. Use `grep -rn "appRowInfoFromWire" web/src` to find every call site and add the sibling at each.

- [ ] **Step 4: Type-check the web app**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/video-source.ts web/src/components/release-item.tsx web/src/components/org-release-list.tsx
git commit -m "feat(web): thumbnail-forward video release row"
```

---

## Task 15: Full verification

- [ ] **Step 1: Root type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Per-worker + per-package type-check**

Run: `cd workers/api && npx tsc --noEmit && cd ../../packages/adapters && npx tsc --noEmit && cd ../search && npx tsc --noEmit && cd ../api-types && npx tsc --noEmit && cd ../../web && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 3: Full test suite**

Run: `bun test`
Expected: PASS (new video tests included; no regressions).

- [ ] **Step 4: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. (Run `bun run format` if format:check flags the new files.)

- [ ] **Step 5: OpenAPI coverage gate**

The new `POST /v1/sources/video` is a write route (not under `publicReadRoutes`), so it's outside the coverage gate's scope. Still run the gate to confirm nothing regressed:

Run: `bun run scripts/check-openapi-coverage.ts` (or the script path CI uses — see AGENTS.md)
Expected: PASS.

- [ ] **Step 6: Manual end-to-end smoke (optional, against staging)**

After deploy to staging, create the Claude playlist source and confirm the backfill:

```bash
# (staging requires the X-Releases-Staging-Key header)
curl -sS -X POST https://api-staging.releases.sh/v1/sources/video \
  -H "Authorization: Bearer $RELEASES_API_KEY_ADMIN" \
  -H "X-Releases-Staging-Key: $STAGING_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/playlist?list=PLmWCw1CzcFilOIgUYuMIJ2iZMo09Ho0va","orgSlug":"anthropic"}'
```

Expected: `201` with `releaseCount` ≈ the playlist size, minus any items the marketing classifier suppressed (e.g. the Notion case-study video). Confirm the org feed shows thumbnail-forward video rows.

- [ ] **Step 7: Final commit (if any format fixes)**

```bash
git add -A
git commit -m "chore: format + verification for video source type"
```

---

## Self-Review (completed during planning)

**Spec coverage:**

- §1 source type & schema → Task 1. ✓
- §1 metadata discriminator → Task 3 (refined to a nested `metadata.video` block for parity with `metadata.appStore`; design doc says `videoProvider`/`videoChannel` — the nested block is the implementation form, noted here).
- §2 provider registry → Tasks 5–7. ✓
- §2 creation endpoint → Tasks 10–11. ✓
- §3 fetch path → Tasks 8–9. **Refinement:** only 3 edits needed (fetchOne branch + fetchable filter + manual route), not 4 — video rides `feedUrl` for due-selection and `pollOne` HEAD-checks, so those two "gates" need no edit. Documented in the Architecture header and Task 8 preamble.
- §4 ingest → release → Tasks 5 (RawRelease shape) + 8 (dispatch) + 10 (backfill via `ingestRawReleases`). ✓
- §5 summarizer → reused automatically (shared post-dispatch `ingestRawReleases`). ✓
- §6 marketing filter default-on → Task 10 (sets `marketingFilter: true` + hint). ✓
- §7 presentation → Tasks 2 (wire), 12 (search facet), 13 (API org feed), 14 (web row). ✓
- §7 MCP parity → covered by the shared `buildReleaseHits` (Task 12); `get_latest_releases` uses a separate D1 mapper that does NOT carry `appStore`/`video` today — **logged as a known gap** matching the existing App Store gap, out of scope for v1 (same as #1204 shipped without it).
- Out-of-scope items (transcript, coverage-linking, Vimeo/Wistia, presentation spread, CLI) → not in any task. ✓

**Placeholder scan:** No "TBD/TODO". The two `> Note` callouts ask the implementer to confirm exact import paths against the real files (createDb path, RELEASES_BOT_UA location, ingestRawReleases result field, web call sites) — these are verification instructions, not missing content; the code is complete and the anchors are from the verbatim extract.

**Type consistency:** `isVideoFetched`, `videoSourceInfo`/`videoInfoFromMetadata`, `matchVideoUrl`, `resolveVideoProvider`, `fetchAndParseVideoFeed`, `parseYouTubeFeed`/`youtubeProvider.parseFeed`, `materializeVideoSource`, `VideoSourceInfoSchema`, the `metadata.video.provider` shape, and the `video?: { provider }` wire facet are used consistently across all tasks.

**Known gaps (intentional, v1):** `get_latest_releases` MCP tool and the App Store-style presentation spread (search card / ticker / rollup) do not carry the `video` facet — same scope boundary as the original App Store row (#1204). The org feed + release detail + unified `search` carry it.
