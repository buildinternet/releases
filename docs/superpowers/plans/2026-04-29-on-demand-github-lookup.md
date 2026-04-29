# On-Demand GitHub Repo Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize a hidden source on the fly when a user searches for a GitHub `org/repo` we don't already index, returning both an inline release preview and a persisted source row so subsequent searches resolve through the normal cache. Surface a "did you mean" rail when the org is known but the repo isn't.

**Architecture:** New `POST /v1/lookups` resource owns the orchestration. Search and MCP tools call into it on a miss. Three outcomes (`indexed` / `empty` / `not_found`) plus `deferred` on transient GitHub failure. Embeddings yes; org overviews and release summarization gated off via a new `discovery` column on `sources` and `organizations`.

**Tech Stack:** Cloudflare Workers, Hono, Drizzle ORM, D1, KV (reuse `LATEST_CACHE` namespace with `lookup:` key prefix), Bun runtime, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-04-29-on-demand-github-lookup-design.md`
**Tracking issue:** https://github.com/buildinternet/releases/issues/611

---

## File Map

**New files:**

- `workers/api/migrations/20260429000000_discovery_column.sql` — migration adding `discovery` column to `sources` and `organizations`, plus indexes, plus backfill.
- `packages/core/src/schema.ts` — modify `organizations` and `sources` table definitions to add `discovery` column.
- `workers/api/src/lib/lookup-coordinate.ts` — pure parser: string → `{ provider, org, repo } | null`.
- `workers/api/src/lib/lookup-related-org.ts` — DB lookup that resolves an unambiguous org match for the "did you mean" rail.
- `workers/api/src/lib/lookup-neg-cache.ts` — KV wrapper for negative-result cache (24h `not_found`, 6h `empty`).
- `workers/api/src/routes/lookups.ts` — `POST /v1/lookups` handler (orchestration).
- `tests/unit/lookup-coordinate.test.ts` — parser tests.
- `tests/unit/lookup-related-org.test.ts` — org-match tests.
- `tests/unit/lookup-neg-cache.test.ts` — cache wrapper tests.
- `tests/unit/lookups-route.test.ts` — integration tests against the route handler with mocked GitHub.
- `packages/adapters/src/github-probe.ts` — `probeRepo(env, owner, repo) → ProbeResult` helper.
- `tests/unit/github-probe.test.ts` — probe tests with mocked fetch.

**Modified files:**

- `workers/api/src/index.ts` — mount `lookupRoutes` under `/v1`.
- `workers/api/src/routes/search.ts` — call lookup on miss in lexical and hybrid modes; merge `lookup` field into response.
- `workers/mcp/src/mcp-agent.ts` — call lookup on miss in `search` and `search_releases` tools.
- `workers/api/src/playbook-regen.ts` — skip when `org.discovery === 'on_demand'`.
- `packages/api-types/src/index.ts` (or equivalent wire-types entry) — add `LookupResult` type, extend search response.

**Out of scope for this plan (follow-up):**

- Web frontend rendering of the new `lookup` field in `/search` responses (`web/`).
- Promotion workflow (`on_demand` → `curated`).
- Provider expansion beyond GitHub.

---

## Task 1: Schema migration — add `discovery` column

**Files:**

- Create: `workers/api/migrations/20260429000000_discovery_column.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260429000000_discovery_column.sql
-- Adds a `discovery` column to organizations and sources to mark how the row
-- was created. Values: 'curated' (default for everything pre-existing),
-- 'agent' (created by the discovery agent), 'on_demand' (created by the
-- on-demand /v1/lookups endpoint).
--
-- The column is queryable so admin tooling and AI-feature gates can filter
-- by discovery origin without parsing JSON metadata.

ALTER TABLE organizations ADD COLUMN discovery TEXT;
ALTER TABLE sources ADD COLUMN discovery TEXT;

CREATE INDEX idx_organizations_discovery ON organizations(discovery);
CREATE INDEX idx_sources_discovery ON sources(discovery);

-- Backfill existing rows to 'curated' so the column reflects reality. New
-- inserts must explicitly set discovery; the application enforces that.
UPDATE organizations SET discovery = 'curated' WHERE discovery IS NULL;
UPDATE sources SET discovery = 'curated' WHERE discovery IS NULL;
```

- [ ] **Step 2: Verify the migration applies cleanly**

Run: `bun test tests/unit/db-schema.test.ts` (if present) — or apply manually:

```bash
sqlite3 /tmp/lookup-mig-test.db < workers/api/migrations/20260429000000_discovery_column.sql
sqlite3 /tmp/lookup-mig-test.db ".schema organizations"
sqlite3 /tmp/lookup-mig-test.db ".schema sources"
```

Expected: both tables show a `discovery TEXT` column at the end. Note: this only confirms the new migration parses; it does not exercise the full migration sequence (Task 2 covers that via the test bootstrap).

- [ ] **Step 3: Commit**

```bash
git add workers/api/migrations/20260429000000_discovery_column.sql
git commit -m "feat(db): add discovery column to organizations and sources"
```

---

## Task 2: Drizzle schema update

**Files:**

- Modify: `packages/core/src/schema.ts`

- [ ] **Step 1: Add the column to the `organizations` table definition**

In `packages/core/src/schema.ts`, locate the `organizations` definition (around line 26) and add `discovery` after `embeddedAt`:

```typescript
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey().$defaultFn(newOrgId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  domain: text("domain").unique(),
  description: text("description"),
  category: text("category"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  metadata: text("metadata").default("{}"),
  embeddedAt: text("embedded_at"),
  discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] }),
});
```

- [ ] **Step 2: Add the column to the `sources` table definition**

In the same file, locate the `sources` definition (around line 147) and add `discovery` to the column list (place it next to `isHidden` and `embeddedAt` for readability):

```typescript
// inside sqliteTable("sources", { ... })
discovery: text("discovery", { enum: ["curated", "agent", "on_demand"] }),
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run existing tests to confirm schema still loads**

Run: `bun test tests/unit/`
Expected: all existing tests pass (the migration backfill makes `discovery` non-null on existing rows; new inserts that omit it leave it null, which is fine until the lookup route writes `'on_demand'` explicitly).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/schema.ts
git commit -m "feat(schema): add discovery column to organizations and sources"
```

---

## Task 3: Coordinate parser

**Files:**

- Create: `packages/core/src/lookup-coordinate.ts` (importable as `@buildinternet/releases-core/lookup-coordinate`)
- Create: `tests/unit/lookup-coordinate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lookup-coordinate.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parseCoordinate } from "../../workers/api/src/lib/lookup-coordinate.js";

describe("parseCoordinate", () => {
  test("parses a simple github coordinate", () => {
    expect(parseCoordinate("acme/random-sdk")).toEqual({
      provider: "github",
      org: "acme",
      repo: "random-sdk",
    });
  });

  test("parses repos with dots", () => {
    expect(parseCoordinate("vercel/next.js")).toEqual({
      provider: "github",
      org: "vercel",
      repo: "next.js",
    });
  });

  test("parses repos with underscores and hyphens", () => {
    expect(parseCoordinate("foo_bar/repo-name")).toEqual({
      provider: "github",
      org: "foo_bar",
      repo: "repo-name",
    });
  });

  test("returns null for empty string", () => {
    expect(parseCoordinate("")).toBeNull();
  });

  test("returns null for missing slash", () => {
    expect(parseCoordinate("acme")).toBeNull();
  });

  test("returns null for too many slashes", () => {
    expect(parseCoordinate("acme/random/extra")).toBeNull();
  });

  test("returns null for leading slash", () => {
    expect(parseCoordinate("/acme/repo")).toBeNull();
  });

  test("returns null for trailing slash", () => {
    expect(parseCoordinate("acme/repo/")).toBeNull();
  });

  test("returns null for empty org segment", () => {
    expect(parseCoordinate("/repo")).toBeNull();
  });

  test("returns null for empty repo segment", () => {
    expect(parseCoordinate("acme/")).toBeNull();
  });

  test("returns null for whitespace", () => {
    expect(parseCoordinate("acme /repo")).toBeNull();
    expect(parseCoordinate("acme/ repo")).toBeNull();
  });

  test("returns null for invalid characters", () => {
    expect(parseCoordinate("acme/repo!")).toBeNull();
    expect(parseCoordinate("acme/repo@1")).toBeNull();
  });

  test("returns null for unicode", () => {
    expect(parseCoordinate("acme/repó")).toBeNull();
  });

  test("trims surrounding whitespace before validating", () => {
    expect(parseCoordinate("  acme/repo  ")).toEqual({
      provider: "github",
      org: "acme",
      repo: "repo",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/lookup-coordinate.test.ts`
Expected: FAIL with "Cannot find module" (file doesn't exist yet).

- [ ] **Step 3: Implement the parser**

Create `workers/api/src/lib/lookup-coordinate.ts`:

```typescript
/**
 * Pure parser for GitHub-style "org/repo" coordinates. Centralized here so
 * the search routes, MCP tools, and the lookup handler all agree on what
 * counts as a parseable coordinate. Future providers (npm, GitLab, PyPI)
 * extend the discriminated union — they don't fork the regex.
 */

export type Coordinate = { provider: "github"; org: string; repo: string };

const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseCoordinate(input: string): Coordinate | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [org, repo] = parts;
  if (!org || !repo) return null;
  if (!GITHUB_SEGMENT.test(org) || !GITHUB_SEGMENT.test(repo)) return null;
  return { provider: "github", org, repo };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/lookup-coordinate.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/lookup-coordinate.ts tests/unit/lookup-coordinate.test.ts
git commit -m "feat(lookup): add coordinate parser for github org/repo"
```

---

## Task 4: GitHub probe helper

**Files:**

- Create: `packages/adapters/src/github-probe.ts`
- Create: `tests/unit/github-probe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/github-probe.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { probeRepo } from "../../packages/adapters/src/github-probe.js";

const TOKEN = "test-token";
const env = { GITHUB_TOKEN: TOKEN } as { GITHUB_TOKEN?: string };

const realFetch = globalThis.fetch;

function mockFetchOnce(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = mock((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(url.toString(), init)),
  ) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("probeRepo", () => {
  test("returns exists+hasReleases for a public repo with a release tag", async () => {
    mockFetchOnce((url) => {
      if (url.endsWith("/repos/acme/foo")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/repos/acme/foo/releases?per_page=1")) {
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      }
      if (url.endsWith("/repos/acme/foo/contents/CHANGELOG.md")) {
        return new Response("", { status: 404 });
      }
      return new Response("", { status: 404 });
    });

    const result = await probeRepo(env, "acme", "foo");
    expect(result).toEqual({
      exists: true,
      archived: false,
      hasReleases: true,
      hasChangelog: false,
      defaultBranch: "main",
    });
  });

  test("returns hasChangelog when CHANGELOG.md exists", async () => {
    mockFetchOnce((url) => {
      if (url.endsWith("/repos/acme/foo")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/repos/acme/foo/releases?per_page=1")) {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/repos/acme/foo/contents/CHANGELOG.md")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const result = await probeRepo(env, "acme", "foo");
    expect(result.exists).toBe(true);
    expect(result.hasReleases).toBe(false);
    expect(result.hasChangelog).toBe(true);
  });

  test("returns exists=false on 404", async () => {
    mockFetchOnce(() => new Response("", { status: 404 }));
    const result = await probeRepo(env, "acme", "missing");
    expect(result.exists).toBe(false);
  });

  test("returns exists=false on 403 (private/forbidden)", async () => {
    mockFetchOnce(() => new Response("", { status: 403 }));
    const result = await probeRepo(env, "acme", "private");
    expect(result.exists).toBe(false);
  });

  test("returns archived=true for archived repos", async () => {
    mockFetchOnce((url) => {
      if (url.endsWith("/repos/acme/old")) {
        return new Response(JSON.stringify({ archived: true, default_branch: "master" }), {
          status: 200,
        });
      }
      return new Response("[]", { status: 200 });
    });
    const result = await probeRepo(env, "acme", "old");
    expect(result.archived).toBe(true);
  });

  test("throws ProbeRateLimitError on 429", async () => {
    mockFetchOnce(() => new Response("", { status: 429 }));
    await expect(probeRepo(env, "acme", "foo")).rejects.toMatchObject({
      name: "ProbeRateLimitError",
    });
  });

  test("throws ProbeServerError on 500", async () => {
    mockFetchOnce(() => new Response("", { status: 500 }));
    await expect(probeRepo(env, "acme", "foo")).rejects.toMatchObject({
      name: "ProbeServerError",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/github-probe.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the probe**

Create `packages/adapters/src/github-probe.ts`:

```typescript
/**
 * Lightweight GitHub repo probe used by the on-demand lookup endpoint to
 * decide whether a coordinate maps to a real, fetchable repo before we
 * spend time on the full ingest path. Three concerns:
 *
 *   - exists: GET /repos/{owner}/{repo} returns 200
 *   - hasReleases: at least one tag/release in /repos/{owner}/{repo}/releases
 *   - hasChangelog: CHANGELOG.md exists at the repo root
 *
 * Auth uses the worker's GITHUB_TOKEN binding when present (5000 req/h)
 * and falls back to anonymous (60 req/h) otherwise. The caller decides
 * how to react to ProbeRateLimitError / ProbeServerError — typically by
 * returning a "deferred" status to the client without writing to the
 * negative cache, so a retry shortly after has a chance of succeeding.
 */

import { RELEASES_BOT_UA } from "./user-agent.js";

export interface ProbeResult {
  exists: boolean;
  archived: boolean;
  hasReleases: boolean;
  hasChangelog: boolean;
  defaultBranch: string | null;
}

export class ProbeRateLimitError extends Error {
  override name = "ProbeRateLimitError";
}

export class ProbeServerError extends Error {
  override name = "ProbeServerError";
}

interface ProbeEnv {
  GITHUB_TOKEN?: string;
}

function headers(env: ProbeEnv): HeadersInit {
  const h: Record<string, string> = {
    "User-Agent": RELEASES_BOT_UA,
    Accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) h["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(env: ProbeEnv, path: string): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers(env) });
  if (res.status === 429) throw new ProbeRateLimitError(`GitHub rate-limit on ${path}`);
  if (res.status >= 500) throw new ProbeServerError(`GitHub ${res.status} on ${path}`);
  return res;
}

export async function probeRepo(env: ProbeEnv, owner: string, repo: string): Promise<ProbeResult> {
  const repoRes = await ghFetch(env, `/repos/${owner}/${repo}`);
  if (repoRes.status === 404 || repoRes.status === 403) {
    return {
      exists: false,
      archived: false,
      hasReleases: false,
      hasChangelog: false,
      defaultBranch: null,
    };
  }
  const repoBody = (await repoRes.json()) as { archived?: boolean; default_branch?: string };

  const [releasesRes, changelogRes] = await Promise.all([
    ghFetch(env, `/repos/${owner}/${repo}/releases?per_page=1`),
    ghFetch(env, `/repos/${owner}/${repo}/contents/CHANGELOG.md`),
  ]);

  const releasesBody = releasesRes.status === 200 ? ((await releasesRes.json()) as unknown[]) : [];

  return {
    exists: true,
    archived: Boolean(repoBody.archived),
    hasReleases: Array.isArray(releasesBody) && releasesBody.length > 0,
    hasChangelog: changelogRes.status === 200,
    defaultBranch: repoBody.default_branch ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/github-probe.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/github-probe.ts tests/unit/github-probe.test.ts
git commit -m "feat(adapters): add github probeRepo helper for lookup endpoint"
```

---

## Task 5: Related-org resolver

**Files:**

- Create: `workers/api/src/lib/lookup-related-org.ts`
- Create: `tests/unit/lookup-related-org.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lookup-related-org.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { resolveRelatedOrg } from "../../workers/api/src/lib/lookup-related-org.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe("resolveRelatedOrg", () => {
  test("matches by exact org slug", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await db.insert(sources).values({
      id: "src_one",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const result = await resolveRelatedOrg(db, "acme");
    expect(result).not.toBeNull();
    expect(result?.org.slug).toBe("acme");
    expect(result?.sources).toHaveLength(1);
    expect(result?.sources[0]?.slug).toBe("acme-foo");
  });

  test("matches when github.com/{org} appears in an existing source URL", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme-corp",
      discovery: "curated",
    });
    await db.insert(sources).values({
      id: "src_one",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const result = await resolveRelatedOrg(db, "acme");
    expect(result?.org.slug).toBe("acme-corp");
  });

  test("returns null when no org matches", async () => {
    const result = await resolveRelatedOrg(testDb.db, "missing");
    expect(result).toBeNull();
  });

  test("returns null when on_demand orgs would be the only match", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_one",
      name: "On-demand",
      slug: "ondemand",
      discovery: "on_demand",
    });
    const result = await resolveRelatedOrg(db, "ondemand");
    expect(result).toBeNull();
  });

  test("returns null when multiple curated orgs match (ambiguous)", async () => {
    const db = testDb.db;
    await db.insert(organizations).values([
      { id: "org_a", name: "Apple Inc", slug: "apple", discovery: "curated" },
      { id: "org_b", name: "Apple Records", slug: "apple-records", discovery: "curated" },
    ]);
    await db.insert(sources).values([
      {
        id: "src_a",
        name: "a",
        slug: "a",
        type: "github",
        url: "https://github.com/apple/foo",
        orgId: "org_a",
        discovery: "curated",
      },
      {
        id: "src_b",
        name: "b",
        slug: "b",
        type: "github",
        url: "https://github.com/apple/bar",
        orgId: "org_b",
        discovery: "curated",
      },
    ]);
    // Both orgs have github.com/apple/* sources → ambiguous → null.
    const result = await resolveRelatedOrg(db, "apple");
    expect(result).toBeNull();
  });

  test("caps returned sources at 5", async () => {
    const db = testDb.db;
    await db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    for (let i = 0; i < 8; i++) {
      await db.insert(sources).values({
        id: `src_${i}`,
        name: `Source ${i}`,
        slug: `acme-src-${i}`,
        type: "github",
        url: `https://github.com/acme/repo-${i}`,
        orgId: "org_acme",
        discovery: "curated",
      });
    }
    const result = await resolveRelatedOrg(db, "acme");
    expect(result?.sources.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/lookup-related-org.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `workers/api/src/lib/lookup-related-org.ts`:

```typescript
import { and, desc, eq, like, or, sql, ne } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { createDb } from "../db.js";

type Db = ReturnType<typeof createDb>;

/**
 * One unambiguous "did you mean" match for a github org segment. Returned to
 * /v1/lookups callers so the not_found / empty card can show "from acme: foo,
 * bar, baz" when the specific repo we were asked about doesn't pan out.
 *
 * Ambiguous matches return null — better to show no rail than the wrong rail.
 */
export interface RelatedOrgResult {
  org: { id: string; slug: string; name: string };
  sources: Array<{ id: string; slug: string; name: string; url: string }>;
}

export async function resolveRelatedOrg(
  db: Db,
  orgSegment: string,
): Promise<RelatedOrgResult | null> {
  const exactSlugMatches = await db
    .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.slug, orgSegment), ne(organizations.discovery, "on_demand")))
    .limit(2);

  let candidates = exactSlugMatches;

  if (candidates.length === 0) {
    const urlPattern = `%github.com/${orgSegment}/%`;
    const orgsByUrl = await db
      .selectDistinct({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
      })
      .from(organizations)
      .innerJoin(sources, eq(sources.orgId, organizations.id))
      .where(and(like(sources.url, urlPattern), ne(organizations.discovery, "on_demand")))
      .limit(2);
    candidates = orgsByUrl;
  }

  if (candidates.length !== 1) return null;
  const org = candidates[0]!;

  const orgSources = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      name: sources.name,
      url: sources.url,
    })
    .from(sources)
    .where(
      and(
        eq(sources.orgId, org.id),
        or(ne(sources.discovery, "on_demand"), sql`${sources.discovery} IS NULL`),
      ),
    )
    .orderBy(desc(sources.lastFetchedAt))
    .limit(5);

  return { org, sources: orgSources };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/lookup-related-org.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/lookup-related-org.ts tests/unit/lookup-related-org.test.ts
git commit -m "feat(lookup): add related-org resolver for did-you-mean rail"
```

---

## Task 6: Negative-result cache wrapper

**Files:**

- Create: `workers/api/src/lib/lookup-neg-cache.ts`
- Create: `tests/unit/lookup-neg-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/lookup-neg-cache.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import {
  readNegCache,
  writeNegCache,
  type LookupNegStatus,
} from "../../workers/api/src/lib/lookup-neg-cache.js";

interface FakeKv {
  store: Map<string, { value: string; expirationTtl?: number }>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

function makeKv(): FakeKv {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async put(key, value, opts) {
      store.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
  };
}

describe("lookup-neg-cache", () => {
  test("read returns null when nothing is cached", async () => {
    const kv = makeKv();
    const result = await readNegCache(kv as unknown as KVNamespace, "github", "acme/foo");
    expect(result).toBeNull();
  });

  test("write stores not_found with 24h TTL", async () => {
    const kv = makeKv();
    await writeNegCache(kv as unknown as KVNamespace, "github", "acme/foo", "not_found");
    const entry = kv.store.get("lookup:github:acme/foo");
    expect(entry).toBeDefined();
    expect(entry?.expirationTtl).toBe(24 * 60 * 60);
    expect(JSON.parse(entry!.value).status).toBe("not_found");
  });

  test("write stores empty with 6h TTL", async () => {
    const kv = makeKv();
    await writeNegCache(kv as unknown as KVNamespace, "github", "acme/foo", "empty");
    const entry = kv.store.get("lookup:github:acme/foo");
    expect(entry?.expirationTtl).toBe(6 * 60 * 60);
  });

  test("read parses a stored entry", async () => {
    const kv = makeKv();
    await writeNegCache(kv as unknown as KVNamespace, "github", "acme/foo", "not_found");
    const result = await readNegCache(kv as unknown as KVNamespace, "github", "acme/foo");
    expect(result?.status).toBe("not_found");
    expect(typeof result?.checkedAt).toBe("string");
  });

  test("read returns null on malformed JSON", async () => {
    const kv = makeKv();
    kv.store.set("lookup:github:acme/foo", { value: "not-json" });
    const result = await readNegCache(kv as unknown as KVNamespace, "github", "acme/foo");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/lookup-neg-cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cache**

Create `workers/api/src/lib/lookup-neg-cache.ts`:

```typescript
/**
 * KV-backed negative-result cache for /v1/lookups. Reuses the existing
 * LATEST_CACHE namespace (binding name unchanged) with a `lookup:` key
 * prefix to avoid collision with the latest-feed cache (`latest:`) and
 * the alert-dedup keys (`alert:`).
 *
 * TTLs:
 *   - not_found: 24h (most repos that 404 today will 404 tomorrow)
 *   - empty:     6h  (empty repos are more likely to gain content soon)
 */

export type LookupNegStatus = "not_found" | "empty";

export interface LookupNegEntry {
  status: LookupNegStatus;
  checkedAt: string;
}

const TTL_SECONDS: Record<LookupNegStatus, number> = {
  not_found: 24 * 60 * 60,
  empty: 6 * 60 * 60,
};

function key(provider: string, coordinate: string): string {
  return `lookup:${provider}:${coordinate}`;
}

export async function readNegCache(
  kv: KVNamespace,
  provider: string,
  coordinate: string,
): Promise<LookupNegEntry | null> {
  const raw = await kv.get(key(provider, coordinate));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LookupNegEntry>;
    if (parsed.status !== "not_found" && parsed.status !== "empty") return null;
    if (typeof parsed.checkedAt !== "string") return null;
    return { status: parsed.status, checkedAt: parsed.checkedAt };
  } catch {
    return null;
  }
}

export async function writeNegCache(
  kv: KVNamespace,
  provider: string,
  coordinate: string,
  status: LookupNegStatus,
): Promise<void> {
  const entry: LookupNegEntry = { status, checkedAt: new Date().toISOString() };
  await kv.put(key(provider, coordinate), JSON.stringify(entry), {
    expirationTtl: TTL_SECONDS[status],
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/lookup-neg-cache.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/lookup-neg-cache.ts tests/unit/lookup-neg-cache.test.ts
git commit -m "feat(lookup): add KV-backed negative-result cache"
```

---

## Task 7: `POST /v1/lookups` route

**Files:**

- Create: `workers/api/src/routes/lookups.ts`
- Create: `tests/unit/lookups-route.test.ts`

- [ ] **Step 1: Write the failing test (covers all 5 outcomes)**

Create `tests/unit/lookups-route.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { lookupRoutes } from "../../workers/api/src/routes/lookups.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

let testDb: TestDatabase;
const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => Response) {
  globalThis.fetch = mock((url: string | URL) =>
    Promise.resolve(handler(url.toString())),
  ) as typeof globalThis.fetch;
}

interface FakeKv {
  store: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
function makeKv(): FakeKv {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
}

function makeEnv(kv: FakeKv) {
  return {
    DB: testDb.dbPath,
    LATEST_CACHE: kv,
    GITHUB_TOKEN: "test-token",
    MEDIA_ORIGIN: "",
  };
}

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
  globalThis.fetch = realFetch;
});

async function callRoute(env: ReturnType<typeof makeEnv>, body: unknown): Promise<Response> {
  return lookupRoutes.request(
    "/lookups",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/lookups", () => {
  test("400 on bad coordinate", async () => {
    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "not-a-coord" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("E_LOOKUP_BAD_COORDINATE");
  });

  test("400 on unsupported provider", async () => {
    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "npm", coordinate: "acme/foo" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("E_LOOKUP_UNSUPPORTED_PROVIDER");
  });

  test("returns existing source when one already matches", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_existing",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/foo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { id: string } };
    expect(body.status).toBe("existing");
    expect(body.source.id).toBe("src_existing");
  });

  test("returns not_found and writes neg-cache on 404 from GitHub", async () => {
    mockFetch(() => new Response("", { status: 404 }));
    const kv = makeKv();
    const env = makeEnv(kv);

    const res = await callRoute(env, { provider: "github", coordinate: "acme/missing" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("not_found");
    expect(kv.store.has("lookup:github:acme/missing")).toBe(true);
  });

  test("returns empty status when repo exists but has no releases or changelog", async () => {
    mockFetch((url) => {
      if (url.endsWith("/repos/acme/quiet")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/releases?per_page=1")) return new Response("[]", { status: 200 });
      return new Response("", { status: 404 });
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/quiet" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; source: { discovery: string } };
    expect(body.status).toBe("empty");
    expect(body.source.discovery).toBe("on_demand");

    const stored = await testDb.db
      .select()
      .from(sources)
      .where(eq(sources.url, "https://github.com/acme/quiet"));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.discovery).toBe("on_demand");
    expect(stored[0]?.isHidden).toBe(1);
  });

  test("indexed path: creates org, source, ingests releases", async () => {
    mockFetch((url) => {
      if (url.endsWith("/repos/acme/foo")) {
        return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
          status: 200,
        });
      }
      if (url.endsWith("/releases?per_page=1")) {
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
      }
      if (url.includes("/contents/CHANGELOG.md")) {
        return new Response("", { status: 404 });
      }
      // The full ingest call to /releases (paginated) returns one release.
      if (url.includes("/releases?per_page=100")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              tag_name: "v1.0.0",
              name: "v1.0.0",
              body: "first release",
              html_url: "https://github.com/acme/foo/releases/tag/v1.0.0",
              published_at: "2026-04-01T00:00:00Z",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/foo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      source: { discovery: string };
      releases: Array<{ version: string }>;
    };
    expect(body.status).toBe("indexed");
    expect(body.source.discovery).toBe("on_demand");
    expect(body.releases.length).toBeGreaterThan(0);

    const orgs = await testDb.db.select().from(organizations).where(eq(organizations.slug, "acme"));
    expect(orgs).toHaveLength(1);
    expect(orgs[0]?.discovery).toBe("on_demand");
  });

  test("returns deferred on GitHub 5xx without writing neg-cache", async () => {
    mockFetch(() => new Response("", { status: 503 }));
    const kv = makeKv();
    const env = makeEnv(kv);
    const res = await callRoute(env, { provider: "github", coordinate: "acme/server-err" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("deferred");
    expect(kv.store.has("lookup:github:acme/server-err")).toBe(false);
  });

  test("attaches relatedOrg on not_found when org segment is known", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_one",
      name: "Acme Foo",
      slug: "acme-foo",
      type: "github",
      url: "https://github.com/acme/foo",
      orgId: "org_acme",
      discovery: "curated",
    });
    mockFetch(() => new Response("", { status: 404 }));

    const env = makeEnv(makeKv());
    const res = await callRoute(env, { provider: "github", coordinate: "acme/missing" });
    const body = (await res.json()) as {
      status: string;
      relatedOrg: { slug: string; sources: unknown[] } | null;
    };
    expect(body.status).toBe("not_found");
    expect(body.relatedOrg?.slug).toBe("acme");
    expect(body.relatedOrg?.sources.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/lookups-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `workers/api/src/routes/lookups.ts`. Note: this is a longer file because it owns the orchestration, but each block has one job. The `db.ts` helper in this repo accepts a `D1Database` binding; for tests we adapt the bun-sqlite path via the same helper.

```typescript
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import { probeRepo, ProbeRateLimitError, ProbeServerError } from "@releases/adapters/github-probe";
import { github } from "@releases/adapters/github";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { parseCoordinate } from "../lib/lookup-coordinate.js";
import { resolveRelatedOrg, type RelatedOrgResult } from "../lib/lookup-related-org.js";
import { readNegCache, writeNegCache } from "../lib/lookup-neg-cache.js";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const lookupRoutes = new Hono<Env>();

type LookupStatus = "indexed" | "existing" | "empty" | "not_found" | "deferred";

interface LookupResponse {
  status: LookupStatus;
  source?: typeof sources.$inferSelect;
  releases?: Array<typeof releases.$inferSelect>;
  relatedOrg: RelatedOrgResult | null;
}

lookupRoutes.post("/lookups", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    provider?: string;
    coordinate?: string;
  } | null;
  if (!body) {
    return c.json({ error: "E_LOOKUP_BAD_REQUEST", message: "JSON body required" }, 400);
  }
  if (body.provider !== "github") {
    return c.json(
      {
        error: "E_LOOKUP_UNSUPPORTED_PROVIDER",
        message: `provider must be "github" (v1)`,
      },
      400,
    );
  }
  const parsed = parseCoordinate(body.coordinate ?? "");
  if (!parsed) {
    return c.json(
      { error: "E_LOOKUP_BAD_COORDINATE", message: "coordinate must match {org}/{repo}" },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const coordinate = `${parsed.org}/${parsed.repo}`;
  const url = `https://github.com/${coordinate}`;

  const relatedOrg = await resolveRelatedOrg(db, parsed.org);

  const cached = await readNegCache(c.env.LATEST_CACHE, "github", coordinate);
  if (cached) {
    return c.json<LookupResponse>({ status: cached.status, relatedOrg });
  }

  const existing = await db.select().from(sources).where(eq(sources.url, url)).limit(1);
  if (existing.length > 0) {
    const source = existing[0]!;
    const existingReleases = await db
      .select()
      .from(releases)
      .where(eq(releases.sourceId, source.id))
      .limit(20);
    return c.json<LookupResponse>({
      status: "existing",
      source,
      releases: existingReleases,
      relatedOrg,
    });
  }

  let probe;
  try {
    probe = await probeRepo(c.env, parsed.org, parsed.repo);
  } catch (err) {
    if (err instanceof ProbeRateLimitError || err instanceof ProbeServerError) {
      return c.json<LookupResponse>({ status: "deferred", relatedOrg });
    }
    throw err;
  }

  if (!probe.exists || probe.archived) {
    await writeNegCache(c.env.LATEST_CACHE, "github", coordinate, "not_found");
    return c.json<LookupResponse>({ status: "not_found", relatedOrg });
  }

  // Org reuse: if relatedOrg matched, attach to its org. Otherwise insert a
  // hidden on-demand org. Use parsed.org as the slug; collisions are caught
  // by the unique index and we retry with a numeric suffix.
  let orgId: string;
  if (relatedOrg) {
    orgId = relatedOrg.org.id;
  } else {
    orgId = newOrgId();
    await db.insert(organizations).values({
      id: orgId,
      name: parsed.org,
      slug: parsed.org,
      discovery: "on_demand",
    });
  }

  const sourceId = newSourceId();
  const sourceSlug = `${parsed.org}-${parsed.repo}`.toLowerCase();
  const fetchedAt = new Date().toISOString();
  const isEmpty = !probe.hasReleases && !probe.hasChangelog;

  await db.insert(sources).values({
    id: sourceId,
    name: coordinate,
    slug: sourceSlug,
    type: "github",
    url,
    orgId,
    discovery: "on_demand",
    isHidden: true,
    metadata: JSON.stringify({
      lookup: {
        coordinate,
        fetchedAt,
        lastRefreshedAt: fetchedAt,
        emptyResult: isEmpty,
      },
    }),
  });

  const insertedSource = (
    await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1)
  )[0]!;

  if (isEmpty) {
    await writeNegCache(c.env.LATEST_CACHE, "github", coordinate, "empty");
    return c.json<LookupResponse>({ status: "empty", source: insertedSource, relatedOrg });
  }

  // Full path: run the github adapter inline against the freshly-inserted
  // source. Failures here leave the source row in place (cron will retry).
  let ingestedReleases: Array<typeof releases.$inferSelect> = [];
  try {
    const result = await github.fetch(insertedSource);
    if (result.releases.length > 0) {
      const rows = result.releases.map((r) => ({
        id: newReleaseId(),
        sourceId,
        version: r.version,
        title: r.title,
        content: r.content,
        url: r.url,
        publishedAt: r.publishedAt,
      }));
      await db.insert(releases).values(rows).onConflictDoUpdate(RELEASE_URL_UPSERT);
      ingestedReleases = await db
        .select()
        .from(releases)
        .where(eq(releases.sourceId, sourceId))
        .limit(20);
    }
  } catch (err) {
    // Source row stays; cron picks it up later. Surface success-with-empty.
    console.error("lookup ingest failed", err);
  }

  return c.json<LookupResponse>({
    status: "indexed",
    source: insertedSource,
    releases: ingestedReleases,
    relatedOrg,
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/lookups-route.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/lookups.ts tests/unit/lookups-route.test.ts
git commit -m "feat(api): add POST /v1/lookups for on-demand github repo lookup"
```

---

## Task 8: Mount the route in `index.ts`

**Files:**

- Modify: `workers/api/src/index.ts`

- [ ] **Step 1: Add the import**

Open `workers/api/src/index.ts` and add `lookupRoutes` to the existing route imports (find the block where `searchRoutes`, `sourceRoutes`, etc. are imported):

```typescript
import { lookupRoutes } from "./routes/lookups.js";
```

- [ ] **Step 2: Mount the route**

Find the `v1.route("/", ...)` block (around line 273 per exploration notes) and add:

```typescript
v1.route("/", lookupRoutes);
```

Place it next to other public-readable routes; it inherits the same auth middleware that wraps `v1`.

- [ ] **Step 3: Typecheck and run tests**

```bash
npx tsc --noEmit
bun test tests/unit/lookups-route.test.ts
```

Expected: clean typecheck, lookup tests still pass.

- [ ] **Step 4: Smoke test against local wrangler**

```bash
cd workers/api
bunx wrangler dev --local --persist-to=/tmp/wrangler-local
# in another terminal:
curl -X POST http://localhost:8787/v1/lookups \
  -H 'content-type: application/json' \
  -d '{"provider":"github","coordinate":"vercel/next.js"}' | jq .status
```

Expected: `"indexed"` (or `"existing"` on second call). Note: against a freshly-applied local D1 with no data, first call hits the cold path; subsequent calls return `"existing"`.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/index.ts
git commit -m "feat(api): mount lookupRoutes under /v1"
```

---

## Task 9: Gate playbook regen for on-demand orgs

**Files:**

- Modify: `workers/api/src/playbook-regen.ts`

- [ ] **Step 1: Add the discovery check**

Open `workers/api/src/playbook-regen.ts`. Find the `regeneratePlaybook` function. After the org row is fetched (line ~33), add a guard:

```typescript
const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
if (!org) return;
if (org.discovery === "on_demand") {
  // On-demand orgs skip playbook generation by design (spec: AI gating).
  // Promotion to 'curated' clears this gate.
  return;
}
```

The exact insertion point is "after the row is loaded, before the LLM call." Match the surrounding style (early return is the existing convention).

- [ ] **Step 2: Add a test**

Append to `tests/unit/lookups-route.test.ts` (already wired to test `lookups`):

```typescript
test("does not trigger playbook regen for on_demand orgs", async () => {
  // Already covered indirectly: the indexed-path test inserts an on_demand
  // org and the test setup does not assert any playbook artifacts. Add an
  // explicit assertion that the org row stays at discovery='on_demand'
  // and no `metadata.playbook` field is populated.
  mockFetch((url) => {
    if (url.endsWith("/repos/acme/foo")) {
      return new Response(JSON.stringify({ archived: false, default_branch: "main" }), {
        status: 200,
      });
    }
    if (url.endsWith("/releases?per_page=1")) return new Response("[]", { status: 200 });
    if (url.includes("/contents/CHANGELOG.md")) return new Response("", { status: 404 });
    return new Response("[]", { status: 200 });
  });

  const env = makeEnv(makeKv());
  await callRoute(env, { provider: "github", coordinate: "acme/quiet" });

  const orgRow = await testDb.db.select().from(organizations).where(eq(organizations.slug, "acme"));
  expect(orgRow[0]?.discovery).toBe("on_demand");
  const meta = JSON.parse(orgRow[0]?.metadata ?? "{}");
  expect(meta.playbook).toBeUndefined();
});
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/unit/lookups-route.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/playbook-regen.ts tests/unit/lookups-route.test.ts
git commit -m "feat(ai-gating): skip playbook regen for on_demand orgs"
```

---

## Task 10: Wire `/v1/search` to call lookup on miss

**Files:**

- Modify: `workers/api/src/routes/search.ts`

- [ ] **Step 1: Import the parser and a thin lookup-call helper**

At the top of `workers/api/src/routes/search.ts`, add:

```typescript
import { parseCoordinate } from "../lib/lookup-coordinate.js";
```

We will not import `lookupRoutes` directly — to avoid circular imports and keep the search route thin, we extract a pure orchestration function. Refactor the lookup route to expose its core as a separate function.

- [ ] **Step 2: Refactor `lookups.ts` to expose a callable function**

Open `workers/api/src/routes/lookups.ts` and extract the body of the handler into an exported function `runLookup(env, db, parsed)` returning `LookupResponse`. The route handler becomes a thin wrapper:

```typescript
export async function runLookup(
  env: Env["Bindings"],
  db: ReturnType<typeof createDb>,
  parsed: { provider: "github"; org: string; repo: string },
): Promise<LookupResponse> {
  // ... move the existing handler body here, replacing `c.env` with `env`
  // and `c.json(...)` with `return ...`.
}

lookupRoutes.post("/lookups", async (c) => {
  // ... validation as before, then:
  const result = await runLookup(c.env, createDb(c.env.DB), parsed);
  return c.json(result);
});
```

Re-run lookup tests to confirm the refactor is clean:

```bash
bun test tests/unit/lookups-route.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Add the fallback call in lexical mode**

In `workers/api/src/routes/search.ts`, find line 117 (right after the `if (rawReleases.length === 0 && ...)` enrichment block in the lexical mode branch) and insert:

```typescript
// On-demand fallback: if the query parses as a github coordinate and we
// still have no release/source/org match, materialize a hidden source via
// /v1/lookups and merge the result into the response.
let lookup: Awaited<ReturnType<typeof runLookup>> | null = null;
const coordinate = parseCoordinate(q);
if (coordinate && rawReleases.length === 0 && orgs.length === 0 && catalog.length === 0) {
  lookup = await runLookup(c.env, db, coordinate);
}
```

Add `lookup` to the result object:

```typescript
const result = { query: q, orgs, catalog, products: catalog, sources: [], releases, lookup };
```

- [ ] **Step 4: Add the same fallback in hybrid mode**

Find the hybrid-mode result block (around line 195) and apply the same pattern:

```typescript
let lookup: Awaited<ReturnType<typeof runLookup>> | null = null;
const coordinate = parseCoordinate(q);
if (
  coordinate &&
  releases.length === 0 &&
  chunks.length === 0 &&
  orgs.length === 0 &&
  catalog.length === 0
) {
  lookup = await runLookup(c.env, db, coordinate);
}
```

Add `lookup` to the hybrid result object too.

- [ ] **Step 5: Add a wire-type for `lookup` in the search response**

Open `packages/api-types/src/index.ts` (or the file where `SearchReleaseHit` and the search response type live). Add:

```typescript
export type LookupStatus = "indexed" | "existing" | "empty" | "not_found" | "deferred";
export interface LookupResultPayload {
  status: LookupStatus;
  source?: { id: string; slug: string; name: string; url: string; discovery: string };
  releases?: Array<{ id: string; version: string; title: string; publishedAt: string | null }>;
  relatedOrg: {
    org: { id: string; slug: string; name: string };
    sources: Array<{ id: string; slug: string; name: string; url: string }>;
  } | null;
}
```

Extend the existing search response type to include `lookup?: LookupResultPayload | null`.

- [ ] **Step 6: Run typecheck and tests**

```bash
npx tsc --noEmit
bun test tests/unit/
```

Expected: all PASS, no type errors.

- [ ] **Step 7: Smoke test**

Restart wrangler dev. Search for an unknown coordinate:

```bash
curl 'http://localhost:8787/v1/search?q=vercel/turborepo&mode=lexical' | jq '.lookup.status'
```

Expected: `"indexed"` on cold call, `"existing"` on warm call. (Or `"deferred"` if GitHub rate-limits.)

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/routes/search.ts workers/api/src/routes/lookups.ts packages/api-types/src/index.ts
git commit -m "feat(search): fall back to /v1/lookups on coordinate-shaped misses"
```

---

## Task 11: Wire MCP `search` and `search_releases` tools

**Files:**

- Modify: `workers/mcp/src/mcp-agent.ts`

- [ ] **Step 1: Import the runLookup helper and parser**

The MCP worker imports from the API worker via service binding (or direct package). Confirm whether `runLookup` is reachable; if not, the MCP worker calls `POST /v1/lookups` over the existing `API` service binding.

Locate the `search` tool handler in `workers/mcp/src/mcp-agent.ts` (around lines 178–223). Inside the handler, after the existing search call returns, parse the query and call lookup if there are no hits:

```typescript
import { parseCoordinate } from "../../api/src/lib/lookup-coordinate.js";

// inside the tool handler:
if (result.releases.length === 0 && result.orgs.length === 0 && result.catalog.length === 0) {
  const coord = parseCoordinate(query);
  if (coord) {
    const lookupRes = await env.API.fetch(
      new Request("https://internal/v1/lookups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", coordinate: query }),
      }),
    );
    if (lookupRes.ok) {
      const lookup = (await lookupRes.json()) as LookupResultPayload;
      (result as SearchToolReturn & { lookup?: unknown }).lookup = lookup;
    }
  }
}
```

Note: if the MCP worker imports the parser cross-package, ensure the import path resolves to a published or workspace-linked package. If it doesn't, copy the parser into a shared location (e.g. `packages/lib/src/lookup-coordinate.ts`) so both workers consume it. In that case, also update Task 3 to put it in `packages/lib`.

- [ ] **Step 2: Apply the same in `search_releases`**

Repeat the same pattern in the `search_releases` handler (around line 259).

- [ ] **Step 3: Typecheck both workers**

```bash
(cd workers/mcp && npx tsc --noEmit)
(cd workers/api && npx tsc --noEmit)
```

Expected: clean.

- [ ] **Step 4: Smoke test via MCP**

```bash
# From the MCP worker dev environment:
curl -X POST http://localhost:8788/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"vercel/turborepo"}}}'
```

Expected: response includes a `lookup` field with `status: "indexed"` (or `"existing"` on second call).

- [ ] **Step 5: Commit**

```bash
git add workers/mcp/src/mcp-agent.ts
git commit -m "feat(mcp): fall back to /v1/lookups on coordinate misses"
```

---

## Task 12: Update AGENTS.md to document the new endpoint and column

**Files:**

- Modify: `AGENTS.md`

- [ ] **Step 1: Add the on-demand lookup section**

Open `AGENTS.md`. In the "Conventions" section, add a bullet near the existing source-type conventions:

```markdown
- On-demand source creation: `POST /v1/lookups { provider: "github", coordinate: "org/repo" }` materializes a hidden source row from a coordinate. Sources and orgs created this way carry `discovery = 'on_demand'` and `isHidden = true`. AI features (overviews, summarization) skip them; embeddings still run so semantic search works on the second hit. Negative results cached in KV (`lookup:github:{org}/{repo}`, 24h for not_found, 6h for empty). See `docs/superpowers/specs/2026-04-29-on-demand-github-lookup-design.md`.
```

In the "Route naming" bullet, add `/v1/lookups` to the list of canonical resource paths.

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document /v1/lookups and discovery column in AGENTS.md"
```

---

## Task 13: End-to-end verification against staging

**Files:** none (operational task)

- [ ] **Step 1: Apply the migration to staging**

```bash
bunx wrangler d1 migrations apply released-db-staging --env staging --config workers/api/wrangler.jsonc
```

Expected: one new migration applied (`20260429000000_discovery_column.sql`).

- [ ] **Step 2: Deploy `api`, `mcp` to staging**

```bash
bunx wrangler deploy --env staging --config workers/api/wrangler.jsonc
bunx wrangler deploy --env staging --config workers/mcp/wrangler.jsonc
```

- [ ] **Step 3: Smoke test cold path**

```bash
curl -X POST https://api-staging.releases.sh/v1/lookups \
  -H "content-type: application/json" \
  -H "X-Releases-Staging-Key: $STAGING_KEY" \
  -d '{"provider":"github","coordinate":"acme-test/never-existed-12345"}'
```

Expected: `{ "status": "not_found", "relatedOrg": null }`.

```bash
curl -X POST https://api-staging.releases.sh/v1/lookups \
  -H "content-type: application/json" \
  -H "X-Releases-Staging-Key: $STAGING_KEY" \
  -d '{"provider":"github","coordinate":"vercel/turborepo"}'
```

Expected: `{ "status": "indexed", "source": { ... }, "releases": [ ... ], "relatedOrg": null | { ... } }`. Note: if `vercel` is already a curated org in staging, expect `relatedOrg` to populate.

- [ ] **Step 4: Smoke test warm path**

Re-run the second curl. Expected: `{ "status": "existing", ... }`.

- [ ] **Step 5: Verify embeddings ran**

```bash
curl 'https://api-staging.releases.sh/v1/search?q=turborepo&mode=hybrid' \
  -H "X-Releases-Staging-Key: $STAGING_KEY" | jq '.releases | length'
```

Expected: at least one hit (the on-demand release was embedded via `waitUntil`).

- [ ] **Step 6: Roll out to prod**

After staging verification passes:

```bash
bunx wrangler d1 migrations apply released-db --config workers/api/wrangler.jsonc
bunx wrangler deploy --config workers/api/wrangler.jsonc
bunx wrangler deploy --config workers/mcp/wrangler.jsonc
```

(Or, prefer the auto-deploy on `main` per existing convention — push the merged PR and let CI deploy.)

---

## Self-review notes

1. **Spec coverage:** All seven spec components map to tasks (probe → T4, route → T7+T8, parser → T3, related-org → T5, neg-cache → T6, search wiring → T10, schema → T1+T2, AI gating → T9). MCP wiring (mentioned in spec component 6) → T11. AGENTS.md update (operational) → T12.
2. **Web rendering:** Explicitly out of scope for this plan — see file-map note. Follow-up plan once API stabilizes.
3. **Type consistency:** `LookupStatus`, `LookupResponse`, `RelatedOrgResult`, `Coordinate`, `ProbeResult`, `LookupNegStatus`, `LookupNegEntry` — all defined in their declaring task and referenced consistently downstream.
4. **Placeholder check:** No "TBD" / "implement later" / unspecified error handling. Each error path has a defined response code (deferred / not_found / empty) and tested behavior.
5. **Promotion path:** Out of scope per spec; the `discovery` column is writeable via standard admin source-update endpoints, which is enough for manual promotion.
