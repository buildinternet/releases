# Per-user Authenticated Atom Feed (#1519) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose each signed-in user's personalized follows feed as a tokenized, re-revealable Atom URL they can paste into a feed reader.

**Architecture:** A dedicated `relf_` feed token (one reversible row per user in a worker-local `user_feed_tokens` island) authenticates a public `GET /v1/feed/:token` read lane that renders `getFollowedReleases` through a new `userFeedToAtom` formatter. A cookie-session management lane (`GET/POST/DELETE /v1/me/feed/token`) mints/rotates/revokes the token and re-displays the full URL. A "Your feed" card on `/following` surfaces copy/rotate/revoke.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Worker + Hono, Drizzle/D1, packages/core (pure token helpers), packages/rendering (Atom), Next.js (web).

**Spec:** `docs/superpowers/specs/2026-06-08-1519-user-feed-token-design.md`

---

## File Structure

| File                                                             | Responsibility                               | Action             |
| ---------------------------------------------------------------- | -------------------------------------------- | ------------------ |
| `packages/core/src/api-token.ts`                                 | `relf_` token generate/parse/shape helpers   | Modify             |
| `packages/core/src/api-token.test.ts`                            | Token helper tests                           | Modify (or create) |
| `packages/api-types/src/api-types.ts`                            | `FeedToken` + `FeedTokenResponse` wire types | Modify             |
| `workers/api/src/db/schema-feed-tokens.ts`                       | `user_feed_tokens` schema island             | Create             |
| `workers/api/migrations/20260608010000_add_user_feed_tokens.sql` | Paired migration                             | Create             |
| `workers/api/src/queries/feed-tokens.ts`                         | upsert / get / delete / resolve-by-token     | Create             |
| `workers/api/test/feed-tokens-query.test.ts`                     | Query unit tests                             | Create             |
| `packages/rendering/src/atom.ts`                                 | `userFeedToAtom` formatter + `"user"` scope  | Modify             |
| `packages/rendering/src/atom.test.ts`                            | Formatter snapshot tests                     | Modify             |
| `workers/api/src/routes/me.ts`                                   | `GET/POST/DELETE /me/feed/token` handlers    | Modify             |
| `workers/api/test/feed-token-routes.test.ts`                     | Management-lane route tests                  | Create             |
| `workers/api/src/routes/feed.ts`                                 | Public `GET /v1/feed/:token` read lane       | Create             |
| `workers/api/src/v1-routes.ts`                                   | Mount `feedRoutes`                           | Modify             |
| `workers/api/src/index.ts`                                       | Rate-limit `.use` for `/feed/*`              | Modify             |
| `workers/api/test/feed-read-route.test.ts`                       | Read-lane route tests                        | Create             |
| `web/src/lib/api.ts` (or following-client)                       | Management-endpoint fetch helpers            | Modify             |
| `web/src/app/following/following-client.tsx`                     | "Your feed" card                             | Modify             |

---

## Task 1: Core `relf_` feed token helpers

**Files:**

- Modify: `packages/core/src/api-token.ts`
- Test: `packages/core/src/api-token.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/api-token.test.ts` (create the file with the imports below if it does not exist):

```ts
import { describe, expect, it } from "bun:test";
import {
  FEED_TOKEN_PREFIX,
  generateFeedToken,
  parseFeedToken,
  isFeedTokenShaped,
  constantTimeEqual,
} from "./api-token.js";

describe("feed tokens (relf_)", () => {
  it("generates a relf_-prefixed token that round-trips through parse", () => {
    const { token, lookupId, secret } = generateFeedToken();
    expect(token.startsWith(FEED_TOKEN_PREFIX)).toBe(true);
    expect(token).toBe(`${FEED_TOKEN_PREFIX}${lookupId}_${secret}`);
    const parsed = parseFeedToken(token);
    expect(parsed).toEqual({ lookupId, secret });
  });

  it("isFeedTokenShaped accepts relf_ and rejects relk_/relu_", () => {
    const { token } = generateFeedToken();
    expect(isFeedTokenShaped(token)).toBe(true);
    expect(isFeedTokenShaped("relk_abc_def")).toBe(false);
    expect(isFeedTokenShaped("relu_abc")).toBe(false);
  });

  it("parseFeedToken returns null for malformed input", () => {
    expect(parseFeedToken("relf_short")).toBeNull();
    expect(parseFeedToken("not-a-token")).toBeNull();
    expect(parseFeedToken("relk_" + "a".repeat(12) + "_" + "b".repeat(32))).toBeNull();
  });

  it("constantTimeEqual matches the stored secret and rejects a wrong one", () => {
    const { secret } = generateFeedToken();
    expect(constantTimeEqual(secret, secret)).toBe(true);
    expect(constantTimeEqual(secret, secret.slice(0, -1) + "X")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/api-token.test.ts`
Expected: FAIL — `FEED_TOKEN_PREFIX`/`generateFeedToken`/`parseFeedToken`/`isFeedTokenShaped` are not exported.

- [ ] **Step 3: Add the helpers**

In `packages/core/src/api-token.ts`, immediately after the `isApiTokenShaped` function (around line 96), add:

```ts
/**
 * Wire prefix for per-user feed tokens — the credential embedded in a
 * personalized Atom feed URL (`/v1/feed/relf_<lookupId>_<secret>.atom`).
 * Distinct from `relk_`/`relu_` so it's secret-scanning friendly and never
 * collides with the Bearer auth lanes (it's only ever presented in the feed
 * path). Same lookupId/secret structure as `relk_`; reuse the base62 generators.
 */
export const FEED_TOKEN_PREFIX = "relf_";

const FEED_TOKEN_RE = new RegExp(
  `^${FEED_TOKEN_PREFIX}([0-9A-Za-z]{${LOOKUP_LEN}})_([0-9A-Za-z]{${SECRET_LEN}})$`,
);

export function generateFeedToken(): GeneratedApiToken {
  const lookupId = genLookup();
  const secret = genSecret();
  return { token: `${FEED_TOKEN_PREFIX}${lookupId}_${secret}`, lookupId, secret };
}

export function parseFeedToken(raw: string): ParsedApiToken | null {
  const m = raw.trim().match(FEED_TOKEN_RE);
  if (!m) return null;
  return { lookupId: m[1], secret: m[2] };
}

/** Cheap prefix check — routes a path credential to the feed-token resolver. */
export function isFeedTokenShaped(raw: string): boolean {
  return raw.startsWith(FEED_TOKEN_PREFIX);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test src/api-token.test.ts`
Expected: PASS (all 4 new tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api-token.ts packages/core/src/api-token.test.ts
git commit -m "feat(core): relf_ feed token generate/parse/shape helpers (#1519)"
```

---

## Task 2: `FeedToken` wire types

**Files:**

- Modify: `packages/api-types/src/api-types.ts`

- [ ] **Step 1: Add the types**

In `packages/api-types/src/api-types.ts`, immediately after the `FollowMutationResponse` interface (around line 827, the end of the follows block), add:

```ts
/**
 * A user's personalized feed token, including the full re-revealable feed URL.
 * The token is reversible (stored recoverably) because the feed serves only
 * public release data and carries no PII — so the URL can be re-displayed and
 * copied on any visit (see #1519 design, decision 6). One per user.
 */
export interface FeedToken {
  /** Absolute, tokenized Atom URL — e.g. https://api.releases.sh/v1/feed/relf_…_….atom */
  feedUrl: string;
  /** Non-secret public handle (for masked display). */
  lookupId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `GET /v1/me/feed/token` — the token, or null if the user has none yet. */
export interface FeedTokenResponse {
  token: FeedToken | null;
}
```

- [ ] **Step 2: Type-check the package**

Run: `cd packages/api-types && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/api-types/src/api-types.ts
git commit -m "feat(api-types): FeedToken + FeedTokenResponse wire types (#1519)"
```

---

## Task 3: `user_feed_tokens` schema island + migration

**Files:**

- Create: `workers/api/src/db/schema-feed-tokens.ts`
- Create: `workers/api/migrations/20260608010000_add_user_feed_tokens.sql`

- [ ] **Step 1: Create the schema island**

Create `workers/api/src/db/schema-feed-tokens.ts`:

```ts
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema-auth.js";

/**
 * Per-user feed tokens — the opaque credential embedded in a user's personalized
 * Atom feed URL (`/v1/feed/relf_<lookupId>_<secret>.atom`).
 *
 * Worker-local schema island (sibling of schema-follows.ts), deliberately NOT in
 * the published core schema: user-coupled, the OSS CLI has no use for it. Queried
 * via explicit `.select().from(userFeedTokens)` on a `createDb(...)` handle.
 *
 * One row per user (`user_id` unique): mint and rotate are the same upsert
 * (replace the secret + lookupId), revoke deletes the row. The `secret` is stored
 * PLAINTEXT (reversible) — the feed serves only public release data with no PII,
 * so the full URL is re-revealable on every visit (see #1519 design, decision 6).
 * `user_id` cascades on account delete.
 *
 * Paired migration: 20260608010000_add_user_feed_tokens.sql.
 */
export const userFeedTokens = sqliteTable(
  "user_feed_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lookupId: text("lookup_id").notNull(),
    secret: text("secret").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("idx_user_feed_tokens_user").on(t.userId),
    uniqueIndex("idx_user_feed_tokens_lookup").on(t.lookupId),
  ],
);

export type UserFeedToken = typeof userFeedTokens.$inferSelect;
export type NewUserFeedToken = typeof userFeedTokens.$inferInsert;
```

- [ ] **Step 2: Create the paired migration**

Create `workers/api/migrations/20260608010000_add_user_feed_tokens.sql`:

```sql
-- Per-user feed tokens: the credential embedded in a personalized Atom feed URL.
-- Paired with workers/api/src/db/schema-feed-tokens.ts.
-- Reversible: `secret` is stored plaintext (public-data feed, no PII) so the
-- full URL is re-revealable. One row per user.
CREATE TABLE IF NOT EXISTS user_feed_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  lookup_id    TEXT NOT NULL,
  secret       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_feed_tokens_user
  ON user_feed_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_feed_tokens_lookup
  ON user_feed_tokens (lookup_id);
```

- [ ] **Step 3: Type-check the worker**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/db/schema-feed-tokens.ts workers/api/migrations/20260608010000_add_user_feed_tokens.sql
git commit -m "feat(api): user_feed_tokens schema island + migration (#1519)"
```

---

## Task 4: Feed-token queries

**Files:**

- Create: `workers/api/src/queries/feed-tokens.ts`
- Test: `workers/api/test/feed-tokens-query.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/feed-tokens-query.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import {
  upsertFeedToken,
  getFeedToken,
  deleteFeedToken,
  resolveFeedToken,
} from "../src/queries/feed-tokens.js";

let h: TestDatabase;

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("feed-token queries", () => {
  it("mints, fetches, and resolves a token", async () => {
    const minted = await upsertFeedToken(h.db, "u1");
    expect(minted.token).toMatch(/^relf_/);

    const row = await getFeedToken(h.db, "u1");
    expect(row?.lookupId).toBe(minted.lookupId);

    const userId = await resolveFeedToken(h.db, minted.token);
    expect(userId).toBe("u1");
  });

  it("rotate (second upsert) invalidates the previous token", async () => {
    const first = await upsertFeedToken(h.db, "u1");
    const second = await upsertFeedToken(h.db, "u1");
    expect(second.token).not.toBe(first.token);
    expect(await resolveFeedToken(h.db, first.token)).toBeNull();
    expect(await resolveFeedToken(h.db, second.token)).toBe("u1");
    // Still exactly one row for the user.
    expect((await getFeedToken(h.db, "u1"))?.lookupId).toBe(second.lookupId);
  });

  it("revoke deletes the row and the token stops resolving", async () => {
    const minted = await upsertFeedToken(h.db, "u1");
    await deleteFeedToken(h.db, "u1");
    expect(await getFeedToken(h.db, "u1")).toBeNull();
    expect(await resolveFeedToken(h.db, minted.token)).toBeNull();
  });

  it("resolveFeedToken returns null for malformed or unknown tokens", async () => {
    expect(await resolveFeedToken(h.db, "garbage")).toBeNull();
    expect(
      await resolveFeedToken(h.db, "relf_" + "a".repeat(12) + "_" + "b".repeat(32)),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/api && bun test test/feed-tokens-query.test.ts`
Expected: FAIL — `../src/queries/feed-tokens.js` does not exist.

- [ ] **Step 3: Implement the queries**

Create `workers/api/src/queries/feed-tokens.ts`:

```ts
import { eq } from "drizzle-orm";
import {
  generateFeedToken,
  parseFeedToken,
  constantTimeEqual,
} from "@buildinternet/releases-core/api-token";
import type { AnyDb } from "../db.js";
import { userFeedTokens, type UserFeedToken } from "../db/schema-feed-tokens.js";

function newFeedTokenId(): string {
  return `uft_${crypto.randomUUID()}`;
}

export interface MintedFeedToken {
  /** Full `relf_…` token — shown to the caller; reconstructable from the row. */
  token: string;
  lookupId: string;
  createdAt: Date;
}

/** Build the full `relf_<lookupId>_<secret>` token string from a stored row. */
export function feedTokenString(row: Pick<UserFeedToken, "lookupId" | "secret">): string {
  return `relf_${row.lookupId}_${row.secret}`;
}

/**
 * Mint-or-rotate the caller's single feed token. Deletes any existing row for
 * the user, then inserts a fresh one (so rotation invalidates the old secret).
 */
export async function upsertFeedToken(db: AnyDb, userId: string): Promise<MintedFeedToken> {
  const { token, lookupId, secret } = generateFeedToken();
  const createdAt = new Date();
  await db.delete(userFeedTokens).where(eq(userFeedTokens.userId, userId));
  await db.insert(userFeedTokens).values({
    id: newFeedTokenId(),
    userId,
    lookupId,
    secret,
    createdAt,
    lastUsedAt: null,
  });
  return { token, lookupId, createdAt };
}

/** Fetch the user's token row (without forcing the caller to know the secret). */
export async function getFeedToken(db: AnyDb, userId: string): Promise<UserFeedToken | null> {
  const row = await db.select().from(userFeedTokens).where(eq(userFeedTokens.userId, userId)).get();
  return row ?? null;
}

/** Revoke: delete the user's token row. Idempotent. */
export async function deleteFeedToken(db: AnyDb, userId: string): Promise<void> {
  await db.delete(userFeedTokens).where(eq(userFeedTokens.userId, userId));
}

/**
 * Resolve a presented `relf_…` token to its owning userId, or null. Looks up by
 * the non-secret lookupId, then constant-time compares the secret. Never throws.
 */
export async function resolveFeedToken(db: AnyDb, raw: string): Promise<string | null> {
  const parsed = parseFeedToken(raw);
  if (!parsed) return null;
  const row = await db
    .select()
    .from(userFeedTokens)
    .where(eq(userFeedTokens.lookupId, parsed.lookupId))
    .get();
  if (!row) return null;
  if (!constantTimeEqual(parsed.secret, row.secret)) return null;
  return row.userId;
}

/** Best-effort: stamp last_used_at. Caller should not await on the hot path. */
export async function touchFeedTokenLastUsed(db: AnyDb, lookupId: string): Promise<void> {
  await db
    .update(userFeedTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(userFeedTokens.lookupId, lookupId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/api && bun test test/feed-tokens-query.test.ts`
Expected: PASS (all 4 tests green).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/queries/feed-tokens.ts workers/api/test/feed-tokens-query.test.ts
git commit -m "feat(api): feed-token queries — upsert/get/delete/resolve (#1519)"
```

---

## Task 5: `userFeedToAtom` formatter

**Files:**

- Modify: `packages/rendering/src/atom.ts`
- Test: `packages/rendering/src/atom.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/rendering/src/atom.test.ts`:

```ts
import { userFeedToAtom } from "./atom.js";
import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";

function latestItem(over: Partial<ReleaseLatestItem> = {}): ReleaseLatestItem {
  return {
    id: "rel_1",
    version: "1.0.0",
    type: "feature",
    title: "Shipped a thing",
    summary: "We shipped a thing.",
    titleGenerated: null,
    titleShort: null,
    publishedAt: "2026-06-01",
    url: "https://acme.example/releases/1",
    media: [],
    source: { slug: "acme-blog", name: "Acme Blog", type: "feed", orgSlug: "acme" },
    product: null,
    coverageCount: 0,
    contentChars: 0,
    contentTokens: 0,
    ...over,
  } as ReleaseLatestItem;
}

describe("userFeedToAtom", () => {
  const opts = { baseUrl: "https://releases.sh" };
  const selfUrl = "https://api.releases.sh/v1/feed/relf_abc_def.atom";

  it("renders followed releases with a stable user feed id and self link", () => {
    const xml = userFeedToAtom({ releases: [latestItem()], lookupId: "abc", selfUrl }, opts);
    expect(xml).toContain("<feed");
    expect(xml).toContain("<title>Your followed releases</title>");
    expect(xml).toContain(`tag:releases.sh,2005:user/abc`);
    expect(xml).toContain(`href="${selfUrl}"`);
    expect(xml).toContain("https://releases.sh/release/rel_1");
    expect(xml).toContain("https://releases.sh/following");
    expect(xml).toContain("Shipped a thing");
  });

  it("renders a valid empty feed when the user follows nothing", () => {
    const xml = userFeedToAtom({ releases: [], lookupId: "abc", selfUrl }, opts);
    expect(xml).toContain("<feed");
    expect(xml).toContain("</feed>");
    expect(xml).not.toContain("<entry>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rendering && bun test src/atom.test.ts`
Expected: FAIL — `userFeedToAtom` is not exported.

- [ ] **Step 3: Add the `"user"` scope and the formatter**

In `packages/rendering/src/atom.ts`:

(a) Extend the `FeedShell.scope` union (around line 134) from:

```ts
scope: "org" | "source" | "collection" | "category" | "product";
```

to:

```ts
scope: "org" | "source" | "collection" | "category" | "product" | "user";
```

(b) Add the import for `ReleaseLatestItem` to the existing type import block at the top (around line 9):

```ts
import type {
  ReleaseItem,
  SourceDetail,
  OrgReleaseItem,
  CollectionReleaseItem,
  ReleaseLatestItem,
} from "@buildinternet/releases-api-types";
```

(c) Add the formatter after `productReleasesToAtom` (around line 296):

```ts
/**
 * Atom feed for a signed-in user's personalized follows feed. Aggregates
 * releases across every org/product they follow. The feed is served behind a
 * tokenized URL (`selfUrl`); `lookupId` (non-secret) seeds a stable feed id so
 * the id never embeds the secret. `alternateUrl` points at the web /following page.
 */
export function userFeedToAtom(
  params: { releases: ReleaseLatestItem[]; lookupId: string; selfUrl: string },
  opts: AtomFeedOptions,
): string {
  const entries: EntryInput[] = params.releases.map((release) => ({
    release,
    sourceSlug: release.source.slug,
    sourceName: release.source.name,
    orgName: null,
    linkHref: release.id ? `${opts.baseUrl}/release/${release.id}` : release.url,
  }));

  return buildFeed(
    {
      scope: "user",
      slug: params.lookupId,
      title: "Your followed releases",
      subtitle: "Releases from the organizations and products you follow on Releases.",
      selfUrl: params.selfUrl,
      alternateUrl: `${opts.baseUrl}/following`,
      authorName: "Releases",
      entries,
    },
    opts,
  );
}
```

Note: `ReleaseLatestItem` is assignable to the `EntryInput.release` field (`ReleaseItem`) — it's the latest-list superset. If `tsc` complains, widen `EntryInput.release` is NOT needed; instead cast at the map: `release: release as ReleaseItem`. Prefer no cast first; add it only if the build fails.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rendering && bun test src/atom.test.ts`
Expected: PASS (both new tests green).

- [ ] **Step 5: Type-check**

Run: `cd packages/rendering && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/rendering/src/atom.ts packages/rendering/src/atom.test.ts
git commit -m "feat(rendering): userFeedToAtom formatter + user scope (#1519)"
```

---

## Task 6: Management lane — `GET/POST/DELETE /me/feed/token`

**Files:**

- Modify: `workers/api/src/routes/me.ts`
- Test: `workers/api/test/feed-token-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/feed-token-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { meHandlers } from "../src/routes/me.js";

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("session", { user: { id: "u1", email: "t@e.com", name: "T" } });
    await next();
  });
  a.route("/", meHandlers);
  const env = { DB: h.db } as unknown as Record<string, unknown>;
  return { a, env };
}

// Request full URLs (not bare paths) so `new URL(c.req.url).origin` is
// deterministic — Hono's test client otherwise defaults the origin to
// http://localhost.
const BASE = "https://api.releases.sh";

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("/v1/me/feed/token", () => {
  it("GET returns null before any token is minted", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/me/feed/token`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: null });
  });

  it("POST mints a token and GET re-reveals the same feedUrl", async () => {
    const { a, env } = app();
    const post = await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env);
    expect(post.status).toBe(201);
    const minted = (await post.json()) as { feedUrl: string; lookupId: string };
    expect(minted.feedUrl).toContain("https://api.releases.sh/v1/feed/relf_");
    expect(minted.feedUrl).toContain(".atom");

    const get = await a.request(`${BASE}/me/feed/token`, {}, env);
    const body = (await get.json()) as { token: { feedUrl: string } | null };
    expect(body.token?.feedUrl).toBe(minted.feedUrl);
  });

  it("POST again rotates to a different feedUrl", async () => {
    const { a, env } = app();
    const first = (await (
      await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env)
    ).json()) as { feedUrl: string };
    const second = (await (
      await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env)
    ).json()) as { feedUrl: string };
    expect(second.feedUrl).not.toBe(first.feedUrl);
  });

  it("DELETE revokes — GET then returns null", async () => {
    const { a, env } = app();
    await a.request(`${BASE}/me/feed/token`, { method: "POST" }, env);
    const del = await a.request(`${BASE}/me/feed/token`, { method: "DELETE" }, env);
    expect(del.status).toBe(200);
    const get = await a.request(`${BASE}/me/feed/token`, {}, env);
    expect(await get.json()).toEqual({ token: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/api && bun test test/feed-token-routes.test.ts`
Expected: FAIL — routes not defined (404 / `token` undefined).

- [ ] **Step 3: Implement the handlers**

In `workers/api/src/routes/me.ts`:

(a) Extend the imports at the top:

```ts
import {
  upsertFeedToken,
  getFeedToken,
  deleteFeedToken,
  feedTokenString,
} from "../queries/feed-tokens.js";
import type { FeedToken } from "@buildinternet/releases-api-types";
```

Also add `type Context` to the existing hono import at the top of `me.ts` (currently `import { Hono } from "hono";` → `import { Hono, type Context } from "hono";`).

(b) Add a helper that builds the absolute feed URL from the request origin, then the three handlers. Insert after the existing `meHandlers.get("/me/feed", …)` handler (after line 97):

```ts
/**
 * Build the absolute, tokenized feed URL from the API worker's own request
 * origin — this worker serves /v1/feed/:token, so the URL must point back at it
 * (api.releases.sh in prod; the portless host in local dev). No env dependency.
 */
function feedUrlFor(c: Context<Env>, token: string): string {
  return `${new URL(c.req.url).origin}/v1/feed/${token}.atom`;
}

meHandlers.get("/me/feed/token", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const row = await getFeedToken(db, session.user.id);
  if (!row) return c.json({ token: null });
  const token: FeedToken = {
    feedUrl: feedUrlFor(c, feedTokenString(row)),
    lookupId: row.lookupId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
  return c.json({ token });
});

meHandlers.post("/me/feed/token", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const minted = await upsertFeedToken(db, session.user.id);
  const token: FeedToken = {
    feedUrl: feedUrlFor(c, minted.token),
    lookupId: minted.lookupId,
    createdAt: minted.createdAt.toISOString(),
    lastUsedAt: null,
  };
  return c.json(token, 201);
});

meHandlers.delete("/me/feed/token", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  await deleteFeedToken(db, session.user.id);
  return c.json({ success: true });
});
```

Note: if `c.env.API_BASE_URL` isn't already on the `Env` type, the test passes it in `env`; confirm `API_BASE_URL` is declared in `workers/api/src/index.ts`'s `Env` (grep shows it referenced for OAuth — it exists). If `tsc` flags it, the fallback `new URL(c.req.url).origin` covers prod regardless; the `??` short-circuit is safe.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/api && bun test test/feed-token-routes.test.ts`
Expected: PASS (all 4 tests green).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/me.ts workers/api/test/feed-token-routes.test.ts
git commit -m "feat(api): /me/feed/token mint/rotate/revoke management lane (#1519)"
```

---

## Task 7: Public read lane — `GET /v1/feed/:token`

**Files:**

- Create: `workers/api/src/routes/feed.ts`
- Modify: `workers/api/src/v1-routes.ts`
- Modify: `workers/api/src/index.ts`
- Test: `workers/api/test/feed-read-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/feed-read-route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { upsertFeedToken } from "../src/queries/feed-tokens.js";
import { feedRoutes } from "../src/routes/feed.js";

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.route("/", feedRoutes);
  const env = {
    DB: h.db,
    WEB_BASE_URL: "https://releases.sh",
    MEDIA_ORIGIN: "https://media.releases.sh",
  } as unknown as Record<string, unknown>;
  return { a, env };
}

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("GET /v1/feed/:token", () => {
  it("renders an Atom feed for a valid token (empty follows → valid empty feed)", async () => {
    const { a, env } = app();
    const { token } = await upsertFeedToken(h.db, "u1");
    const res = await a.request(`/feed/${token}.atom`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.text();
    expect(body).toContain("<feed");
    expect(body).toContain("Your followed releases");
  });

  it("404s for a malformed token", async () => {
    const { a, env } = app();
    const res = await a.request("/feed/garbage.atom", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown (well-formed) token", async () => {
    const { a, env } = app();
    const res = await a.request(`/feed/relf_${"a".repeat(12)}_${"b".repeat(32)}.atom`, {}, env);
    expect(res.status).toBe(404);
  });

  it("404s after the token is revoked", async () => {
    const { a, env } = app();
    const { token } = await upsertFeedToken(h.db, "u1");
    await upsertFeedToken(h.db, "u1"); // rotate → old token invalid
    const res = await a.request(`/feed/${token}.atom`, {}, env);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/api && bun test test/feed-read-route.test.ts`
Expected: FAIL — `../src/routes/feed.js` does not exist.

- [ ] **Step 3: Implement the read route**

Create `workers/api/src/routes/feed.ts` (note: the `@releases/rendering/*` specifiers below match the package's `exports` keys exactly — no `.js` suffix, same as `web/src/lib/atom.ts`. If the worker's `tsc` flags resolution, append `.js` to match sibling worker imports like `@releases/rendering/media-url.js`):

```ts
import { Hono } from "hono";
import { createDb } from "../db.js";
import { resolveFeedToken, touchFeedTokenLastUsed } from "../queries/feed-tokens.js";
import { getFollowedReleases, mapLatestRowToReleaseItem } from "../queries/releases.js";
import { parseFeedToken } from "@buildinternet/releases-core/api-token";
import { userFeedToAtom, ATOM_DEFAULT_MAX_ENTRIES } from "@releases/rendering/atom";
import { atomEtag, formatLastModified, shouldReturn304 } from "@releases/rendering/atom-http";
import type { Env } from "../index.js";

export const feedRoutes = new Hono<Env>();

/**
 * Public, token-authenticated personalized Atom feed. The `relf_` secret rides
 * in the path (a feed reader can't send a cookie/header). Any failure to resolve
 * → 404 (opaque, non-enumerable). The feed serves only public release data.
 */
feedRoutes.get("/feed/:token", async (c) => {
  // Strip an optional .atom/.rss suffix; both serve Atom (every reader accepts it).
  const raw = c.req.param("token").replace(/\.(atom|rss)$/, "");
  const parsed = parseFeedToken(raw);
  if (!parsed) return c.json({ error: "not_found" }, 404);

  const db = createDb(c.env.DB);
  const userId = await resolveFeedToken(db, raw);
  if (!userId) return c.json({ error: "not_found" }, 404);

  const rows = await getFollowedReleases(db, userId, {
    limit: ATOM_DEFAULT_MAX_ENTRIES,
    offset: 0,
  });
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releases = rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));

  const baseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";
  const selfUrl = `${new URL(c.req.url).origin}/v1/feed/${raw}.atom`;
  const body = userFeedToAtom({ releases, lookupId: parsed.lookupId, selfUrl }, { baseUrl });

  // Best-effort last_used_at — never block or fail the response.
  c.executionCtx?.waitUntil(touchFeedTokenLastUsed(db, parsed.lookupId).catch(() => {}));

  const etag = atomEtag(body);
  const lastModified = formatLastModified(new Date().toISOString());
  if (
    shouldReturn304(
      etag,
      lastModified,
      c.req.header("if-none-match") ?? null,
      c.req.header("if-modified-since") ?? null,
    )
  ) {
    return c.body(null, 304, { ETag: etag });
  }

  return c.body(body, 200, {
    "Content-Type": "application/atom+xml; charset=utf-8",
    "Cache-Control": "private, no-store",
    ETag: etag,
  });
});
```

- [ ] **Step 4: Mount the route**

In `workers/api/src/v1-routes.ts`, add the import alongside the other route imports (after line 58):

```ts
import { feedRoutes } from "./routes/feed.js";
```

and mount it alongside the other `v1.route("/", …)` calls (after line 111, near `meRoutes`):

```ts
v1.route("/", feedRoutes);
```

- [ ] **Step 5: Add rate limiting for the feed path**

In `workers/api/src/index.ts`, next to the existing `/me/*` rate-limit lines (around line 586-587), add:

```ts
v1.use("/feed/:token", publicRateLimitMiddleware);
```

(The feed route is intentionally NOT added to `publicReadRoutes` — it serves a binary Atom document, not a JSON API resource, so it's exempt from `publicReadAuthMiddleware` and the OpenAPI coverage gate, the same way `mediaRoutes`/`streamRoutes` are mounted directly.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd workers/api && bun test test/feed-read-route.test.ts`
Expected: PASS (all 4 tests green).

- [ ] **Step 7: Type-check the worker**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/routes/feed.ts workers/api/src/v1-routes.ts workers/api/src/index.ts workers/api/test/feed-read-route.test.ts
git commit -m "feat(api): public GET /v1/feed/:token Atom read lane (#1519)"
```

---

## Task 8: Web "Your feed" card on `/following`

**Files:**

- Modify: `web/src/app/following/following-client.tsx`

This task has no unit test (it's a client component wired to live endpoints); verify by type-check + manual review. Keep the data-fetching in a small local helper.

- [ ] **Step 1: Read the current following client**

Run: `sed -n '1,60p' web/src/app/following/following-client.tsx`
Note the existing imports, how it calls the API (look for an `api`/fetch helper and the API base URL), and where the page header/cards render.

- [ ] **Step 2: Add the feed-token card**

Add a `FeedTokenCard` component in `following-client.tsx` (or a sibling file `feed-token-card.tsx` if the client file is already large). It must:

- On mount, `GET ${API_BASE}/v1/me/feed/token` with `credentials: "include"`, set state `{ token: FeedToken | null }`.
- **No token:** render a "Generate a private feed URL" button → `POST ${API_BASE}/v1/me/feed/token` (`credentials: "include"`) → store the returned `FeedToken`.
- **Has token:** render the `feedUrl` in a read-only input + a **Copy** button (`navigator.clipboard.writeText`), the `createdAt`/`lastUsedAt` timestamps, a **Rotate** button (`window.confirm("Rotate your feed URL? Existing reader subscriptions will stop working.")` → `POST` → replace state), and a **Revoke** button (`window.confirm("Revoke your feed URL?")` → `DELETE` → set token to null).
- Render the inline note: _"Keep this URL private — anyone with it can read your followed-releases feed. Rotate to invalidate the old one."_

Concrete component (adjust the API-base import to match what the file already uses — e.g. `process.env.NEXT_PUBLIC_RELEASES_API_URL` or an existing `apiBase` helper):

```tsx
import { useEffect, useState } from "react";
import type { FeedToken, FeedTokenResponse } from "@buildinternet/releases-api-types";

const API_BASE = process.env.NEXT_PUBLIC_RELEASES_API_URL ?? "https://api.releases.sh";

export function FeedTokenCard() {
  const [token, setToken] = useState<FeedToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/v1/me/feed/token`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<FeedTokenResponse>) : { token: null }))
      .then((d) => setToken(d.token))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function mint() {
    const r = await fetch(`${API_BASE}/v1/me/feed/token`, {
      method: "POST",
      credentials: "include",
    });
    if (r.ok) setToken((await r.json()) as FeedToken);
  }

  async function rotate() {
    if (!window.confirm("Rotate your feed URL? Existing reader subscriptions will stop working."))
      return;
    await mint();
  }

  async function revoke() {
    if (!window.confirm("Revoke your feed URL?")) return;
    const r = await fetch(`${API_BASE}/v1/me/feed/token`, {
      method: "DELETE",
      credentials: "include",
    });
    if (r.ok) setToken(null);
  }

  function copy() {
    if (!token) return;
    void navigator.clipboard.writeText(token.feedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) return null;

  return (
    <section className="rounded-lg border p-4">
      <h2 className="font-medium">Your feed</h2>
      <p className="text-sm text-muted-foreground">
        Subscribe to everything you follow in any RSS/Atom reader.
      </p>
      {token ? (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={token.feedUrl}
              className="flex-1 rounded border bg-muted px-2 py-1 text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button onClick={copy} className="rounded border px-3 py-1 text-sm">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Keep this URL private — anyone with it can read your followed-releases feed. Rotate to
            invalidate the old one.
          </p>
          <div className="flex gap-3 text-sm">
            <button onClick={rotate} className="text-muted-foreground hover:underline">
              Rotate
            </button>
            <button onClick={revoke} className="text-destructive hover:underline">
              Revoke
            </button>
          </div>
        </div>
      ) : (
        <button onClick={mint} className="mt-3 rounded border px-3 py-1 text-sm">
          Generate a private feed URL
        </button>
      )}
    </section>
  );
}
```

Then render `<FeedTokenCard />` near the top of the `/following` page body (above or beside the follows list).

- [ ] **Step 3: Type-check the web app**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. (If `@buildinternet/releases-api-types` doesn't yet resolve `FeedToken`, ensure Task 2 is committed and the workspace is installed.)

- [ ] **Step 4: Commit**

```bash
git add web/src/app/following/
git commit -m "feat(web): 'Your feed' card — generate/copy/rotate/revoke feed URL (#1519)"
```

---

## Task 9: Full verification + PR

- [ ] **Step 1: Type-check root + workers**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit)`
Expected: PASS both.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: PASS (note: per repo convention `packages/` runs in its own bun process — if root `bun test` flags a `mock.module` leak, run `cd packages/core && bun test` and `cd packages/rendering && bun test` separately).

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. If format fails, run `bun run format` and amend.

- [ ] **Step 4: Apply the migration to local D1 and smoke the worker (optional but recommended)**

Run: `bun run db:reset:local` then start `bun run dev:api`, sign in locally, and:

- `POST` then `GET https://…/v1/me/feed/token` (cookie) → confirm the same `feedUrl`.
- Open the `feedUrl` in a browser → confirm a valid Atom document.
- Revoke → confirm the feed URL 404s.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin worktree-feed-token-1519
gh pr create --repo buildinternet/releases --title "feat: per-user authenticated Atom feed + relf_ feed token (#1519)" --body "$(cat <<'EOF'
Closes #1519.

Exposes each signed-in user's personalized follows feed as a tokenized, re-revealable Atom URL for any RSS/Atom reader.

## What's here
- **`relf_` feed token** (`packages/core`): generate/parse/shape helpers mirroring `relk_`.
- **`user_feed_tokens`** worker-local schema island + paired migration. One reversible row per user (secret stored plaintext — public-data feed, no PII).
- **Read lane** `GET /v1/feed/:token` (public, secret in path): resolves the token, renders `getFollowedReleases` through the new `userFeedToAtom` formatter. `private, no-store`, ETag/304. Any resolve failure → 404 (opaque).
- **Management lane** `GET/POST/DELETE /v1/me/feed/token` (cookie session): mint/rotate/revoke; GET re-reveals the full URL.
- **Web**: a "Your feed" card on `/following` (copy / rotate / revoke + keep-it-private note).

## Notes
- Atom only (every reader accepts it; `.rss` suffix serves the same document).
- No feature flag — the cookie session + token are the only gates (consistent with follows).
- Reversible token per the design decision: low-sensitivity public data, re-revealable like a calendar `.ics` URL.

Spec: `docs/superpowers/specs/2026-06-08-1519-user-feed-token-design.md`
Plan: `docs/superpowers/plans/2026-06-08-user-feed-token.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes (resolved)

- **Spec coverage:** token model (T1,T3,T4) · API-worker serving (T7) · path/single-rotatable token (T3,T4) · web UI (T8) · reversible/re-revealable (T2,T4,T6,T8) · `userFeedToAtom` (T5) · mint/rotate/revoke (T6) · migration (T3) · api-types (T2) · 404 error matrix (T7) · tests (T1,T4,T5,T6,T7). All covered.
- **Type consistency:** `FeedToken` shape (`feedUrl`/`lookupId`/`createdAt`/`lastUsedAt`) is identical across T2 (def), T6 (produced), T8 (consumed). `MintedFeedToken`/`feedTokenString`/`resolveFeedToken`/`touchFeedTokenLastUsed` names match between T4 (def) and T6/T7 (use).
- **Feed URL origin:** both lanes derive the absolute URL from `new URL(c.req.url).origin` (no env var) — this worker serves `/v1/feed/:token`, so its own request origin is authoritative (`api.releases.sh` in prod, the portless host locally). Tests request full base URLs so the origin is deterministic.
