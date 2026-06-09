# Digest Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in daily/weekly email digests of new releases from the orgs/products a signed-in user follows, with a one-click unsubscribe lane.

**Architecture:** A new worker-local `user_digest_prefs` table stores per-user cadence (`off`/`daily`/`weekly`) + a published-date watermark + an opaque `reld_` manage token. Two new Cloudflare crons (daily, weekly-Monday) gather each subscribed user's releases published since their watermark via a watermarked `getFollowedReleases`, render a grouped HTML+text email, and send it through the existing `AUTH_EMAIL` Email-Sending binding from `digests@releases.sh`. A session-or-Bearer `/v1/me/digest` toggle drives opt-in from the `/following` page; a public `/v1/digest/unsubscribe/:token` lane (opaque-404) handles one-click unsubscribe.

**Tech Stack:** Cloudflare Workers + Hono, Drizzle ORM on D1, Bun test, Cloudflare Email Service, Next.js (web), Flagship feature flags.

**Spec:** `docs/superpowers/specs/2026-06-09-digest-emails-design.md`

---

## File structure

| File                                                              | Responsibility                                               | Action |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| `packages/core/src/api-token.ts`                                  | Add `reld_` digest-token primitives                          | Modify |
| `packages/core/src/api-token.test.ts`                             | Digest-token tests                                           | Modify |
| `packages/lib/src/flags.ts`                                       | Add `digestEmailsEnabled` flag entry                         | Modify |
| `workers/api/src/db/schema-digest-prefs.ts`                       | `user_digest_prefs` schema island                            | Create |
| `workers/api/migrations/20260609000000_add_user_digest_prefs.sql` | Paired migration                                             | Create |
| `workers/api/src/queries/releases.ts`                             | Watermark params on `getFollowedReleases`                    | Modify |
| `workers/api/src/queries/digest-prefs.ts`                         | Prefs CRUD, token resolve, recipient list, watermark advance | Create |
| `packages/api-types/src/api-types.ts`                             | `DigestCadence` / `DigestPrefs` wire types                   | Modify |
| `workers/api/src/routes/me.ts`                                    | `GET`/`PUT /v1/me/digest` handlers                           | Modify |
| `workers/api/src/routes/digest.ts`                                | Public `/v1/digest/unsubscribe/:token` lane                  | Create |
| `workers/api/src/auth/email.ts`                                   | Add optional `headers` to `AuthEmailBinding`                 | Modify |
| `workers/api/src/lib/digest-email.ts`                             | Email template + sender                                      | Create |
| `workers/api/src/cron/send-digests.ts`                            | The cron gather→render→send module                           | Create |
| `workers/api/src/v1-routes.ts`                                    | Mount `digestRoutes`                                         | Modify |
| `workers/api/src/index.ts`                                        | Cron triggers dispatch + Env bindings                        | Modify |
| `workers/api/wrangler.jsonc`                                      | Crons, vars, sender allowlist (prod + staging)               | Modify |
| `web/src/lib/follows.ts`                                          | `getDigestPrefs` / `updateDigestPrefs` client                | Modify |
| `web/src/app/following/digest-card.tsx`                           | "Email digest" card                                          | Create |
| `web/src/app/following/following-client.tsx`                      | Mount the card                                               | Modify |

Tests for worker code live in `workers/api/test/*.test.ts` and import the shared `createTestDb` from `tests/db-helper.ts` (which auto-applies every migration under `workers/api/migrations/`, so the new migration must be valid `bun:sqlite` SQL).

---

## Task 1: Digest-token primitives in core

**Files:**

- Modify: `packages/core/src/api-token.ts` (after the feed-token block, ~line 126)
- Test: `packages/core/src/api-token.test.ts`

The digest manage token is a single opaque `reld_<secret>` string (no lookupId/secret split — unlike `relf_`, it's only ever matched by exact equality on a unique-indexed column, and unsubscribe is a low-sensitivity action). Reuse the existing private `genSecret` base62 generator.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/api-token.test.ts`:

```typescript
import { DIGEST_TOKEN_PREFIX, generateDigestToken, isDigestTokenShaped } from "./api-token.js";

describe("digest token", () => {
  it("generates a prefixed, shaped token", () => {
    const t = generateDigestToken();
    expect(t.startsWith(DIGEST_TOKEN_PREFIX)).toBe(true);
    expect(isDigestTokenShaped(t)).toBe(true);
    expect(t.length).toBeGreaterThan(DIGEST_TOKEN_PREFIX.length + 20);
  });

  it("generates distinct tokens", () => {
    expect(generateDigestToken()).not.toBe(generateDigestToken());
  });

  it("rejects non-digest shapes", () => {
    expect(isDigestTokenShaped("relf_abc")).toBe(false);
    expect(isDigestTokenShaped("relk_abc")).toBe(false);
    expect(isDigestTokenShaped("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/api-token.test.ts`
Expected: FAIL — `DIGEST_TOKEN_PREFIX`/`generateDigestToken`/`isDigestTokenShaped` are not exported.

- [ ] **Step 3: Add the primitives**

In `packages/core/src/api-token.ts`, after the `isFeedTokenShaped` function (~line 126):

```typescript
/**
 * Wire prefix for per-user digest manage tokens — the credential embedded in the
 * one-click unsubscribe URL in a digest email (`/v1/digest/unsubscribe/reld_…`).
 * Distinct from `relk_`/`relu_`/`relf_` so it's secret-scanning friendly and never
 * collides with the other lanes. A single opaque secret (no lookupId split): it is
 * only matched by exact equality on a unique-indexed column, and toggling a user's
 * own digest off is low-sensitivity. Reuses the base62 secret generator.
 */
export const DIGEST_TOKEN_PREFIX = "reld_";

export function generateDigestToken(): string {
  return `${DIGEST_TOKEN_PREFIX}${genSecret()}`;
}

/** Cheap prefix check — routes a path credential to the digest-token resolver. */
export function isDigestTokenShaped(raw: string): boolean {
  return raw.startsWith(DIGEST_TOKEN_PREFIX);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test src/api-token.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api-token.ts packages/core/src/api-token.test.ts
git commit -m "feat(core): reld_ digest manage-token primitives (#1518)"
```

---

## Task 2: Flag registry entry

**Files:**

- Modify: `packages/lib/src/flags.ts` (inside the `FLAGS` object)

- [ ] **Step 1: Add the flag entry**

In `packages/lib/src/flags.ts`, add to the `FLAGS` registry (alongside `wellKnownSyncEnabled`):

```typescript
  digestEmailsEnabled: {
    key: "digest-emails-enabled",
    env: "DIGEST_EMAILS_ENABLED",
    default: false,
  },
```

- [ ] **Step 2: Type-check**

Run: `cd packages/lib && npx tsc --noEmit`
Expected: PASS (the `satisfies Record<string, FlagDef>` constraint holds).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/src/flags.ts
git commit -m "feat(flags): add digest-emails-enabled kill switch (#1518)"
```

> **Manual follow-up (not code):** create the `digest-emails-enabled` boolean flag in BOTH Flagship apps (`releases-platform` and `releases-platform-staging`), default `false`. Noted in the spec; do this before flipping on in prod.

---

## Task 3: Schema island + paired migration

**Files:**

- Create: `workers/api/src/db/schema-digest-prefs.ts`
- Create: `workers/api/migrations/20260609000000_add_user_digest_prefs.sql`

- [ ] **Step 1: Create the schema island**

`workers/api/src/db/schema-digest-prefs.ts`:

```typescript
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { user } from "./schema-auth.js";

/**
 * Per-user digest email preferences — cadence + the published-date watermark + the
 * opaque `reld_` manage token for the no-login unsubscribe lane.
 *
 * Worker-local schema island (sibling of schema-follows.ts / schema-feed-tokens.ts),
 * deliberately NOT in the published `@buildinternet/releases-core` schema: user-coupled
 * data the OSS CLI has no business with. Queried via explicit `.select().from(userDigestPrefs)`
 * on a `createDb(...)` handle.
 *
 * One row per user (`user_id` unique). The row is created lazily on the first
 * `PUT /v1/me/digest`; absence == cadence `off`. `last_digest_at` is the content
 * watermark only (the crons drive scheduling): stamped to `now` on an off→on
 * transition, advanced to the cron `runStart` after a successful send.
 * `manage_token` is a reversible opaque secret (it only toggles the user's own
 * digest off). `user_id` cascades on account delete.
 *
 * Paired migration: 20260609000000_add_user_digest_prefs.sql.
 */
export const DIGEST_CADENCES = ["off", "daily", "weekly"] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

export const userDigestPrefs = sqliteTable(
  "user_digest_prefs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    cadence: text("cadence", { enum: DIGEST_CADENCES }).notNull().default("off"),
    lastDigestAt: integer("last_digest_at", { mode: "timestamp" }),
    manageToken: text("manage_token").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_user_digest_prefs_user").on(t.userId),
    uniqueIndex("idx_user_digest_prefs_token").on(t.manageToken),
    index("idx_user_digest_prefs_cadence").on(t.cadence),
  ],
);

export type UserDigestPrefs = typeof userDigestPrefs.$inferSelect;
export type NewUserDigestPrefs = typeof userDigestPrefs.$inferInsert;
```

- [ ] **Step 2: Create the paired migration**

`workers/api/migrations/20260609000000_add_user_digest_prefs.sql`:

```sql
-- User digest email preferences: cadence (off/daily/weekly), the published-date
-- watermark (last_digest_at), and the opaque reld_ manage token for the no-login
-- unsubscribe lane. Paired with workers/api/src/db/schema-digest-prefs.ts.
CREATE TABLE IF NOT EXISTS user_digest_prefs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  cadence        TEXT NOT NULL DEFAULT 'off',
  last_digest_at INTEGER,
  manage_token   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_digest_prefs_user
  ON user_digest_prefs (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_digest_prefs_token
  ON user_digest_prefs (manage_token);
CREATE INDEX IF NOT EXISTS idx_user_digest_prefs_cadence
  ON user_digest_prefs (cadence);
```

- [ ] **Step 3: Verify the migration applies in the test harness**

Run: `bun test workers/api/test/feed-tokens-query.test.ts`
Expected: PASS — this existing test calls `createTestDb()`, which applies every migration including the new one; a malformed migration would throw here.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/db/schema-digest-prefs.ts workers/api/migrations/20260609000000_add_user_digest_prefs.sql
git commit -m "feat(db): user_digest_prefs schema island + migration (#1518)"
```

---

## Task 4: Watermark params on `getFollowedReleases`

**Files:**

- Modify: `workers/api/src/queries/releases.ts` (`FollowedReleasesParams` + `getFollowedReleases`, ~lines 172-222)
- Test: `workers/api/test/follows-feed.test.ts`

`published_at` is stored as an ISO-8601 text column, so lexical `>` / `<=` comparison against ISO strings is a correct chronological compare. A set `publishedAfter` also excludes null-`published_at` rows automatically (NULL comparisons are false).

- [ ] **Step 1: Write the failing test**

Add to `workers/api/test/follows-feed.test.ts` (the harness already seeds `user`/orgs/products/sources; add releases inside the new test):

```typescript
import { addFollow } from "../src/queries/follows.js";

it("filters by the published-date watermark window", async () => {
  await addFollow(h.db, "u1", "org", "org_a");
  await h.db.insert(releases).values([
    {
      id: "rel_old",
      sourceId: "src_org",
      title: "Old",
      url: "https://a/1",
      publishedAt: "2026-01-01T00:00:00.000Z",
      fetchedAt: new Date(),
    },
    {
      id: "rel_in",
      sourceId: "src_org",
      title: "In window",
      url: "https://a/2",
      publishedAt: "2026-06-05T00:00:00.000Z",
      fetchedAt: new Date(),
    },
    {
      id: "rel_future",
      sourceId: "src_org",
      title: "After runStart",
      url: "https://a/3",
      publishedAt: "2026-06-09T23:00:00.000Z",
      fetchedAt: new Date(),
    },
  ]);

  const rows = await getFollowedReleases(h.db, "u1", {
    limit: 50,
    offset: 0,
    publishedAfter: "2026-06-01T00:00:00.000Z",
    publishedBefore: "2026-06-09T13:00:00.000Z",
  });

  const ids = rows.map((r) => r.id);
  expect(ids).toEqual(["rel_in"]);
});
```

> Confirm the exact `releases` insert columns against the seed block already in this file / `follows-feed.test.ts` (it inserts releases elsewhere). Match its required NOT NULL columns (`id`, `sourceId`, `title`, `fetchedAt`); add `publishedAt` and `url` as above.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/follows-feed.test.ts`
Expected: FAIL — `publishedAfter`/`publishedBefore` are not accepted (TS error) or ignored (returns all 3 ids).

- [ ] **Step 3: Extend the params type**

In `workers/api/src/queries/releases.ts`, replace `FollowedReleasesParams`:

```typescript
export interface FollowedReleasesParams {
  limit: number;
  offset: number;
  /** Inclusive-exclusive lower bound: only releases with published_at > this ISO string. */
  publishedAfter?: string | null;
  /** Upper bound: only releases with published_at <= this ISO string. */
  publishedBefore?: string | null;
}
```

- [ ] **Step 4: Add the watermark fragments to the SQL**

In `getFollowedReleases`, insert two conditional fragments into the `WHERE` clause, immediately after the `AND (r.prerelease IS NULL OR r.prerelease = 0)` line and before the `AND ( EXISTS (...` follow block:

```typescript
      AND (r.prerelease IS NULL OR r.prerelease = 0)
      ${params.publishedAfter ? sql`AND r.published_at > ${params.publishedAfter}` : sql``}
      ${params.publishedBefore ? sql`AND r.published_at <= ${params.publishedBefore}` : sql``}
      AND (
        EXISTS (SELECT 1 FROM user_follows uf
```

(No other change — when both params are absent, the fragments are empty `sql\`\`` and behavior is identical to today.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test workers/api/test/follows-feed.test.ts`
Expected: PASS (all existing tests in the file still pass — the new params are optional).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/queries/releases.ts workers/api/test/follows-feed.test.ts
git commit -m "feat(api): published-date watermark params on getFollowedReleases (#1518)"
```

---

## Task 5: Digest-prefs query layer

**Files:**

- Create: `workers/api/src/queries/digest-prefs.ts`
- Test: `workers/api/test/digest-prefs-query.test.ts`

- [ ] **Step 1: Write the failing test**

`workers/api/test/digest-prefs-query.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import {
  getDigestPrefs,
  setDigestCadence,
  unsubscribeByToken,
  listDigestRecipients,
  advanceDigestWatermark,
} from "../src/queries/digest-prefs.js";

let h: TestDatabase;

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values([
    {
      id: "u1",
      name: "T",
      email: "t@e.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "u2",
      name: "U",
      email: "u@e.com",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
});
afterEach(() => h.cleanup());

describe("digest prefs query layer", () => {
  it("returns null before any prefs exist", async () => {
    expect(await getDigestPrefs(h.db, "u1")).toBeNull();
  });

  it("enabling stamps a watermark and mints a manage token", async () => {
    const row = await setDigestCadence(h.db, "u1", "daily");
    expect(row.cadence).toBe("daily");
    expect(row.lastDigestAt).toBeInstanceOf(Date);
    expect(row.manageToken.startsWith("reld_")).toBe(true);
  });

  it("off→on stamps, daily→weekly keeps the watermark, on→off keeps the row+token", async () => {
    const first = await setDigestCadence(h.db, "u1", "daily");
    const wm = first.lastDigestAt!.getTime();
    const second = await setDigestCadence(h.db, "u1", "weekly");
    expect(second.lastDigestAt!.getTime()).toBe(wm); // unchanged
    const off = await setDigestCadence(h.db, "u1", "off");
    expect(off.cadence).toBe("off");
    expect(off.manageToken).toBe(first.manageToken); // token preserved
  });

  it("unsubscribeByToken sets cadence off; bad token → false", async () => {
    const row = await setDigestCadence(h.db, "u1", "daily");
    expect(await unsubscribeByToken(h.db, row.manageToken)).toBe(true);
    expect((await getDigestPrefs(h.db, "u1"))!.cadence).toBe("off");
    expect(await unsubscribeByToken(h.db, "reld_nope")).toBe(false);
    expect(await unsubscribeByToken(h.db, "garbage")).toBe(false);
  });

  it("listDigestRecipients returns only cadence-matching + verified users", async () => {
    await setDigestCadence(h.db, "u1", "daily"); // verified
    await setDigestCadence(h.db, "u2", "daily"); // UNverified
    const recips = await listDigestRecipients(h.db, "daily", 100);
    expect(recips.map((r) => r.userId)).toEqual(["u1"]);
    expect(recips[0].email).toBe("t@e.com");
  });

  it("advanceDigestWatermark moves the watermark to runStart", async () => {
    await setDigestCadence(h.db, "u1", "daily");
    const runStart = new Date("2026-06-09T13:00:00.000Z");
    await advanceDigestWatermark(h.db, "u1", runStart);
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime()).toBe(runStart.getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/digest-prefs-query.test.ts`
Expected: FAIL — `../src/queries/digest-prefs.js` does not exist.

- [ ] **Step 3: Implement the query layer**

`workers/api/src/queries/digest-prefs.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { generateDigestToken, isDigestTokenShaped } from "@buildinternet/releases-core/api-token";
import type { AnyDb } from "../db.js";
import {
  userDigestPrefs,
  type UserDigestPrefs,
  type DigestCadence,
} from "../db/schema-digest-prefs.js";
import { user } from "../db/schema-auth.js";

function newDigestPrefsId(): string {
  return `udp_${crypto.randomUUID()}`;
}

/** A digest send target: the user's address + their watermark + manage token. */
export interface DigestRecipient {
  userId: string;
  email: string;
  name: string | null;
  lastDigestAt: Date | null;
  manageToken: string;
}

/** Fetch the user's prefs row, or null if they've never set a preference. */
export async function getDigestPrefs(db: AnyDb, userId: string): Promise<UserDigestPrefs | null> {
  const row = await db
    .select()
    .from(userDigestPrefs)
    .where(eq(userDigestPrefs.userId, userId))
    .get();
  return row ?? null;
}

/**
 * Set the caller's cadence. Creates the row (minting a manage token) on first
 * call. Stamps `last_digest_at = now` ONLY on an off→on transition, so re-enabling
 * starts a fresh window (no backlog) while switching daily↔weekly preserves it.
 * Idempotent. Returns the resulting row.
 */
export async function setDigestCadence(
  db: AnyDb,
  userId: string,
  cadence: DigestCadence,
): Promise<UserDigestPrefs> {
  const now = new Date();
  const existing = await getDigestPrefs(db, userId);

  if (!existing) {
    const row: UserDigestPrefs = {
      id: newDigestPrefsId(),
      userId,
      cadence,
      lastDigestAt: cadence === "off" ? null : now,
      manageToken: generateDigestToken(),
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(userDigestPrefs).values(row);
    return row;
  }

  const enabling = existing.cadence === "off" && cadence !== "off";
  await db
    .update(userDigestPrefs)
    .set({ cadence, updatedAt: now, ...(enabling ? { lastDigestAt: now } : {}) })
    .where(eq(userDigestPrefs.userId, userId));

  return {
    ...existing,
    cadence,
    updatedAt: now,
    lastDigestAt: enabling ? now : existing.lastDigestAt,
  };
}

/**
 * Resolve a presented `reld_` manage token and set that user's cadence to `off`.
 * Returns true on a successful (idempotent) unsubscribe, false on an unknown or
 * malformed token. Never throws.
 */
export async function unsubscribeByToken(db: AnyDb, raw: string): Promise<boolean> {
  if (!isDigestTokenShaped(raw)) return false;
  const row = await db
    .select()
    .from(userDigestPrefs)
    .where(eq(userDigestPrefs.manageToken, raw))
    .get();
  if (!row) return false;
  if (row.cadence !== "off") {
    await db
      .update(userDigestPrefs)
      .set({ cadence: "off", updatedAt: new Date() })
      .where(eq(userDigestPrefs.userId, row.userId));
  }
  return true;
}

/**
 * All users due for a digest at the given cadence whose email is verified, joined
 * to their auth address. Capped at `limit` (oldest watermark first so a backlog
 * drains across runs). Unverified addresses are never returned.
 */
export async function listDigestRecipients(
  db: AnyDb,
  cadence: Exclude<DigestCadence, "off">,
  limit: number,
): Promise<DigestRecipient[]> {
  return db
    .select({
      userId: userDigestPrefs.userId,
      email: user.email,
      name: user.name,
      lastDigestAt: userDigestPrefs.lastDigestAt,
      manageToken: userDigestPrefs.manageToken,
    })
    .from(userDigestPrefs)
    .innerJoin(user, eq(user.id, userDigestPrefs.userId))
    .where(and(eq(userDigestPrefs.cadence, cadence), eq(user.emailVerified, true)))
    .orderBy(userDigestPrefs.lastDigestAt)
    .limit(limit)
    .all();
}

/** Advance a user's watermark to the cron run start after a successful send. */
export async function advanceDigestWatermark(
  db: AnyDb,
  userId: string,
  runStart: Date,
): Promise<void> {
  await db
    .update(userDigestPrefs)
    .set({ lastDigestAt: runStart, updatedAt: new Date() })
    .where(eq(userDigestPrefs.userId, userId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/test/digest-prefs-query.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/queries/digest-prefs.ts workers/api/test/digest-prefs-query.test.ts
git commit -m "feat(api): digest-prefs query layer (#1518)"
```

---

## Task 6: Wire types

**Files:**

- Modify: `packages/api-types/src/api-types.ts` (after the feed-token type block, ~line 856)

- [ ] **Step 1: Add the types**

```typescript
// ── Digest emails ──

/** How often a user wants a digest email. `off` = no emails. */
export type DigestCadence = "off" | "daily" | "weekly";

/** GET /v1/me/digest response — the caller's current cadence. */
export interface DigestPrefsResponse {
  cadence: DigestCadence;
}

/** PUT /v1/me/digest request body. */
export interface DigestPrefsRequest {
  cadence: DigestCadence;
}
```

- [ ] **Step 2: Type-check**

Run: `cd packages/api-types && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/api-types/src/api-types.ts
git commit -m "feat(api-types): DigestCadence + digest prefs wire types (#1518)"
```

---

## Task 7: `/v1/me/digest` handlers

**Files:**

- Modify: `workers/api/src/routes/me.ts` (add to `meHandlers`)
- Test: `workers/api/test/digest-routes.test.ts`

- [ ] **Step 1: Write the failing test**

`workers/api/test/digest-routes.test.ts`:

```typescript
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
  return { a, env: { DB: h.db } as unknown as Record<string, unknown> };
}

const BASE = "https://api.releases.sh";

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("/v1/me/digest", () => {
  it("GET defaults to off before any pref is set", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/me/digest`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ cadence: "off" });
  });

  it("PUT sets cadence and GET reflects it", async () => {
    const { a, env } = app();
    const put = await a.request(
      `${BASE}/me/digest`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cadence: "weekly" }),
      },
      env,
    );
    expect(put.status).toBe(200);
    expect((await put.json()) as any).toEqual({ cadence: "weekly" });

    const get = await a.request(`${BASE}/me/digest`, {}, env);
    expect((await get.json()) as any).toEqual({ cadence: "weekly" });
  });

  it("PUT rejects an invalid cadence with 400", async () => {
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/me/digest`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cadence: "hourly" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/digest-routes.test.ts`
Expected: FAIL — the `/me/digest` routes don't exist (404).

- [ ] **Step 3: Implement the handlers**

In `workers/api/src/routes/me.ts`, add imports at the top:

```typescript
import { getDigestPrefs, setDigestCadence } from "../queries/digest-prefs.js";
import { DIGEST_CADENCES, type DigestCadence } from "../db/schema-digest-prefs.js";
```

Add the handlers to `meHandlers` (next to the feed-token handlers):

```typescript
meHandlers.get("/me/digest", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const row = await getDigestPrefs(db, session.user.id);
  return c.json({ cadence: row?.cadence ?? "off" });
});

meHandlers.put("/me/digest", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const body = await c.req.json<{ cadence?: unknown }>().catch(() => ({}) as { cadence?: unknown });
  const cadence = body.cadence;
  if (typeof cadence !== "string" || !(DIGEST_CADENCES as readonly string[]).includes(cadence)) {
    return c.json({ error: "bad_request", message: "cadence must be off|daily|weekly" }, 400);
  }
  const db = createDb(c.env.DB);
  const row = await setDigestCadence(db, session.user.id, cadence as DigestCadence);
  return c.json({ cadence: row.cadence });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/test/digest-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/me.ts workers/api/test/digest-routes.test.ts
git commit -m "feat(api): GET/PUT /v1/me/digest cadence toggle (#1518)"
```

---

## Task 8: Public unsubscribe lane

**Files:**

- Create: `workers/api/src/routes/digest.ts`
- Modify: `workers/api/src/v1-routes.ts` (import + mount)
- Modify: `workers/api/src/index.ts` (rate-limit the `/digest/*` path)
- Test: `workers/api/test/digest-unsubscribe-route.test.ts`

This lane mirrors the public `relf_` feed lane: not under `publicReadRoutes` (so it's exempt from the OpenAPI coverage gate), opaque-404 on a bad token.

- [ ] **Step 1: Write the failing test**

`workers/api/test/digest-unsubscribe-route.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { setDigestCadence, getDigestPrefs } from "../src/queries/digest-prefs.js";
import { digestRoutes } from "../src/routes/digest.js";

let h: TestDatabase;

function app() {
  const a = new Hono();
  a.route("/", digestRoutes);
  return {
    a,
    env: { DB: h.db, WEB_BASE_URL: "https://releases.sh" } as unknown as Record<string, unknown>,
  };
}
const BASE = "https://api.releases.sh";

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("/v1/digest/unsubscribe/:token", () => {
  it("POST with a valid token sets cadence off (idempotent)", async () => {
    const row = await setDigestCadence(h.db, "u1", "daily");
    const { a, env } = app();
    const res = await a.request(
      `${BASE}/digest/unsubscribe/${row.manageToken}`,
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(200);
    expect((await getDigestPrefs(h.db, "u1"))!.cadence).toBe("off");
    // idempotent second call
    const again = await a.request(
      `${BASE}/digest/unsubscribe/${row.manageToken}`,
      { method: "POST" },
      env,
    );
    expect(again.status).toBe(200);
  });

  it("POST with a bad token → opaque 404", async () => {
    const { a, env } = app();
    const res = await a.request(`${BASE}/digest/unsubscribe/reld_nope`, { method: "POST" }, env);
    expect(res.status).toBe(404);
  });

  it("GET with a valid token confirms + unsubscribes", async () => {
    const row = await setDigestCadence(h.db, "u1", "weekly");
    const { a, env } = app();
    const res = await a.request(`${BASE}/digest/unsubscribe/${row.manageToken}`, {}, env);
    expect(res.status).toBe(200);
    expect((await getDigestPrefs(h.db, "u1"))!.cadence).toBe("off");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/digest-unsubscribe-route.test.ts`
Expected: FAIL — `../src/routes/digest.js` does not exist.

- [ ] **Step 3: Implement the route**

`workers/api/src/routes/digest.ts`:

```typescript
import { Hono } from "hono";
import { createDb } from "../db.js";
import { unsubscribeByToken } from "../queries/digest-prefs.js";
import type { Env } from "../index.js";

export const digestRoutes = new Hono<Env>();

/**
 * Public, token-authenticated one-click unsubscribe. The `reld_` token rides in
 * the path (an email client's List-Unsubscribe POST can't send a cookie/header).
 * Any unknown/malformed token → opaque 404 (non-enumerable). Idempotent.
 *
 * POST is the RFC 8058 One-Click target (List-Unsubscribe-Post). GET is the
 * human-clickable confirmation that also unsubscribes.
 */
async function handleUnsubscribe(c: Parameters<Parameters<typeof digestRoutes.post>[1]>[0]) {
  const raw = c.req.param("token");
  const db = createDb(c.env.DB);
  const ok = await unsubscribeByToken(db, raw);
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ success: true, unsubscribed: true });
}

digestRoutes.post("/digest/unsubscribe/:token", (c) => handleUnsubscribe(c));
digestRoutes.get("/digest/unsubscribe/:token", (c) => handleUnsubscribe(c));
```

> If the inline `Parameters<...>` context type is awkward under the project's lint, type the helper as `(c: Context<Env>)` importing `Context` from `hono` — match whichever the existing routes use (`feed.ts` uses the inline handler form).

- [ ] **Step 4: Mount the route**

In `workers/api/src/v1-routes.ts`, add the import (next to the `feedRoutes` import, line 57):

```typescript
import { digestRoutes } from "./routes/digest.js";
```

And mount it (next to `v1.route("/", feedRoutes);`, line 113):

```typescript
v1.route("/", digestRoutes);
```

- [ ] **Step 5: Rate-limit the public path**

In `workers/api/src/index.ts`, next to the `/feed/:token` rate-limit (line 590), add:

```typescript
// Token-authenticated unsubscribe — rate-limited, not under publicReadAuth.
v1.use("/digest/unsubscribe/:token", publicRateLimitMiddleware);
```

- [ ] **Step 6: Run test + verify the OpenAPI gate stays green**

Run: `bun test workers/api/test/digest-unsubscribe-route.test.ts`
Expected: PASS

Run: `bun run --cwd . scripts/check-openapi-coverage.ts` (or the package script the repo uses — check `package.json`; e.g. `bun run check:openapi`)
Expected: PASS — `/digest/*` is not in `publicReadRoutes`, so it's exempt.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/routes/digest.ts workers/api/src/v1-routes.ts workers/api/src/index.ts workers/api/test/digest-unsubscribe-route.test.ts
git commit -m "feat(api): public reld_ one-click unsubscribe lane (#1518)"
```

---

## Task 9: Email binding headers + digest template/sender

**Files:**

- Modify: `workers/api/src/auth/email.ts` (`AuthEmailBinding` interface — add optional `headers`)
- Create: `workers/api/src/lib/digest-email.ts`
- Test: `workers/api/test/digest-email.test.ts`

- [ ] **Step 1: Extend `AuthEmailBinding` with optional headers**

In `workers/api/src/auth/email.ts`, update the interface (lines 19-27):

```typescript
/** The Cloudflare Email Sending binding (object-form `send`). */
export interface AuthEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    html?: string;
    text?: string;
    /** Custom headers (e.g. List-Unsubscribe). Cloudflare rejects reserved/API-field headers. */
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}
```

- [ ] **Step 2: Write the failing test**

`workers/api/test/digest-email.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { buildDigestEmail, sendDigestEmail } from "../src/lib/digest-email.js";
import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";

function rel(over: Partial<ReleaseLatestItem>): ReleaseLatestItem {
  return {
    id: "rel_1",
    version: null,
    type: "feature",
    title: "Thing shipped",
    summary: "We shipped a thing.",
    titleGenerated: null,
    titleShort: "Thing",
    publishedAt: "2026-06-08T00:00:00.000Z",
    url: "https://acme.com/changelog/1",
    media: [],
    source: { slug: "blog", name: "Acme Blog", type: "feed", orgSlug: "acme" },
    product: { slug: "widget", name: "Widget" },
    coverageCount: 0,
    contentChars: null,
    contentTokens: null,
    ...over,
  } as ReleaseLatestItem;
}

describe("buildDigestEmail", () => {
  it("renders subject, text, and html with release + unsubscribe link", () => {
    const { subject, text, html } = buildDigestEmail({
      recipientName: "T",
      cadence: "daily",
      releases: [
        rel({}),
        rel({
          id: "rel_2",
          title: "Second",
          source: { slug: "blog", name: "Acme Blog", type: "feed", orgSlug: "acme" },
        }),
      ],
      baseUrl: "https://releases.sh",
      manageUrl: "https://releases.sh/following",
      unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
    });
    expect(subject).toContain("2"); // count in subject
    expect(text).toContain("Thing shipped");
    expect(text).toContain("https://releases.sh/release/rel_1");
    expect(text).toContain("reld_x"); // unsubscribe link in body
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("https://releases.sh/following");
  });
});

describe("sendDigestEmail", () => {
  it("returns no_binding when AUTH_EMAIL is absent", async () => {
    const res = await sendDigestEmail(
      { DIGEST_EMAIL_FROM: "digests@releases.sh" },
      {
        to: "t@e.com",
        recipientName: "T",
        cadence: "daily",
        releases: [rel({})],
        baseUrl: "https://releases.sh",
        manageUrl: "https://releases.sh/following",
        unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
      },
    );
    expect(res.sent).toBe(false);
  });

  it("sends with a List-Unsubscribe header through the binding", async () => {
    let captured: any = null;
    const res = await sendDigestEmail(
      {
        AUTH_EMAIL: {
          send: async (m: any) => {
            captured = m;
            return { messageId: "m1" };
          },
        } as any,
        DIGEST_EMAIL_FROM: "digests@releases.sh",
      },
      {
        to: "t@e.com",
        recipientName: "T",
        cadence: "weekly",
        releases: [rel({})],
        baseUrl: "https://releases.sh",
        manageUrl: "https://releases.sh/following",
        unsubscribeUrl: "https://api.releases.sh/v1/digest/unsubscribe/reld_x",
      },
    );
    expect(res.sent).toBe(true);
    expect(captured.from).toContain("digests@releases.sh");
    expect(captured.headers["List-Unsubscribe"]).toContain("reld_x");
    expect(captured.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test workers/api/test/digest-email.test.ts`
Expected: FAIL — `../src/lib/digest-email.js` does not exist.

- [ ] **Step 4: Implement the template + sender**

`workers/api/src/lib/digest-email.ts`:

```typescript
import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";
import type { AuthEmailBinding } from "../auth/email.js";

export interface DigestEmailEnv {
  AUTH_EMAIL?: AuthEmailBinding;
  DIGEST_EMAIL_FROM?: string;
  ENVIRONMENT?: string;
}

export interface DigestEmailContent {
  recipientName: string | null;
  cadence: "daily" | "weekly";
  releases: ReleaseLatestItem[];
  /** Web origin, e.g. https://releases.sh — release/org links are built from it. */
  baseUrl: string;
  /** Manage-preferences URL (the /following page). */
  manageUrl: string;
  /** One-click unsubscribe URL (the reld_ token lane). */
  unsubscribeUrl: string;
}

export type DigestEmailInput = DigestEmailContent & { to: string };

const DEFAULT_FROM = "digests@releases.sh";
const FROM_NAME = "Releases";

/** Escape the five HTML-significant chars for safe interpolation into markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bestTitle(r: ReleaseLatestItem): string {
  return r.titleShort || r.titleGenerated || r.title || r.version || "Update";
}

function releaseUrl(baseUrl: string, r: ReleaseLatestItem): string {
  return `${baseUrl}/release/${r.id}`;
}

/** Group releases by owning org slug, preserving input (published-desc) order. */
function groupByOrg(
  releases: ReleaseLatestItem[],
): Array<{ orgSlug: string | null; orgName: string; items: ReleaseLatestItem[] }> {
  const groups = new Map<
    string,
    { orgSlug: string | null; orgName: string; items: ReleaseLatestItem[] }
  >();
  for (const r of releases) {
    const key = r.source.orgSlug ?? r.source.name;
    let g = groups.get(key);
    if (!g) {
      g = { orgSlug: r.source.orgSlug, orgName: r.source.name, items: [] };
      groups.set(key, g);
    }
    g.items.push(r);
  }
  return [...groups.values()];
}

export function buildDigestEmail(content: DigestEmailContent): {
  subject: string;
  text: string;
  html: string;
} {
  const { releases, baseUrl, manageUrl, unsubscribeUrl, cadence } = content;
  const n = releases.length;
  const period = cadence === "daily" ? "daily" : "weekly";
  const subject = `Your ${period} Releases digest — ${n} update${n === 1 ? "" : "s"}`;
  const groups = groupByOrg(releases);

  // ── Plain text ──
  const textLines: string[] = [
    `Your ${period} Releases digest — ${n} update${n === 1 ? "" : "s"}`,
    "",
  ];
  for (const g of groups) {
    textLines.push(g.orgName.toUpperCase());
    for (const r of g.items) {
      const prod = r.product ? ` (${r.product.name})` : "";
      textLines.push(`  • ${bestTitle(r)}${prod}`);
      if (r.summary) textLines.push(`    ${r.summary}`);
      textLines.push(`    ${releaseUrl(baseUrl, r)}`);
    }
    textLines.push("");
  }
  textLines.push("—");
  textLines.push(`Manage your digest: ${manageUrl}`);
  textLines.push(`Unsubscribe: ${unsubscribeUrl}`);
  const text = textLines.join("\n");

  // ── HTML ──
  const htmlParts: string[] = [
    `<h1 style="font:600 18px system-ui,sans-serif">Your ${period} Releases digest — ${n} update${n === 1 ? "" : "s"}</h1>`,
  ];
  for (const g of groups) {
    const orgHeading = g.orgSlug
      ? `<a href="${esc(`${baseUrl}/${g.orgSlug}`)}" style="color:#111;text-decoration:none">${esc(g.orgName)}</a>`
      : esc(g.orgName);
    htmlParts.push(
      `<h2 style="font:600 14px system-ui,sans-serif;margin-top:20px">${orgHeading}</h2>`,
    );
    for (const r of g.items) {
      const prod = r.product ? ` <span style="color:#888">(${esc(r.product.name)})</span>` : "";
      htmlParts.push(
        `<p style="margin:8px 0;font:14px system-ui,sans-serif">` +
          `<a href="${esc(releaseUrl(baseUrl, r))}" style="font-weight:600;color:#1a56db;text-decoration:none">${esc(bestTitle(r))}</a>${prod}` +
          (r.summary ? `<br><span style="color:#444">${esc(r.summary)}</span>` : "") +
          `</p>`,
      );
    }
  }
  htmlParts.push(
    `<hr style="margin-top:24px;border:none;border-top:1px solid #eee">` +
      `<p style="font:12px system-ui,sans-serif;color:#888">` +
      `<a href="${esc(manageUrl)}" style="color:#888">Manage your digest</a> · ` +
      `<a href="${esc(unsubscribeUrl)}" style="color:#888">Unsubscribe</a></p>`,
  );
  const html = htmlParts.join("");

  return { subject, text, html };
}

/**
 * Render + send a digest through the Cloudflare Email Sending binding. Never throws
 * — a missing binding or send error degrades to a logged `{ sent: false }` so the
 * cron loop can fire-and-forget per recipient. Adds RFC 8058 List-Unsubscribe
 * headers for one-click unsubscribe.
 */
export async function sendDigestEmail(
  env: DigestEmailEnv,
  input: DigestEmailInput,
): Promise<{ sent: boolean; reason?: "no_binding" | "error" }> {
  const { subject, text, html } = buildDigestEmail(input);
  const addr = env.DIGEST_EMAIL_FROM || DEFAULT_FROM;
  const from = `${FROM_NAME} <${addr}>`;

  if (!env.AUTH_EMAIL) {
    logEvent("warn", {
      component: "digest",
      event: "email-no-binding",
      message: `AUTH_EMAIL binding absent; digest not sent to ${input.to}`,
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "no_binding" };
  }

  try {
    await env.AUTH_EMAIL.send({
      to: input.to,
      from,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    logEvent("info", {
      component: "digest",
      event: "email-sent",
      message: `Sent ${input.cadence} digest to ${input.to}`,
      count: input.releases.length,
      environment: env.ENVIRONMENT,
    });
    return { sent: true };
  } catch (err) {
    logEvent("error", {
      component: "digest",
      event: "email-send-failed",
      message: `Failed to send digest to ${input.to}`,
      error: err instanceof Error ? err.message : String(err),
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "error" };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test workers/api/test/digest-email.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/auth/email.ts workers/api/src/lib/digest-email.ts workers/api/test/digest-email.test.ts
git commit -m "feat(api): digest email template + sender with List-Unsubscribe (#1518)"
```

---

## Task 10: `sendDigests` cron module

**Files:**

- Create: `workers/api/src/cron/send-digests.ts`
- Test: `workers/api/test/send-digests-cron.test.ts`

- [ ] **Step 1: Write the failing test**

`workers/api/test/send-digests-cron.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { addFollow } from "../src/queries/follows.js";
import { setDigestCadence, getDigestPrefs } from "../src/queries/digest-prefs.js";
import { sendDigests } from "../src/cron/send-digests.js";

let h: TestDatabase;
let sent: Array<{ to: string; subject: string }>;

function env(over: Record<string, unknown> = {}) {
  sent = [];
  return {
    DB: {} as any,
    AUTH_EMAIL: {
      send: async (m: any) => {
        sent.push({ to: m.to, subject: m.subject });
        return { messageId: "m" };
      },
    },
    DIGEST_EMAIL_FROM: "digests@releases.sh",
    WEB_BASE_URL: "https://releases.sh",
    MEDIA_ORIGIN: "https://media.releases.sh",
    DIGEST_MAX_PER_RUN: "100",
    DIGEST_MAX_RELEASES: "50",
    CRON_ENABLED: "true",
    DIGEST_EMAILS_ENABLED: "true", // var fallback; FLAGS binding absent in tests
    _drizzleOverride: h.db as any,
    ...over,
  } as any;
}

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db.insert(sources).values({
    id: "src_a",
    name: "Blog",
    slug: "blog",
    type: "feed",
    url: "https://a/blog",
    orgId: "org_a",
  });
  await addFollow(h.db, "u1", "org", "org_a");
  await setDigestCadence(h.db, "u1", "daily"); // stamps watermark = now
});
afterEach(() => h.cleanup());

describe("sendDigests cron", () => {
  it("sends + advances the watermark when there are new releases", async () => {
    // A release published AFTER the watermark (now-ish), before runStart.
    await h.db.insert(releases).values({
      id: "rel_new",
      sourceId: "src_a",
      title: "Shipped",
      url: "https://a/1",
      publishedAt: new Date(Date.now() + 1000).toISOString(),
      fetchedAt: new Date(),
    });
    const runStart = new Date(Date.now() + 60_000);
    await sendDigests(env(), { cadence: "daily", runStart });
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("t@e.com");
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime()).toBe(runStart.getTime());
  });

  it("no releases → no send, watermark unchanged", async () => {
    const before = (await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime();
    await sendDigests(env(), { cadence: "daily", runStart: new Date(Date.now() + 60_000) });
    expect(sent.length).toBe(0);
    expect((await getDigestPrefs(h.db, "u1"))!.lastDigestAt!.getTime()).toBe(before);
  });

  it("skips unverified recipients", async () => {
    await h.db.update(user).set({ emailVerified: false }).where(eq(user.id, "u1"));
    await h.db.insert(releases).values({
      id: "rel_x",
      sourceId: "src_a",
      title: "X",
      url: "https://a/x",
      publishedAt: new Date(Date.now() + 1000).toISOString(),
      fetchedAt: new Date(),
    });
    await sendDigests(env(), { cadence: "daily", runStart: new Date(Date.now() + 60_000) });
    expect(sent.length).toBe(0);
  });

  it("no-ops when CRON_ENABLED=false", async () => {
    await sendDigests(env({ CRON_ENABLED: "false" }), { cadence: "daily", runStart: new Date() });
    expect(sent.length).toBe(0);
  });

  it("no-ops when the flag is off", async () => {
    await sendDigests(env({ DIGEST_EMAILS_ENABLED: "false" }), {
      cadence: "daily",
      runStart: new Date(),
    });
    expect(sent.length).toBe(0);
  });
});
```

> Add `import { eq } from "drizzle-orm";` at the top of this test (used by the unverified-recipient case).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/send-digests-cron.test.ts`
Expected: FAIL — `../src/cron/send-digests.js` does not exist.

- [ ] **Step 3: Implement the cron module**

`workers/api/src/cron/send-digests.ts`:

```typescript
import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { createDb } from "../db.js";
import { listDigestRecipients, advanceDigestWatermark } from "../queries/digest-prefs.js";
import { getFollowedReleases, mapLatestRowToReleaseItem } from "../queries/releases.js";
import { sendDigestEmail } from "../lib/digest-email.js";
import type { AuthEmailBinding } from "../auth/email.js";

export interface SendDigestsEnv {
  DB: D1Database;
  AUTH_EMAIL?: AuthEmailBinding;
  DIGEST_EMAIL_FROM?: string;
  WEB_BASE_URL?: string;
  MEDIA_ORIGIN?: string;
  FLAGS?: FlagshipBinding;
  DIGEST_EMAILS_ENABLED?: string;
  CRON_ENABLED?: string;
  DIGEST_MAX_PER_RUN?: string;
  DIGEST_MAX_RELEASES?: string;
  ENVIRONMENT?: string;
  /** TEST-ONLY: use this drizzle handle instead of createDb(env.DB). */
  _drizzleOverride?: ReturnType<typeof createDb>;
}

export interface SendDigestsArgs {
  cadence: "daily" | "weekly";
  runStart: Date;
}

const DEFAULT_MAX_PER_RUN = 500;
const DEFAULT_MAX_RELEASES = 50;

function parsePositive(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/**
 * Gather → render → send digests for one cadence. For each verified, subscribed
 * user: select releases published in `(last_digest_at, runStart]` from everything
 * they follow; if none, skip (watermark unchanged); else send and advance the
 * watermark to `runStart`. Per-recipient failures are logged and never abort the
 * loop. Gated by CRON_ENABLED + the digest-emails-enabled flag.
 */
export async function sendDigests(env: SendDigestsEnv, args: SendDigestsArgs): Promise<void> {
  const { cadence, runStart } = args;

  if (env.CRON_ENABLED === "false") {
    logEvent("info", { component: "digest", event: "cron-disabled", cadence });
    return;
  }
  if (!(await flag(env.FLAGS, env.DIGEST_EMAILS_ENABLED, FLAGS.digestEmailsEnabled))) {
    logEvent("info", { component: "digest", event: "flag-off", cadence });
    return;
  }

  const db = env._drizzleOverride ?? createDb(env.DB);
  const maxPerRun = parsePositive(env.DIGEST_MAX_PER_RUN, DEFAULT_MAX_PER_RUN);
  const maxReleases = parsePositive(env.DIGEST_MAX_RELEASES, DEFAULT_MAX_RELEASES);
  const baseUrl = env.WEB_BASE_URL ?? "https://releases.sh";
  const mediaOrigin = env.MEDIA_ORIGIN ?? "";
  const before = runStart.toISOString();

  const recipients = await listDigestRecipients(db, cadence, maxPerRun);
  let sentCount = 0;
  let emptyCount = 0;
  let failCount = 0;

  for (const recip of recipients) {
    const after = recip.lastDigestAt ? recip.lastDigestAt.toISOString() : null;
    const rows = await getFollowedReleases(db, recip.userId, {
      limit: maxReleases,
      offset: 0,
      publishedAfter: after,
      publishedBefore: before,
    });
    if (rows.length === 0) {
      emptyCount++;
      continue;
    }
    const releases = rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));
    const res = await sendDigestEmail(env, {
      to: recip.email,
      recipientName: recip.name,
      cadence,
      releases,
      baseUrl,
      manageUrl: `${baseUrl}/following`,
      unsubscribeUrl: unsubscribeUrlFor(env, recip.manageToken),
    });
    if (res.sent) {
      await advanceDigestWatermark(db, recip.userId, runStart);
      sentCount++;
    } else {
      failCount++;
    }
  }

  logEvent("info", {
    component: "digest",
    event: "run-done",
    cadence,
    considered: recipients.length,
    sent: sentCount,
    emptySkipped: emptyCount,
    failed: failCount,
    capped: recipients.length >= maxPerRun,
  });
}

/**
 * Build the absolute unsubscribe URL. Points at the API worker (it serves
 * /v1/digest/unsubscribe/:token). API_BASE_URL is the worker's own public origin;
 * fall back to the prod host.
 */
function unsubscribeUrlFor(env: SendDigestsEnv & { API_BASE_URL?: string }, token: string): string {
  const apiOrigin = env.API_BASE_URL ?? "https://api.releases.sh";
  return `${apiOrigin}/v1/digest/unsubscribe/${token}`;
}
```

> **Check the `API_BASE_URL` var name.** Grep `workers/api/src/index.ts` / `wrangler.jsonc` for the var that holds the API worker's own public origin (e.g. `API_BASE_URL`, `API_PUBLIC_URL`, or derive from `WEB_BASE_URL`→`api.` host). Wire it into `SendDigestsEnv` and `unsubscribeUrlFor`, and pass it from the cron dispatch in Task 11. If no such var exists, add `API_BASE_URL=https://api.releases.sh` to `wrangler.jsonc` (prod) in Task 11.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/api/test/send-digests-cron.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/cron/send-digests.ts workers/api/test/send-digests-cron.test.ts
git commit -m "feat(api): sendDigests cron module (gather/render/send) (#1518)"
```

---

## Task 11: Cron triggers + config wiring

**Files:**

- Modify: `workers/api/src/index.ts` (Env bindings + two `scheduled()` dispatch branches)
- Modify: `workers/api/wrangler.jsonc` (crons, vars, sender allowlist — prod + staging)

- [ ] **Step 1: Add Env bindings**

In `workers/api/src/index.ts`, add to the `Bindings` type (next to the existing `AUTH_EMAIL?` / `EMAIL_*` declarations, ~lines 210-213, 342-345):

```typescript
    DIGEST_EMAIL_FROM?: string;
    DIGEST_MAX_PER_RUN?: string;
    DIGEST_MAX_RELEASES?: string;
    DIGEST_EMAILS_ENABLED?: string;
    API_BASE_URL?: string;
```

(Skip any line that already exists — e.g. `API_BASE_URL` may already be declared; reuse it.)

- [ ] **Step 2: Add the two cron dispatch branches**

In the `scheduled()` handler in `workers/api/src/index.ts`, add an import at the top:

```typescript
import { sendDigests } from "./cron/send-digests.js";
```

Add two new branches (next to the other daily crons, e.g. after the `0 7 * * *` branch):

```typescript
if (event.cron === "0 13 * * *") {
  ctx.waitUntil(
    loggedDispatch(
      "digest-daily-cron",
      sendDigests(
        {
          DB: env.DB,
          AUTH_EMAIL: env.AUTH_EMAIL,
          DIGEST_EMAIL_FROM: env.DIGEST_EMAIL_FROM,
          WEB_BASE_URL: env.WEB_BASE_URL,
          MEDIA_ORIGIN: env.MEDIA_ORIGIN,
          FLAGS: env.FLAGS,
          DIGEST_EMAILS_ENABLED: env.DIGEST_EMAILS_ENABLED,
          CRON_ENABLED: env.CRON_ENABLED,
          DIGEST_MAX_PER_RUN: env.DIGEST_MAX_PER_RUN,
          DIGEST_MAX_RELEASES: env.DIGEST_MAX_RELEASES,
          API_BASE_URL: env.API_BASE_URL,
          ENVIRONMENT: env.ENVIRONMENT,
        },
        { cadence: "daily", runStart: new Date(event.scheduledTime) },
      ),
      alertEnv,
    ),
  );
  return;
}
if (event.cron === "0 13 * * 1") {
  ctx.waitUntil(
    loggedDispatch(
      "digest-weekly-cron",
      sendDigests(
        {
          DB: env.DB,
          AUTH_EMAIL: env.AUTH_EMAIL,
          DIGEST_EMAIL_FROM: env.DIGEST_EMAIL_FROM,
          WEB_BASE_URL: env.WEB_BASE_URL,
          MEDIA_ORIGIN: env.MEDIA_ORIGIN,
          FLAGS: env.FLAGS,
          DIGEST_EMAILS_ENABLED: env.DIGEST_EMAILS_ENABLED,
          CRON_ENABLED: env.CRON_ENABLED,
          DIGEST_MAX_PER_RUN: env.DIGEST_MAX_PER_RUN,
          DIGEST_MAX_RELEASES: env.DIGEST_MAX_RELEASES,
          API_BASE_URL: env.API_BASE_URL,
          ENVIRONMENT: env.ENVIRONMENT,
        },
        { cadence: "weekly", runStart: new Date(event.scheduledTime) },
      ),
      alertEnv,
    ),
  );
  return;
}
```

> **Cron-match ordering caveat:** `0 13 * * 1` (Monday 13:00) and `0 13 * * *` (every day 13:00) both fire on Mondays at 13:00 as _separate_ scheduled events with distinct `event.cron` strings — Cloudflare delivers one event per matching trigger, so a Monday fires both the daily and weekly handlers. That's correct (daily subscribers get daily, weekly get weekly). No special-casing needed.

- [ ] **Step 3: Add the cron triggers + vars + sender allowlist (prod)**

In `workers/api/wrangler.jsonc`:

(a) Add the two triggers to the prod `triggers.crons` array (and a comment above, line ~352):

```jsonc
      "0 13 * * *",
      "0 13 * * 1",
```

(b) Add vars to the prod `vars` block (next to the `AUTH_EMAIL_FROM` lines, ~line 83):

```jsonc
    "DIGEST_EMAIL_FROM": "digests@releases.sh",
    "DIGEST_MAX_PER_RUN": "500",
    "DIGEST_MAX_RELEASES": "50",
```

(c) Add `digests@releases.sh` to the `AUTH_EMAIL` binding's `allowed_sender_addresses` in the prod `send_email` block (line ~259):

```jsonc
    { "name": "AUTH_EMAIL", "allowed_sender_addresses": ["noreply@releases.sh", "digests@releases.sh"] },
```

(d) If `API_BASE_URL` is not already a prod var, add it:

```jsonc
    "API_BASE_URL": "https://api.releases.sh",
```

- [ ] **Step 4: Update staging (no crons, but keep binding parity)**

In the staging block of `workers/api/wrangler.jsonc`: add the same three `DIGEST_*` vars to the staging `vars` block (~line 559), and add `digests@releases.sh` to the staging `send_email` `AUTH_EMAIL` `allowed_sender_addresses` (line ~654). **Do not** add the cron triggers to staging (staging has `"crons": []`).

- [ ] **Step 5: Type-check the worker**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/index.ts workers/api/wrangler.jsonc
git commit -m "feat(api): wire daily/weekly digest crons + config (#1518)"
```

---

## Task 12: Web "Email digest" card

**Files:**

- Modify: `web/src/lib/follows.ts` (client helpers)
- Create: `web/src/app/following/digest-card.tsx`
- Modify: `web/src/app/following/following-client.tsx` (mount the card)

- [ ] **Step 1: Add the client helpers**

In `web/src/lib/follows.ts`, add (after the feed-token helpers, ~line 77; reuse the file's existing `apiBase()` / `errorMessage()` helpers):

```typescript
// ── Digest email prefs (/v1/me/digest) ──────────────────────────────────────

import type { DigestCadence, DigestPrefsResponse } from "@buildinternet/releases-api-types";

export async function getDigestCadence(): Promise<DigestCadence> {
  const res = await fetch(`${apiBase()}/v1/me/digest`, { credentials: "include" });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to load digest setting (${res.status})`));
  return ((await res.json()) as DigestPrefsResponse).cadence;
}

export async function setDigestCadence(cadence: DigestCadence): Promise<DigestCadence> {
  const res = await fetch(`${apiBase()}/v1/me/digest`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cadence }),
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to update digest setting (${res.status})`));
  return ((await res.json()) as DigestPrefsResponse).cadence;
}
```

> Place the `import type` with the other top-of-file imports rather than mid-file if the project's lint requires it (check `web/src/lib/follows.ts`'s existing import grouping).

- [ ] **Step 2: Create the card**

`web/src/app/following/digest-card.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import type { DigestCadence } from "@buildinternet/releases-api-types";
import { getDigestCadence, setDigestCadence } from "@/lib/follows";

const OPTIONS: Array<{ value: DigestCadence; label: string }> = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export function DigestCard() {
  const [cadence, setCadence] = useState<DigestCadence>("off");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDigestCadence()
      .then((c) => setCadence(c))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load."))
      .finally(() => setLoading(false));
  }, []);

  async function choose(next: DigestCadence) {
    if (next === cadence || busy) return;
    setBusy(true);
    setError(null);
    const prev = cadence;
    setCadence(next); // optimistic
    try {
      setCadence(await setDigestCadence(next));
    } catch (err) {
      setCadence(prev);
      setError(err instanceof Error ? err.message : "Failed to update.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 p-4">
      <h2 className="text-sm font-semibold text-gray-900">Email digest</h2>
      <p className="mt-1 text-xs text-gray-500">
        Get an email with new releases from everything you follow.
      </p>
      {loading ? (
        <p className="mt-3 text-xs text-gray-400">Loading…</p>
      ) : (
        <div className="mt-3 inline-flex rounded-md border border-gray-200" role="group">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={busy}
              aria-pressed={cadence === o.value}
              onClick={() => choose(o.value)}
              className={`px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md ${
                cadence === o.value ? "bg-gray-900 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
```

> Match the existing `FeedTokenCard`'s exact wrapper classes/tokens for visual consistency — open `web/src/app/following/feed-token-card.tsx` and mirror its container, heading, and button styling rather than the placeholder Tailwind above.

- [ ] **Step 3: Mount the card**

In `web/src/app/following/following-client.tsx`, import it (next to the `FeedTokenCard` import, ~line 11):

```typescript
import { DigestCard } from "./digest-card";
```

And render it in the sidebar `<aside>` next to `<FeedTokenCard />` (~line 241):

```typescript
        <aside className="space-y-6">
          <DigestCard />
          <FeedTokenCard />
```

- [ ] **Step 4: Type-check the web app**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/follows.ts web/src/app/following/digest-card.tsx web/src/app/following/following-client.tsx
git commit -m "feat(web): email-digest cadence card on /following (#1518)"
```

---

## Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full worker + package test suites**

Run: `bun test`
Expected: PASS (all new tests + no regressions). If a `bun test` monorepo run leaks module mocks across packages, run the package suites separately (`cd packages/core && bun test`, etc.) per the repo's memory note.

- [ ] **Step 2: Type-check root + each touched workspace**

Run:

```bash
npx tsc --noEmit
cd workers/api && npx tsc --noEmit && cd ../..
cd web && npx tsc --noEmit && cd ../..
cd packages/api-types && npx tsc --noEmit && cd ../../..
```

Expected: PASS everywhere.

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS (run `bun run format` to fix formatting if needed).

- [ ] **Step 4: Confirm the schema↔migration CI gate is satisfied**

Run the repo's schema-pairing check (grep `package.json` scripts for it, e.g. `bun run check:schema` or the marker-migration check). The new `schema-digest-prefs.ts` is paired with `20260609000000_add_user_digest_prefs.sql`, so the gate passes.

- [ ] **Step 5: Final commit (if any formatting changes)**

```bash
git add -A
git commit -m "chore: format + lint pass for digest emails (#1518)"
```

---

## Post-merge / deploy checklist (not code — for the operator)

1. Create the `digest-emails-enabled` boolean flag in BOTH Flagship apps (`releases-platform`, `releases-platform-staging`), default `false`.
2. Confirm the deploy carried the `AUTH_EMAIL` `allowed_sender_addresses` update (so `digests@releases.sh` is accepted) and the two new cron triggers.
3. Smoke: set your own user to `daily` via `/following`, manually trigger the daily cron (or wait for 13:00 UTC) with the flag **on for a test window**, confirm the email arrives with a working one-click unsubscribe, then decide on the prod rollout.
4. Leave the flag **off** until the smoke passes.

---

## Spec coverage self-check

- Cadence storage (off/daily/weekly) → Tasks 3, 5, 7. ✅
- Published-date watermark (enable=now, send→runStart, empty=unchanged) → Tasks 4, 5, 10. ✅
- Sender `digests@releases.sh` + allowlist → Tasks 9, 11. ✅
- Two crons (daily, weekly-Monday) + kill-switch flag + CRON_ENABLED + verified-only → Tasks 2, 10, 11. ✅
- `List-Unsubscribe` headers via binding `headers` → Task 9. ✅
- Authed `/v1/me/digest` toggle (session-or-Bearer via `requireFollowsPrincipal`/`meRoutes`) → Task 7. ✅
- Public `reld_` one-click unsubscribe lane (opaque-404, OpenAPI-exempt) → Tasks 1, 8. ✅
- Web card on `/following` → Task 12. ✅
- Wire types (additive) → Task 6. ✅
- Tests across prefs store / watermark / cron / token / auth → Tasks 4, 5, 7, 8, 9, 10. ✅
