# User Follows + Personalized Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user follow organizations and products and read a personalized feed of releases from everything they follow (web + REST API).

**Architecture:** A new worker-local `user_follows` table (sibling to the Better Auth schema island) backs a session-authed `/v1/me/*` REST surface. The personalized feed is a single SQL query that joins `releases_visible` to `sources_active` and tests membership against `user_follows` via `EXISTS` sub-queries — so "follow an org = its products too" falls out of matching `source.org_id` OR `source.product_id`, with no id-array binding and no D1 bind-limit concern. The web renders a follow button (state from a one-shot client-side provider) and a top-level `/following` page that reuses the existing release-card component.

**Tech Stack:** Cloudflare Worker + Hono + Drizzle/D1 (backend), Better Auth cookie sessions, Cloudflare Flagship flags, Next.js (web), Bun test + bun:sqlite (tests).

**Spec:** `docs/superpowers/specs/2026-06-08-user-follows-design.md`

---

## Conventions used in this plan

- Run commands from the repo root (`/Users/zachdunn/Code/releases/.claude/worktrees/user-follows`).
- Type-check: `npx tsc --noEmit` (run in `workers/api`, `packages/api-types`, `web` as relevant).
- Tests: `bun test <path>`.
- Migration timestamp for this feature: `20260608000000` (newer than the latest existing `20260607010000`).
- Commit after each task.

---

## Task 1: Register the `user-follows-enabled` feature flag

**Files:**

- Modify: `packages/lib/src/flags.ts` (FLAGS registry)
- Modify: `workers/api/src/index.ts` (Env binding type, ~line 229)
- Modify: `workers/api/wrangler.jsonc` (vars block ~line 177 and staging block ~line 609)

- [ ] **Step 1: Add the flag to the registry**

In `packages/lib/src/flags.ts`, inside the `FLAGS` object, after the `deviceAuthorizationEnabled` entry, add:

```ts
  // Rollout gate: user follows + personalized feed (#follows). default:false →
  // the /v1/me/* surface is dark (404) until flipped on in BOTH Flagship apps
  // (releases-platform and releases-platform-staging). Off = identical to today.
  userFollowsEnabled: {
    key: "user-follows-enabled",
    env: "USER_FOLLOWS_ENABLED",
    default: false,
  },
```

- [ ] **Step 2: Add the Env binding**

In `workers/api/src/index.ts`, next to `USER_API_KEYS_ENABLED?: string;` (~line 229), add:

```ts
    USER_FOLLOWS_ENABLED?: string;
```

- [ ] **Step 3: Add the wrangler var (prod + staging)**

In `workers/api/wrangler.jsonc`, next to each `"USER_API_KEYS_ENABLED": "false",` line (the top-level vars block and the `[env.staging]` vars block), add:

```jsonc
    "USER_FOLLOWS_ENABLED": "false",
```

- [ ] **Step 4: Type-check**

Run: `cd packages/lib && npx tsc --noEmit && cd ../../workers/api && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/flags.ts workers/api/src/index.ts workers/api/wrangler.jsonc
git commit -m "feat(follows): register user-follows-enabled flag"
```

> NOTE: Before this flag is relied on in prod, the same kebab key `user-follows-enabled` must be created in BOTH Flagship apps (`releases-platform`, `releases-platform-staging`). That's an operational step, not a code change — call it out in the PR description.

---

## Task 2: Create the `user_follows` table, migration, and CI gate entry

**Files:**

- Create: `workers/api/src/db/schema-follows.ts`
- Create: `workers/api/migrations/20260608000000_add_user_follows.sql`
- Modify: `.github/workflows/ci.yml` (schema-pairing gate file list, ~line 159)

- [ ] **Step 1: Create the schema island**

Create `workers/api/src/db/schema-follows.ts`:

```ts
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema-auth.js";

/**
 * User follows — a signed-in user following an organization or a product.
 *
 * Worker-local schema island (sibling of schema-auth.ts), deliberately NOT in
 * the published `@buildinternet/releases-core` schema: this is user-coupled data
 * the OSS CLI has no business with. Queried via explicit `.select().from(userFollows)`
 * on a `createDb(...)` handle — the core schema map doesn't include it, but
 * drizzle's `.from(table)` works with any table object (only the relational
 * `db.query.*` API needs the schema map).
 *
 * `target` is polymorphic — `(target_type, target_id)` points at either an
 * organization (`org_…`) or a product (`prd_…`). No hard FK on `target_id`
 * (one column can't reference two tables); orgs/products are soft-deleted and the
 * feed query inner-joins to live entities, so an orphaned follow is invisible,
 * never broken. `user_id` keeps a real cascade FK so deleting an account removes
 * its follows.
 *
 * Paired migration: 20260608000000_add_user_follows.sql.
 */
export const FOLLOW_TARGET_TYPES = ["org", "product"] as const;
export type FollowTargetType = (typeof FOLLOW_TARGET_TYPES)[number];

export const userFollows = sqliteTable(
  "user_follows",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetType: text("target_type", { enum: FOLLOW_TARGET_TYPES }).notNull(),
    targetId: text("target_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_user_follows_unique").on(t.userId, t.targetType, t.targetId),
    index("idx_user_follows_user").on(t.userId),
    index("idx_user_follows_target").on(t.targetType, t.targetId),
  ],
);

export type UserFollow = typeof userFollows.$inferSelect;
export type NewUserFollow = typeof userFollows.$inferInsert;
```

- [ ] **Step 2: Create the migration**

Create `workers/api/migrations/20260608000000_add_user_follows.sql`:

```sql
-- User follows: a signed-in user following an org or product.
-- Paired with workers/api/src/db/schema-follows.ts.
CREATE TABLE IF NOT EXISTS user_follows (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_follows_unique
  ON user_follows (user_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_user
  ON user_follows (user_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_target
  ON user_follows (target_type, target_id);
```

- [ ] **Step 3: Add the schema file to the CI pairing gate**

In `.github/workflows/ci.yml`, the "Pair schema changes with a wrangler migration" step lists watched schema files (~line 156-159). Add the new island so future edits to it require a migration:

```yaml
            'workers/api/src/db/schema-auth.ts' \
            'workers/api/src/db/schema-follows.ts' || true)
```

(Insert the `schema-follows.ts` line before the `|| true)` that closes the `git diff` invocation.)

- [ ] **Step 4: Verify the migration applies cleanly in the test harness**

The bun:sqlite test helper applies every migration under `workers/api/migrations/`. Confirm it loads:

Run: `bun test workers/api/test/auth.test.ts`
Expected: PASS (proves the new migration parses and applies alongside the others; no "no such table"/syntax errors at setup).

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/db/schema-follows.ts workers/api/migrations/20260608000000_add_user_follows.sql .github/workflows/ci.yml
git commit -m "feat(follows): add user_follows table + migration"
```

---

## Task 3: Generalize `requireSession` to take a flag, add a follows session gate

The current `requireSession` is hard-wired to the api-keys flag. Refactor it into a factory so both surfaces share one cookie-session path, preserving the existing api-keys behavior exactly.

**Files:**

- Modify: `workers/api/src/middleware/auth.ts` (the `requireSession` export, ~line 370-386)
- Test: `workers/api/test/follows-auth.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/follows-auth.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requireFollowsSession } from "../src/middleware/auth.js";

/** Minimal env with the follows flag forced on/off via the wrangler-var fallback. */
function appWith(flagValue: string | undefined) {
  const app = new Hono();
  app.use("/v1/me/*", requireFollowsSession);
  app.get("/v1/me/follows", (c) => c.json({ ok: true }));
  const env = {
    USER_FOLLOWS_ENABLED: flagValue,
    // No betterAuth injected and no cookie → getSession resolves to null.
  } as unknown as Record<string, unknown>;
  return { app, env };
}

describe("requireFollowsSession", () => {
  it("returns 404 when the follows flag is off", async () => {
    const { app, env } = appWith("false");
    const res = await app.request("/v1/me/follows", {}, env);
    expect(res.status).toBe(404);
  });

  it("returns 401 when the flag is on but there is no session", async () => {
    const { app, env } = appWith("true");
    const res = await app.request("/v1/me/follows", {}, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/follows-auth.test.ts`
Expected: FAIL — `requireFollowsSession` is not exported from `middleware/auth.js`.

- [ ] **Step 3: Implement the factory + the two named middlewares**

In `workers/api/src/middleware/auth.ts`, replace the existing `requireSession` export (currently `export const requireSession: MiddlewareHandler<Env> = async (c, next) => { ... }`, ~line 370-386) with a factory and two bindings. Add `import { FLAGS, flag, type FlagDef } from "@releases/lib/flags";` is already present (`FLAGS, flag` are imported at the top); add the `FlagDef` type to that import. Then:

```ts
/**
 * Build a cookie-session gate behind a feature flag. When the flag is off the
 * surface is dark (404). Otherwise it resolves the Better Auth session from the
 * request cookie (no session → 401) and attaches a minimal `{ user }` to the
 * context for downstream handlers. Used for both the api-keys self-serve surface
 * and the follows `/v1/me/*` surface so there is one session-resolution path.
 */
function requireSessionWithFlag(
  flagDef: FlagDef,
  envValue: (e: Env["Bindings"]) => string | undefined,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!(await flag(c.env.FLAGS, envValue(c.env), flagDef.default))) {
      return c.json({ error: "not_found", message: "Not found" }, 404);
    }
    const auth = await getOrCreateAuth(c);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user?.id) {
      return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
    }
    c.set("session", {
      user: { id: session.user.id, email: session.user.email, name: session.user.name },
    });
    await next();
  };
}

/** Self-serve API key surface gate (`/v1/api-keys`). */
export const requireSession: MiddlewareHandler<Env> = requireSessionWithFlag(
  FLAGS.userApiKeysEnabled,
  (e) => e.USER_API_KEYS_ENABLED,
);

/** User follows + feed surface gate (`/v1/me/*`). */
export const requireFollowsSession: MiddlewareHandler<Env> = requireSessionWithFlag(
  FLAGS.userFollowsEnabled,
  (e) => e.USER_FOLLOWS_ENABLED,
);
```

Notes:

- This reuses the existing `getOrCreateAuth(c)` helper (already defined above in the file) instead of the previous inline `createAuth(c.env, execWaitUntil(c))`, so the `betterAuth` test seam works for both gates. Behavior is identical for api-keys.
- `FlagDef` is exported from `@releases/lib/flags` (verify; if not, change the import to a structural `{ default: boolean }` param type).

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test workers/api/test/follows-auth.test.ts`
Expected: PASS (404 when off, 401 when on without session).

- [ ] **Step 5: Confirm api-keys still type-checks and its tests pass**

Run: `cd workers/api && npx tsc --noEmit && cd ../.. && bun test workers/api/test/auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/auth.ts workers/api/test/follows-auth.test.ts
git commit -m "feat(follows): flag-gated cookie-session middleware factory"
```

---

## Task 4: Follows store queries (add / remove / list / validate target)

**Files:**

- Create: `workers/api/src/queries/follows.ts`
- Test: `workers/api/test/follows-store.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/follows-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import {
  addFollow,
  removeFollow,
  listFollows,
  resolveFollowTarget,
} from "../src/queries/follows.js";

let h: TestDatabase;

beforeEach(async () => {
  h = createTestDb();
  // Seed a user, an org, and a product under it.
  await h.db.insert(user).values({
    id: "u1",
    name: "Test",
    email: "t@example.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db
    .insert(products)
    .values({ id: "prd_a", name: "Widget", slug: "widget", orgId: "org_a" });
});

afterEach(() => h.cleanup());

describe("follows store", () => {
  it("adds a follow and lists it enriched", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const rows = await listFollows(h.db, "u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetType: "org",
      targetId: "org_a",
      name: "Acme",
      slug: "acme",
    });
  });

  it("is idempotent — re-following does not duplicate", async () => {
    await addFollow(h.db, "u1", "product", "prd_a");
    await addFollow(h.db, "u1", "product", "prd_a");
    const rows = await listFollows(h.db, "u1");
    expect(rows).toHaveLength(1);
  });

  it("removes a follow (idempotent)", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    await removeFollow(h.db, "u1", "org", "org_a");
    await removeFollow(h.db, "u1", "org", "org_a"); // no throw on second
    expect(await listFollows(h.db, "u1")).toHaveLength(0);
  });

  it("resolveFollowTarget returns the entity for a live org/product, null otherwise", async () => {
    expect(await resolveFollowTarget(h.db, "org", "org_a")).toMatchObject({ slug: "acme" });
    expect(await resolveFollowTarget(h.db, "product", "prd_a")).toMatchObject({ slug: "widget" });
    expect(await resolveFollowTarget(h.db, "org", "nope")).toBeNull();
  });

  it("list returns only the caller's follows", async () => {
    await h.db.insert(user).values({
      id: "u2",
      name: "Other",
      email: "o@example.com",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await addFollow(h.db, "u1", "org", "org_a");
    await addFollow(h.db, "u2", "product", "prd_a");
    expect(await listFollows(h.db, "u1")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/follows-store.test.ts`
Expected: FAIL — `../src/queries/follows.js` does not exist.

- [ ] **Step 3: Implement the store**

Create `workers/api/src/queries/follows.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { organizations, products } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../db.js";
import { userFollows, type FollowTargetType } from "../db/schema-follows.js";

/** A user's follow, enriched with the target entity's display fields. */
export interface EnrichedFollow {
  targetType: FollowTargetType;
  targetId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  /** For products, the owning org's slug (so the web can build a link). */
  orgSlug: string | null;
  createdAt: string;
}

/** The minimal entity shape returned by target validation. */
export interface FollowTargetEntity {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  orgSlug: string | null;
}

function newFollowId(): string {
  return `fol_${crypto.randomUUID()}`;
}

/**
 * Resolve a follow target to a live (non-tombstoned) org or product, or null.
 * Used at follow-time so we never persist a follow to a non-existent/hidden
 * entity. Orgs hidden from listings (`isHidden`) are still followable — hidden
 * only suppresses promotion, not direct access — but soft-deleted ones are not.
 */
export async function resolveFollowTarget(
  db: D1Db,
  targetType: FollowTargetType,
  targetId: string,
): Promise<FollowTargetEntity | null> {
  if (targetType === "org") {
    const row = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        avatarUrl: organizations.avatarUrl,
        deletedAt: organizations.deletedAt,
      })
      .from(organizations)
      .where(eq(organizations.id, targetId))
      .get();
    if (!row || row.deletedAt) return null;
    return { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatarUrl, orgSlug: null };
  }
  const row = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      avatarUrl: products.avatarUrl,
      deletedAt: products.deletedAt,
      orgSlug: organizations.slug,
    })
    .from(products)
    .leftJoin(organizations, eq(organizations.id, products.orgId))
    .where(eq(products.id, targetId))
    .get();
  if (!row || row.deletedAt) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    avatarUrl: row.avatarUrl,
    orgSlug: row.orgSlug ?? null,
  };
}

/** Idempotently add a follow (re-follow is a no-op via the unique index). */
export async function addFollow(
  db: D1Db,
  userId: string,
  targetType: FollowTargetType,
  targetId: string,
): Promise<void> {
  await db
    .insert(userFollows)
    .values({ id: newFollowId(), userId, targetType, targetId, createdAt: new Date() })
    .onConflictDoNothing();
}

/** Idempotently remove a follow (removing a non-follow is a no-op). */
export async function removeFollow(
  db: D1Db,
  userId: string,
  targetType: FollowTargetType,
  targetId: string,
): Promise<void> {
  await db
    .delete(userFollows)
    .where(
      and(
        eq(userFollows.userId, userId),
        eq(userFollows.targetType, targetType),
        eq(userFollows.targetId, targetId),
      ),
    );
}

/**
 * List a user's follows, enriched with each target's display fields, newest
 * first. Orphaned follows (target soft-deleted/removed) are dropped via the
 * inner-join-equivalent filter — a follow whose org/product no longer resolves
 * is omitted. Two queries (org follows, product follows) merged in memory; a
 * user's follow count is small.
 */
export async function listFollows(db: D1Db, userId: string): Promise<EnrichedFollow[]> {
  const rows = await db
    .select({
      targetType: userFollows.targetType,
      targetId: userFollows.targetId,
      createdAt: userFollows.createdAt,
    })
    .from(userFollows)
    .where(eq(userFollows.userId, userId))
    .all();

  const out: EnrichedFollow[] = [];
  for (const r of rows) {
    const entity = await resolveFollowTarget(db, r.targetType, r.targetId);
    if (!entity) continue; // drop orphans
    out.push({
      targetType: r.targetType,
      targetId: r.targetId,
      name: entity.name,
      slug: entity.slug,
      avatarUrl: entity.avatarUrl,
      orgSlug: r.targetType === "product" ? entity.orgSlug : null,
      createdAt: r.createdAt.toISOString(),
    });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test workers/api/test/follows-store.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/queries/follows.ts workers/api/test/follows-store.test.ts
git commit -m "feat(follows): follow store (add/remove/list/validate)"
```

---

## Task 5: Personalized feed query + extract the shared release-row mapper

The feed reuses the existing `LatestReleaseRow` shape and the existing row→`ReleaseItem` mapping. First extract that mapper (currently inline in `routes/releases.ts`), then add the feed query.

**Files:**

- Modify: `workers/api/src/queries/releases.ts` (export a mapper + add `getFollowedReleases`)
- Modify: `workers/api/src/routes/releases.ts` (use the extracted mapper in `/releases/latest`)
- Test: `workers/api/test/follows-feed.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/follows-feed.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import { addFollow } from "../src/queries/follows.js";
import { getFollowedReleases } from "../src/queries/releases.js";

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
  // Org A with a product P and two sources: one org-direct (no product), one under P.
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db
    .insert(products)
    .values({ id: "prd_p", name: "Widget", slug: "widget", orgId: "org_a" });
  await h.db
    .insert(sources)
    .values({
      id: "src_org",
      name: "Blog",
      slug: "blog",
      type: "feed",
      url: "https://a/blog",
      orgId: "org_a",
    });
  await h.db
    .insert(sources)
    .values({
      id: "src_prd",
      name: "Notes",
      slug: "notes",
      type: "feed",
      url: "https://a/notes",
      orgId: "org_a",
      productId: "prd_p",
    });
  // Org B (not followed).
  await h.db.insert(organizations).values({ id: "org_b", name: "Other", slug: "other" });
  await h.db
    .insert(sources)
    .values({ id: "src_b", name: "B", slug: "b", type: "feed", url: "https://b", orgId: "org_b" });

  const mkRel = (id: string, sourceId: string, when: string) =>
    h.db.insert(releases).values({
      id,
      sourceId,
      title: id,
      content: "x",
      type: "feature",
      publishedAt: when,
      fetchedAt: when,
    });
  await mkRel("rel_org", "src_org", "2026-01-01T00:00:00Z");
  await mkRel("rel_prd", "src_prd", "2026-01-02T00:00:00Z");
  await mkRel("rel_b", "src_b", "2026-01-03T00:00:00Z");
});

afterEach(() => h.cleanup());

describe("getFollowedReleases", () => {
  it("following an org includes its products' releases (org follow = everything)", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50, offset: 0 });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["rel_org", "rel_prd"]); // both org-direct and product
    expect(ids).not.toContain("rel_b"); // org B not followed
  });

  it("following only a product narrows to that product", async () => {
    await addFollow(h.db, "u1", "product", "prd_p");
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50, offset: 0 });
    expect(rows.map((r) => r.id)).toEqual(["rel_prd"]);
  });

  it("returns empty for a user with no follows", async () => {
    const rows = await getFollowedReleases(h.db, "u1", { limit: 50, offset: 0 });
    expect(rows).toEqual([]);
  });

  it("orders newest-first and respects limit/offset", async () => {
    await addFollow(h.db, "u1", "org", "org_a");
    const page1 = await getFollowedReleases(h.db, "u1", { limit: 1, offset: 0 });
    expect(page1.map((r) => r.id)).toEqual(["rel_prd"]); // 2026-01-02 newer than 01-01
    const page2 = await getFollowedReleases(h.db, "u1", { limit: 1, offset: 1 });
    expect(page2.map((r) => r.id)).toEqual(["rel_org"]);
  });
});
```

> The test passes the drizzle `TestDb` handle (bun:sqlite). `getFollowedReleases` therefore must run SQL through the drizzle handle (`db.$client` / `db.run`), not a raw `D1Database`. See the implementation note in Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/follows-feed.test.ts`
Expected: FAIL — `getFollowedReleases` is not exported.

- [ ] **Step 3: Implement the feed query + extract the mapper**

In `workers/api/src/queries/releases.ts`, add the mapper and the feed query. The feed query references `user_follows` directly via `EXISTS` so it needs no id-array binding (sidesteps the D1 100-bind limit entirely). It must accept the drizzle handle so tests (bun:sqlite) and prod (D1) share one path — use `db.all<LatestReleaseRow>(sql\`...\`)`.

Add imports at the top of the file:

```ts
import { sql } from "drizzle-orm";
import type { D1Db } from "../db.js";
import { parseReleaseMedia } from "../lib/release-media.js"; // see note below
import type { ReleaseItem } from "@buildinternet/releases-api-types";
```

> Note on `parseReleaseMedia`: it is currently imported in `routes/releases.ts`. Find its source module (grep `export function parseReleaseMedia`) and import from there. If it lives in `routes/releases.ts` itself, move it to `workers/api/src/lib/release-media.ts` and re-import in both files (small, mechanical).

Add the shared mapper (this is the exact object `/releases/latest` builds inline today):

```ts
/**
 * Map a `LatestReleaseRow` to the wire `ReleaseItem` shape consumed by the web
 * release card. Shared by `/releases/latest` and `/v1/me/feed` so both feeds
 * render identically.
 */
export function mapLatestRowToReleaseItem(r: LatestReleaseRow, mediaOrigin: string): ReleaseItem {
  return {
    id: r.id,
    version: r.version,
    type: r.type as ReleaseItem["type"],
    title: r.title,
    summary: r.summary,
    titleGenerated: r.title_generated,
    titleShort: r.title_short,
    publishedAt: r.published_at,
    url: r.url,
    media: parseReleaseMedia(r.media, mediaOrigin),
    source: { slug: r.source_slug, name: r.source_name, type: r.source_type, orgSlug: r.org_slug },
    product: r.product_slug
      ? { slug: r.product_slug, name: r.product_name ?? r.product_slug }
      : null,
    coverageCount: r.coverage_count,
    contentChars: r.content_chars,
    contentTokens: r.content_tokens,
  } as ReleaseItem;
}
```

Add the feed query:

```ts
export interface FollowedReleasesParams {
  limit: number;
  offset: number;
}

/**
 * Releases from everything a user follows, newest first. "Follow an org =
 * everything" is encoded by the two EXISTS sub-queries: a row matches if the
 * user follows its source's org OR its source's product. References
 * `user_follows` directly in SQL, so the number of bound parameters is constant
 * regardless of how many entities the user follows (no D1 bind-limit concern).
 * Visibility filters mirror `getLatestReleasesAcross` (no hidden sources/orgs,
 * no tombstoned orgs, no suppressed/prerelease rows, coverage-side hidden).
 */
export async function getFollowedReleases(
  db: D1Db,
  userId: string,
  params: FollowedReleasesParams,
): Promise<LatestReleaseRow[]> {
  return db.all<LatestReleaseRow>(sql`
    SELECT r.id, r.version, r.title, r.summary, r.title_generated, r.title_short, r.type,
           r.published_at, r.url, r.media,
           r.content_chars, r.content_tokens,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug,
           p.slug AS product_slug, p.name AS product_name,
           ${sql.raw(COVERAGE_COUNT_EXPR)} AS coverage_count
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (o.is_hidden = 0 OR o.is_hidden IS NULL)
      AND (o.deleted_at IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (r.prerelease IS NULL OR r.prerelease = 0)
      AND (
        EXISTS (SELECT 1 FROM user_follows uf
                WHERE uf.user_id = ${userId} AND uf.target_type = 'org'
                  AND uf.target_id = s.org_id)
        OR EXISTS (SELECT 1 FROM user_follows uf
                   WHERE uf.user_id = ${userId} AND uf.target_type = 'product'
                     AND uf.target_id = s.product_id)
      )
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ${params.limit} OFFSET ${params.offset}
  `);
}
```

> `db.all<T>(sql\`...\`)`returns`T[]`on both the D1 and bun:sqlite drizzle drivers (the proven raw-SQL-with-the-drizzle-handle pattern in this repo — see`queries/orgs.ts`). `COVERAGE_COUNT_EXPR`is a trusted constant SQL fragment (already imported at the top of this file) — wrap it with`sql.raw(...)`. `${userId}`etc. are bound parameters (safe). If column-name→camelCase mapping surprises you, note`db.all` returns the raw column names (`published_at`, etc.) which is exactly what `LatestReleaseRow` declares.

Now update `routes/releases.ts` to use the shared mapper. Replace the inline `return rows.map((r) => ({ ... }));` block (~lines 281-304) with:

```ts
return rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));
```

Add the import at the top of `routes/releases.ts`:

```ts
import { getLatestReleasesAcross, mapLatestRowToReleaseItem } from "../queries/releases.js";
```

(Replace the existing `import { getLatestReleasesAcross } from "../queries/releases.js";`.)

- [ ] **Step 4: Run the feed test to verify it passes**

Run: `bun test workers/api/test/follows-feed.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Confirm the latest-releases route still works**

Run: `bun test workers/api/test/ -t latest` (or the releases route test file if one exists)
Then: `cd workers/api && npx tsc --noEmit`
Expected: PASS — the extracted mapper produces the identical shape.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/queries/releases.ts workers/api/src/routes/releases.ts workers/api/test/follows-feed.test.ts workers/api/src/lib/release-media.ts
git commit -m "feat(follows): personalized feed query + shared release-row mapper"
```

---

## Task 6: Wire types in api-types

**Files:**

- Modify: `packages/api-types/src/api-types.ts`

- [ ] **Step 1: Add the follow + feed wire types**

In `packages/api-types/src/api-types.ts`, in the Releases section (near `ReleaseItem`, which the feed reuses), add:

```ts
// ── Follows ──

/** What a user can follow. */
export type FollowTarget = "org" | "product";

/** A user's follow, enriched for rendering (returned by GET /v1/me/follows). */
export interface Follow {
  targetType: FollowTarget;
  targetId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  /** Owning org slug for product follows (null for org follows). */
  orgSlug: string | null;
  createdAt: string;
}

/** GET /v1/me/follows response. */
export interface FollowsListResponse {
  follows: Follow[];
}

/** POST /v1/me/follows request body. */
export interface FollowRequest {
  targetType: FollowTarget;
  targetId: string;
}

/** POST/DELETE /v1/me/follows response. */
export interface FollowMutationResponse {
  success: true;
  following: boolean;
}

/** GET /v1/me/feed response — reuses the standard release card item + list envelope. */
export interface PersonalizedFeedResponse extends ListResponse<ReleaseItem> {}
```

> `ListResponse<T>` is already imported/defined in this file (it's used by `StuckSourcesResponse` above). If it's imported from `@buildinternet/releases-core/cli-contracts`, reuse that same import.

- [ ] **Step 2: Type-check api-types**

Run: `cd packages/api-types && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/api-types/src/api-types.ts
git commit -m "feat(follows): add follow + personalized-feed wire types"
```

> Publishing: these types only need publishing to npm when the CLI/MCP adopt them. For web + this monorepo they resolve via `workspace:*`. Do NOT bump `packages/api-types/package.json` in this PR unless the CLI needs them now (it doesn't — CLI is deferred).

---

## Task 7: The `/v1/me` route handlers + route tests

**Files:**

- Create: `workers/api/src/routes/me.ts`
- Test: `workers/api/test/follows-routes.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/follows-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { user } from "../src/db/schema-auth.js";
import { meHandlers } from "../src/routes/me.js";

let h: TestDatabase;

/** Mount the no-auth handlers behind a middleware that injects a fixed session + db. */
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    (c as any).set("session", { user: { id: "u1", email: "t@e.com", name: "T" } });
    await next();
  });
  a.route("/", meHandlers);
  // Handlers resolve the db via createDb(c.env.DB); createDb passes a drizzle
  // handle through unchanged (see db.ts), so a bun:sqlite handle on env.DB works.
  const env = { DB: h.db } as unknown as Record<string, unknown>;
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
  await h.db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await h.db
    .insert(products)
    .values({ id: "prd_p", name: "Widget", slug: "widget", orgId: "org_a" });
});

afterEach(() => h.cleanup());

describe("/v1/me follows routes", () => {
  it("POST follows then GET lists it", async () => {
    const { a, env } = app();
    const post = await a.request(
      "/me/follows",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "org", targetId: "org_a" }),
      },
      env,
    );
    expect(post.status).toBe(201);

    const list = await a.request("/me/follows", {}, env);
    const body = (await list.json()) as { follows: Array<{ targetId: string }> };
    expect(body.follows.map((f) => f.targetId)).toEqual(["org_a"]);
  });

  it("POST is idempotent", async () => {
    const { a, env } = app();
    const body = JSON.stringify({ targetType: "product", targetId: "prd_p" });
    const headers = { "Content-Type": "application/json" };
    await a.request("/me/follows", { method: "POST", headers, body }, env);
    const second = await a.request("/me/follows", { method: "POST", headers, body }, env);
    expect(second.status).toBe(200); // already following → 200, not a duplicate
    const list = await a.request("/me/follows", {}, env);
    expect(((await list.json()) as { follows: unknown[] }).follows).toHaveLength(1);
  });

  it("POST a non-existent target → 404", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/follows",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "org", targetId: "nope" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("POST with a bad targetType → 400", async () => {
    const { a, env } = app();
    const res = await a.request(
      "/me/follows",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: "source", targetId: "x" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("DELETE unfollows (idempotent)", async () => {
    const { a, env } = app();
    const body = JSON.stringify({ targetType: "org", targetId: "org_a" });
    await a.request(
      "/me/follows",
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      env,
    );
    const del = await a.request("/me/follows/org/org_a", { method: "DELETE" }, env);
    expect(del.status).toBe(200);
    const again = await a.request("/me/follows/org/org_a", { method: "DELETE" }, env);
    expect(again.status).toBe(200); // idempotent
    const list = await a.request("/me/follows", {}, env);
    expect(((await list.json()) as { follows: unknown[] }).follows).toHaveLength(0);
  });

  it("GET /me/feed returns the list envelope", async () => {
    const { a, env } = app();
    const res = await a.request("/me/feed", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; pagination: { page: number } };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.pagination.page).toBe(1);
  });
});
```

> The test relies on handlers resolving the db via `createDb(c.env.DB)`. `createDb` passes a drizzle handle through unchanged when given one (see `db.ts`), so setting `env.DB = h.db` works. If a handler needs `c.env.MEDIA_*` for media origin, the feed test row set has `media` null so `parseReleaseMedia(null, ...)` returns `[]` regardless — pass an empty media origin (`""`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/test/follows-routes.test.ts`
Expected: FAIL — `../src/routes/me.js` does not exist.

- [ ] **Step 3: Implement the handlers**

Create `workers/api/src/routes/me.ts`:

```ts
import { Hono } from "hono";
import { createDb } from "../db.js";
import { requireFollowsSession } from "../middleware/auth.js";
import { parseListPagination, buildListResponse } from "../lib/pagination.js";
import { addFollow, removeFollow, listFollows, resolveFollowTarget } from "../queries/follows.js";
import { getFollowedReleases, mapLatestRowToReleaseItem } from "../queries/releases.js";
import { FOLLOW_TARGET_TYPES, type FollowTargetType } from "../db/schema-follows.js";
import { mediaOriginFromEnv } from "../lib/release-media.js"; // see note
import type { Env } from "../index.js";

function isFollowTargetType(v: unknown): v is FollowTargetType {
  return typeof v === "string" && (FOLLOW_TARGET_TYPES as readonly string[]).includes(v);
}

/**
 * Self-serve follow + personalized-feed handlers, defined WITHOUT auth so unit
 * tests can mount them behind an injected session (mirrors userApiKeyHandlers).
 * Production composes them under `requireFollowsSession` via `meRoutes`.
 */
export const meHandlers = new Hono<Env>();

meHandlers.get("/me/follows", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const follows = await listFollows(db, session.user.id);
  return c.json({ follows });
});

meHandlers.post("/me/follows", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  let body: { targetType?: unknown; targetId?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }
  if (!isFollowTargetType(body.targetType) || typeof body.targetId !== "string" || !body.targetId) {
    return c.json(
      {
        error: "bad_request",
        message: "targetType must be 'org' or 'product' and targetId is required",
      },
      400,
    );
  }
  const db = createDb(c.env.DB);

  // Distinguish "already following" (200) from a fresh follow (201) without a
  // race: check existing membership via the list, then validate + insert.
  const existing = await listFollows(db, session.user.id);
  const already = existing.some(
    (f) => f.targetType === body.targetType && f.targetId === body.targetId,
  );
  if (already) return c.json({ success: true, following: true }, 200);

  const entity = await resolveFollowTarget(db, body.targetType, body.targetId);
  if (!entity) return c.json({ error: "not_found", message: "Target not found" }, 404);

  await addFollow(db, session.user.id, body.targetType, body.targetId);
  return c.json({ success: true, following: true }, 201);
});

meHandlers.delete("/me/follows/:targetType/:targetId", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const targetType = c.req.param("targetType");
  const targetId = c.req.param("targetId");
  if (!isFollowTargetType(targetType)) {
    return c.json({ error: "bad_request", message: "Invalid targetType" }, 400);
  }
  const db = createDb(c.env.DB);
  await removeFollow(db, session.user.id, targetType, targetId);
  return c.json({ success: true, following: false }, 200);
});

meHandlers.get("/me/feed", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const pagination = parseListPagination(new URL(c.req.url).searchParams, {
    defaultPageSize: 30,
    maxPageSize: 100,
  });
  const rows = await getFollowedReleases(db, session.user.id, {
    limit: pagination.pageSize,
    offset: pagination.offset,
  });
  const mediaOrigin = mediaOriginFromEnv(c.env);
  const items = rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));
  return c.json(buildListResponse(items, pagination));
});

/** Production composition: flag-gated session, then the handlers. */
export const meRoutes = new Hono<Env>();
meRoutes.use("/me/*", requireFollowsSession);
meRoutes.route("/", meHandlers);
```

> Note on `mediaOriginFromEnv`: `routes/releases.ts` computes `mediaOrigin` from env already (grep for how it's derived — likely a `MEDIA_*` env var or a constant). Extract that derivation into `workers/api/src/lib/release-media.ts` as `mediaOriginFromEnv(env)` and reuse it in both `routes/releases.ts` and here, so the two feeds resolve media identically. If it's a trivial constant, inline it instead.

- [ ] **Step 4: Run the route test to verify it passes**

Run: `bun test workers/api/test/follows-routes.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/me.ts workers/api/src/lib/release-media.ts workers/api/test/follows-routes.test.ts
git commit -m "feat(follows): /v1/me follows + feed route handlers"
```

---

## Task 8: Mount the routes, CORS carve-out, and rate limiter

**Files:**

- Modify: `workers/api/src/v1-routes.ts` (import + mount `meRoutes`)
- Modify: `workers/api/src/index.ts` (CORS carve-out + the `/me` GET rate limiter, mirroring `/v1/api-keys`)

- [ ] **Step 1: Mount the routes**

In `workers/api/src/v1-routes.ts`, add the import near the other route imports (next to `userApiKeyRoutes`, ~line 55):

```ts
import { meRoutes } from "./routes/me.js";
```

And mount it in `mountV1Routes`, right after the `userApiKeyRoutes` line (~line 109):

```ts
v1.route("/", meRoutes);
```

- [ ] **Step 2: Add the credentialed CORS for `/v1/me/*`**

In `workers/api/src/index.ts`, after the two `/v1/api-keys` `authCorsMiddleware()` lines (~line 408), add:

```ts
app.use("/v1/me/*", authCorsMiddleware());
```

Then add `/v1/me/*` to the wildcard `publicReadCors` skip list (~lines 419-424). Change the predicate to also skip `/v1/me/`:

```ts
app.use("*", (c, next) =>
  c.req.path.startsWith("/api/auth/") ||
  c.req.path === "/v1/api-keys" ||
  c.req.path.startsWith("/v1/api-keys/") ||
  c.req.path.startsWith("/v1/me/")
    ? next()
    : publicReadCors(c, next),
);
```

- [ ] **Step 3: Add the per-IP rate limiter on the `/v1/me` reads**

In `workers/api/src/index.ts`, next to the `/api-keys` limiter (~lines 572-573), add (using the bare `v1`-relative paths, since these run inside the `v1` sub-app):

```ts
v1.use("/me/follows", publicRateLimitMiddleware);
v1.use("/me/*", publicRateLimitMiddleware);
```

> `publicRateLimitMiddleware` only limits safe methods; POST/DELETE are session-gated, same posture as api-keys.

- [ ] **Step 4: Type-check + run the whole api test suite**

Run: `cd workers/api && npx tsc --noEmit && cd ../.. && bun test workers/api/test/`
Expected: PASS (the new follows tests + no regressions).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/v1-routes.ts workers/api/src/index.ts
git commit -m "feat(follows): mount /v1/me routes + credentialed CORS + rate limiter"
```

---

## Task 9: Web — flag + browser API client

**Files:**

- Modify: `web/src/lib/auth-ui.ts`
- Create: `web/src/lib/follows.ts`

- [ ] **Step 1: Add the web flag**

In `web/src/lib/auth-ui.ts`, alongside the other flags, add:

```ts
/**
 * User follows + personalized feed. Mirrors the server `user-follows-enabled`
 * Flagship flag. Build-time inlined; "true" string check like the others.
 */
export const USER_FOLLOWS_ENABLED = process.env.NEXT_PUBLIC_USER_FOLLOWS === "true";
```

- [ ] **Step 2: Create the browser client**

Create `web/src/lib/follows.ts` (mirrors `web/src/lib/api-keys.ts` — `NEXT_PUBLIC_BETTER_AUTH_URL` base + `credentials: "include"`):

```ts
import type {
  Follow,
  FollowTarget,
  FollowsListResponse,
  PersonalizedFeedResponse,
} from "@buildinternet/releases-api-types";

function apiBase(): string {
  const url = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!url) throw new Error("NEXT_PUBLIC_BETTER_AUTH_URL is not set");
  return url.replace(/\/$/, "");
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function listFollows(): Promise<Follow[]> {
  const res = await fetch(`${apiBase()}/v1/me/follows`, { credentials: "include" });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load follows (${res.status})`));
  return ((await res.json()) as FollowsListResponse).follows;
}

export async function follow(targetType: FollowTarget, targetId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/follows`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetType, targetId }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to follow (${res.status})`));
}

export async function unfollow(targetType: FollowTarget, targetId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/follows/${targetType}/${targetId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to unfollow (${res.status})`));
}

export async function getFeed(page = 1, limit = 30): Promise<PersonalizedFeedResponse> {
  const res = await fetch(`${apiBase()}/v1/me/feed?page=${page}&limit=${limit}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load feed (${res.status})`));
  return (await res.json()) as PersonalizedFeedResponse;
}
```

- [ ] **Step 3: Type-check web**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (the api-types resolve via workspace).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/auth-ui.ts web/src/lib/follows.ts
git commit -m "feat(follows): web flag + browser follows client"
```

---

## Task 10: Web — FollowsProvider + FollowButton, wired into layout & detail pages

**Files:**

- Create: `web/src/components/follows-provider.tsx`
- Create: `web/src/components/follow-button.tsx`
- Modify: `web/src/app/layout.tsx` (wrap with `FollowsProvider`)
- Modify: `web/src/app/[orgSlug]/(org)/page.tsx` (org header — add a `FollowButton`)
- Modify: `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx` (product header ~line 175 — add a `FollowButton`)

- [ ] **Step 1: Create the follows provider**

Create `web/src/components/follows-provider.tsx` (house style from `theme-provider.tsx`):

```tsx
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { USER_FOLLOWS_ENABLED } from "@/lib/auth-ui";
import type { FollowTarget } from "@buildinternet/releases-api-types";
import { listFollows, follow as apiFollow, unfollow as apiUnfollow } from "@/lib/follows";

type Key = `${FollowTarget}:${string}`;
const keyOf = (t: FollowTarget, id: string): Key => `${t}:${id}`;

interface FollowsCtx {
  ready: boolean;
  isFollowing: (t: FollowTarget, id: string) => boolean;
  toggle: (t: FollowTarget, id: string) => Promise<void>;
}

const Context = createContext<FollowsCtx | null>(null);

/** Null when follows is disabled or the user is signed out — buttons hide. */
export function useFollows(): FollowsCtx | null {
  return useContext(Context);
}

export function FollowsProvider({ children }: { children: React.ReactNode }) {
  const enabled = USER_FOLLOWS_ENABLED && Boolean(process.env.NEXT_PUBLIC_BETTER_AUTH_URL);
  if (!enabled) return <>{children}</>;
  return <FollowsProviderInner>{children}</FollowsProviderInner>;
}

function FollowsProviderInner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [keys, setKeys] = useState<Set<Key>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!session?.user) {
      setKeys(new Set());
      setReady(true);
      return;
    }
    setReady(false);
    listFollows()
      .then((follows) => {
        if (cancelled) return;
        setKeys(new Set(follows.map((f) => keyOf(f.targetType, f.targetId))));
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true); // fail open — buttons render as "not following"
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const isFollowing = useCallback((t: FollowTarget, id: string) => keys.has(keyOf(t, id)), [keys]);

  const toggle = useCallback(
    async (t: FollowTarget, id: string) => {
      const k = keyOf(t, id);
      const wasFollowing = keys.has(k);
      // Optimistic update.
      setKeys((prev) => {
        const next = new Set(prev);
        if (wasFollowing) next.delete(k);
        else next.add(k);
        return next;
      });
      try {
        if (wasFollowing) await apiUnfollow(t, id);
        else await apiFollow(t, id);
      } catch (err) {
        // Roll back on failure.
        setKeys((prev) => {
          const next = new Set(prev);
          if (wasFollowing) next.add(k);
          else next.delete(k);
          return next;
        });
        throw err;
      }
    },
    [keys],
  );

  const value = useMemo<FollowsCtx>(
    () => ({ ready, isFollowing, toggle }),
    [ready, isFollowing, toggle],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
```

> If `useCallback` is mis-cased above (`useCallback`, not `useCallBack`) — it is `useCallback`. Import it from `react`.

- [ ] **Step 2: Create the follow button**

Create `web/src/components/follow-button.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { FollowTarget } from "@buildinternet/releases-api-types";
import { useFollows } from "./follows-provider";

/**
 * Follow/unfollow toggle for an org or product. Renders nothing when follows is
 * disabled or the user is signed out (`useFollows()` is null), so detail pages
 * stay unchanged for anonymous visitors.
 */
export function FollowButton({
  targetType,
  targetId,
}: {
  targetType: FollowTarget;
  targetId: string;
}) {
  const follows = useFollows();
  const [busy, setBusy] = useState(false);
  if (!follows || !follows.ready) return null;

  const following = follows.isFollowing(targetType, targetId);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await follows.toggle(targetType, targetId);
        } catch {
          // toggle already rolled back; swallow (a toast system could surface this).
        } finally {
          setBusy(false);
        }
      }}
      className={
        following
          ? "rounded-md border border-stone-300 dark:border-stone-700 px-3 py-1 text-sm text-stone-600 dark:text-stone-300"
          : "rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1 text-sm text-white dark:text-stone-900"
      }
      aria-pressed={following}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
```

- [ ] **Step 3: Wrap the app in `FollowsProvider`**

In `web/src/app/layout.tsx`, wrap the existing provider tree (inside `ThemeProvider`, around the `{children}` at ~lines 69-79) with `FollowsProvider`:

```tsx
import { FollowsProvider } from "@/components/follows-provider";
// ...
<ThemeProvider>
  <FollowsProvider>
    {/* existing SearchHotkey / LightboxProvider / main / Footer tree unchanged */}
  </FollowsProvider>
</ThemeProvider>;
```

- [ ] **Step 4: Add the button to the product header**

In `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx`, in the header block (between the description `<p>` at ~line 175 and the `appEntries` block at ~line 193), add:

```tsx
<div className="mt-3">
  <FollowButton targetType="product" targetId={product.id} />
</div>
```

Import at the top: `import { FollowButton } from "@/components/follow-button";`

> Confirm the product object in scope exposes `id` (typed entity id). If the view only has the slug, pass the id from the page's loader — the API returns `product.id`. Adjust the prop source accordingly.

- [ ] **Step 5: Add the button to the org header**

In `web/src/app/[orgSlug]/(org)/page.tsx`, near the org title/header in `OrgOverviewPage` (~line 45-113), add a `<FollowButton targetType="org" targetId={org.id} />` adjacent to the org name. Import `FollowButton` the same way. Use the org's typed `id` from the loaded org object.

- [ ] **Step 6: Manual verification (web has no unit-test harness for these)**

Run the type-check and a build:

Run: `cd web && npx tsc --noEmit && bun run lint`
Expected: PASS.

Then a manual smoke (local dev, follows flag on): set `NEXT_PUBLIC_USER_FOLLOWS=true` and `NEXT_PUBLIC_BETTER_AUTH_URL` in the web dev env, sign in, load an org page, click Follow → button flips to "Following"; reload → still "Following" (state from `GET /v1/me/follows`). See verification note at the end of the plan.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/follows-provider.tsx web/src/components/follow-button.tsx web/src/app/layout.tsx "web/src/app/[orgSlug]/(org)/page.tsx" "web/src/app/[orgSlug]/[slug]/_views/product-view.tsx"
git commit -m "feat(follows): web FollowsProvider + FollowButton on org/product pages"
```

---

## Task 11: Web — the `/following` feed + manage page

**Files:**

- Create: `web/src/app/following/page.tsx` (server gate)
- Create: `web/src/app/following/following-client.tsx` (client: feed + manage list)

- [ ] **Step 1: Create the server-gated page**

Create `web/src/app/following/page.tsx` (mirrors `account/page.tsx`):

```tsx
import { notFound } from "next/navigation";
import { AUTH_UI_ENABLED, USER_FOLLOWS_ENABLED } from "@/lib/auth-ui";
import { Header } from "@/components/header"; // match the import account/page.tsx uses
import { FollowingClient } from "./following-client";

export default function FollowingPage() {
  if (!AUTH_UI_ENABLED || !USER_FOLLOWS_ENABLED || !process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    notFound();
  }
  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto w-full max-w-4xl px-6 py-12">
        <FollowingClient />
      </div>
    </div>
  );
}
```

> Match the actual `Header` import path used by `web/src/app/account/page.tsx` (open it and copy the exact import).

- [ ] **Step 2: Create the client view**

Create `web/src/app/following/following-client.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import type { Follow, ReleaseItem } from "@buildinternet/releases-api-types";
import { getFeed, listFollows } from "@/lib/follows";
import { ReleaseListItem } from "@/components/release-item";
import { useFollows } from "@/components/follows-provider";

export function FollowingClient() {
  const { data: session, isPending } = useSession();
  const [follows, setFollows] = useState<Follow[] | null>(null);
  const [items, setItems] = useState<ReleaseItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const followsCtx = useFollows();

  useEffect(() => {
    if (!session?.user) return;
    Promise.all([listFollows(), getFeed(1, 30)])
      .then(([f, feed]) => {
        setFollows(f);
        setItems(feed.items);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [session?.user?.id]);

  if (isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (!session?.user) {
    return (
      <div className="text-sm text-stone-600 dark:text-stone-300">
        <a className="underline" href="/account">
          Sign in
        </a>{" "}
        to follow organizations and products.
      </div>
    );
  }
  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_260px]">
      <section>
        <h1 className="text-2xl font-bold mb-4">Following</h1>
        {items === null ? (
          <p className="text-sm text-stone-500">Loading feed…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-stone-500">
            No releases yet. Follow some organizations or products to build your feed.
          </p>
        ) : (
          <div className="space-y-6">
            {items.map((r) => (
              <ReleaseListItem key={r.id} release={r} byline={r.product?.name ?? r.source.name} />
            ))}
          </div>
        )}
      </section>

      <aside>
        <h2 className="text-sm font-semibold text-stone-500 uppercase tracking-wide mb-3">
          Your follows
        </h2>
        {follows === null ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : follows.length === 0 ? (
          <p className="text-sm text-stone-500">Not following anything yet.</p>
        ) : (
          <ul className="space-y-2">
            {follows.map((f) => (
              <li
                key={`${f.targetType}:${f.targetId}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-sm">{f.name}</span>
                <button
                  type="button"
                  className="text-xs text-stone-500 hover:text-red-600"
                  onClick={async () => {
                    await followsCtx?.toggle(f.targetType, f.targetId);
                    setFollows(
                      (prev) =>
                        prev?.filter(
                          (x) => !(x.targetType === f.targetType && x.targetId === f.targetId),
                        ) ?? null,
                    );
                  }}
                >
                  Unfollow
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
```

> Match the `ReleaseListItem` prop usage to its real interface (`web/src/components/release-item.tsx`): `release: ReleaseItem`, optional `byline`, etc. Adjust the props passed above to what the component actually expects (the explorer reported `release`, `byline`, `avatarUrl`, `sourceByline`).

- [ ] **Step 3: Type-check + lint**

Run: `cd web && npx tsc --noEmit && bun run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/following/page.tsx web/src/app/following/following-client.tsx
git commit -m "feat(follows): /following feed + manage page"
```

---

## Task 12: Docs + final verification

**Files:**

- Modify: `docs/architecture/routing.md` (note the `/v1/me/*` session-authed surface)
- Modify: `docs/architecture/web.md` (note follows + `/following`)
- Modify: `AGENTS.md` (one-line conventions entry pointing at the new surface)

- [ ] **Step 1: Document the new surface**

In `docs/architecture/routing.md`, add a short subsection under the auth/route-surface notes describing the `/v1/me/*` session-authed bucket (cookie session, `user-follows-enabled` flag, credentialed CORS like `/v1/api-keys`) and the endpoints (`GET/POST /me/follows`, `DELETE /me/follows/:targetType/:targetId`, `GET /me/feed`).

In `docs/architecture/web.md`, add a short "Follows + personalized feed" subsection: the `FollowsProvider`/`FollowButton` model, follow-state via one `GET /v1/me/follows`, and the `/following` page reusing `ReleaseListItem`.

In `AGENTS.md` Conventions, add one line:

```md
- **User follows + feed**: signed-in users follow orgs/products (`user_follows`, worker-local island); session-authed `/v1/me/follows` + `/v1/me/feed` (org follow = its products too), gated by `user-follows-enabled`. See [routing.md](docs/architecture/routing.md) and [web.md](docs/architecture/web.md).
```

- [ ] **Step 2: Full verification sweep**

Run each and confirm PASS:

```bash
# Backend types + tests
cd workers/api && npx tsc --noEmit && cd ../..
bun test workers/api/test/follows-auth.test.ts workers/api/test/follows-store.test.ts workers/api/test/follows-feed.test.ts workers/api/test/follows-routes.test.ts

# Package types
cd packages/api-types && npx tsc --noEmit && cd ../..
cd packages/lib && npx tsc --noEmit && cd ../..

# Web types + lint
cd web && npx tsc --noEmit && bun run lint && cd ..

# Repo-wide lint + format
bun run lint
bun run format:check
```

Expected: all PASS. If `format:check` flags files, run `bun run format` and amend.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/routing.md docs/architecture/web.md AGENTS.md
git commit -m "docs(follows): document /v1/me surface + web follows"
```

---

## Self-review notes (carried from spec → plan)

- **Spec coverage:** org+product follow (Tasks 2,4,7,10); org-follow-includes-products semantics (Task 5 feed query + test); `/v1/me` REST surface + flag + session gate + CORS (Tasks 1,3,7,8); web button + provider + `/following` with same-page manage (Tasks 9,10,11); wire types (Task 6); tests for store/feed/auth/routes (Tasks 3,4,5,7). Deferred items (email, RSS, CLI/MCP) intentionally have no tasks.
- **Bind-limit:** resolved by the `EXISTS`-against-`user_follows` feed query — no id-array binding (refines the spec's "resolve into id sets" wording; same semantics).
- **Open items the implementer must confirm against live code (called out inline):** the exact source module + signature of `parseReleaseMedia` / the media-origin derivation in `routes/releases.ts` (Task 5/7); that `FlagDef` is exported from `@releases/lib/flags` (Task 3); the `Header` import path in `account/page.tsx` (Task 11); that org/product view objects expose typed `id` (Task 10); the real `ReleaseListItem` prop interface (Task 11).
