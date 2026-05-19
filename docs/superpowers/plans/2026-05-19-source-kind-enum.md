# Source `kind` Enum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kind` enum on `products` and `sources` so multi-source orgs (multi-language SDKs, multi-repo platforms) can be grouped and filtered out of noise in API + CLI surfaces. Source-level `kind` resolves to the product's `kind` when the source's own field is null.

**Architecture:** Nullable text column on both `products` and `sources` validated against a small enum exported from `@buildinternet/releases-core`. Read paths surface the raw stored `kind` per row; client logic (and a shared `resolveSourceKind` helper) handles the source→product fallback for ranking/filtering. Filter support lands on `/v1/sources`, `/v1/products`, `/v1/orgs/:slug/{releases,catalog}`, `/v1/search`, and the MCP `search` tool. CLI gets write commands and matching read filters.

**Tech Stack:** TypeScript, Bun, Drizzle ORM (SQLite/D1), Hono (`workers/api`), `@modelcontextprotocol/sdk` (`workers/mcp`), separate OSS CLI repo (`~/Code/releases-cli`).

---

## Naming note — `kind`, with a future-revisit caveat

The brainstorm walked through three names — `type`, `category`, and `kind` — and `kind` is the only one without an existing collision on these tables:

| Name       | Collision                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`     | `sources.type` is the fetch-adapter column (`github` / `scrape` / `feed` / `agent`).                                                                 |
| `category` | `products.category` + `organizations.category` are the public-facing industry-vertical taxonomy (`CATEGORIES` enum, `/categories/:slug` web routes). |
| `kind`     | **None.** ✓                                                                                                                                          |

**Future revisit (deliberate followup):** Of the three, `type` reads most naturally for the data-model role we're encoding here. If at some point we want to clean up the naming, the path is well-understood: rename `sources.type` → `sources.adapter` (the column literally selects which fetch _adapter_ runs against a source, so the new name is more accurate), then promote `kind` → `type` everywhere. Worth doing on its own — not in this PR, and not blocked by this PR. Memory should carry a `feedback_naming_revisit` note so the option doesn't get forgotten.

The MCP `search` tool also has a `type` input param (section selector — `"orgs"|"catalog"|"releases"|"collections"`), but that's not impacted by the `kind` choice; we just don't share a name on that tool.

## Enum values (proposed)

```ts
export const KIND_VALUES = [
  "platform",
  "sdk",
  "mobile",
  "desktop",
  "docs",
  "integration",
  "tool",
] as const;
```

Rationale:

- `platform` — primary web service / API surface; the default lean for un-typed rows.
- `sdk` — language SDKs and client libraries. Library variants fold here if the surface area is "use this from code."
- `mobile` — native mobile apps (iOS, Android). Distinct from `platform` because release cadence and audience usually differ.
- `desktop` — native desktop apps (Mac, Windows, Linux). Same rationale as `mobile`.
- `docs` — standalone docs sites / knowledge bases / API references shipped as their own release stream.
- `integration` — third-party connectors, plugins, browser extensions, IDE extensions, marketplace add-ons.
- `tool` — CLIs / devtools. Library variants fold here if the surface area is "run this on the command line."

Seven values is the starting cut — the list grows by code change like `CATEGORIES` does. Common ambiguity resolutions captured above so the discovery agent and curators don't drift.

## Resolution rule

`resolveSourceKind(source, product) -> Kind | null`:

1. If `source.kind` is set, return it.
2. Else if `product` is provided and `product.kind` is set, return it.
3. Else return `null` (caller treats as "no opinion" — default ranking weight).

`null` is preserved through reads (we don't synthesize a default) so admins can tell typed-platform rows apart from unfilled rows in tooling.

## Out of scope (followups, not this plan)

- Curated backfill of noisy orgs (AWS, Stripe, OpenAI, Anthropic, Vercel, Cloudflare…). One-off script in a follow-up plan.
- Discovery agent product-wrapper proposal when sibling-named repos exist.
- Overview generation downweighting / clustering by kind.
- Web display of kind chips on org / product pages.
- MCP filter on `search_releases`, `get_latest_releases`, `list_sources`, `list_organizations`. (Only `search` gets the filter in this pass.)
- `kind` semantics on collections, knowledge_pages, or releases themselves.

---

## File structure

### Create

- `packages/core/src/kinds.ts` — enum + helpers (mirrors `categories.ts`)
- `workers/api/migrations/20260519010000_source_kind.sql` — D1 migration
- `tests/unit/kinds.test.ts` — core helper tests
- `tests/api/source-kind-write.test.ts` — API write + validation
- `tests/api/source-kind-filter.test.ts` — list/search filter behavior

### Modify

- `packages/core/src/schema.ts:106-132` — add `kind` column to `products`
- `packages/core/src/schema.ts:268-330` — add `kind` column to `sources`
- `packages/api-types/src/api-types.ts` — add `kind` to `Product`, `Source`, and related read DTOs
- `packages/api-types/src/schemas/*.ts` — zod schemas for the above
- `workers/api/src/routes/products.ts` — read + write + filter
- `workers/api/src/routes/sources.ts` — read + write + filter
- `workers/api/src/routes/orgs.ts` — catalog + releases filter
- `workers/api/src/routes/search.ts` — `kind` query param
- `workers/mcp/src/mcp-agent.ts` — `kind` input on `search` tool
- `workers/mcp/src/tools.ts` — pass-through to API client
- `~/Code/releases-cli/src/cli/commands/admin/source.ts` (and `admin/product.ts` if separate) — `--kind` write flag
- `~/Code/releases-cli/src/cli/commands/list.ts` / `sources.ts` / `products.ts` — `--kind` read filter

### Bump

- `packages/core/package.json` — minor bump
- `packages/api-types/package.json` — minor bump (depends on new core)
- `~/Code/releases-cli/package.json` — bump deps after monorepo publishes

---

## Task sequencing

Phase A (this repo) — Tasks 1–9, lands as one or two PRs.
Phase B (releases-cli repo) — Task 10, after Phase A is deployed and packages are published.

---

### Task 1: Core — `KIND_VALUES` enum + helpers

**Files:**

- Create: `packages/core/src/kinds.ts`
- Create: `tests/unit/kinds.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/kinds.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  KIND_VALUES,
  isValidKind,
  resolveSourceKind,
  type Kind,
} from "@buildinternet/releases-core/kinds";

describe("kinds", () => {
  test("KIND_VALUES is the expected fixed list", () => {
    expect(KIND_VALUES).toEqual([
      "platform",
      "sdk",
      "mobile",
      "desktop",
      "docs",
      "integration",
      "tool",
    ]);
  });

  test("isValidKind accepts every enum value", () => {
    for (const v of KIND_VALUES) expect(isValidKind(v)).toBe(true);
  });

  test("isValidKind rejects unknown values", () => {
    expect(isValidKind("framework")).toBe(false);
    expect(isValidKind("")).toBe(false);
    expect(isValidKind("SDK")).toBe(false); // case-sensitive
  });

  test("resolveSourceKind prefers source.kind", () => {
    expect(resolveSourceKind({ kind: "sdk" }, { kind: "platform" })).toBe("sdk");
  });

  test("resolveSourceKind falls back to product.kind when source.kind is null", () => {
    expect(resolveSourceKind({ kind: null }, { kind: "sdk" })).toBe("sdk");
    expect(resolveSourceKind({ kind: undefined }, { kind: "sdk" })).toBe("sdk");
  });

  test("resolveSourceKind returns null when neither is set", () => {
    expect(resolveSourceKind({ kind: null }, { kind: null })).toBe(null);
    expect(resolveSourceKind({ kind: null }, null)).toBe(null);
    expect(resolveSourceKind({ kind: null }, undefined)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/kinds.test.ts`
Expected: FAIL with "Cannot find module '@buildinternet/releases-core/kinds'"

- [ ] **Step 3: Create the kinds module**

`packages/core/src/kinds.ts`:

```ts
export const KIND_VALUES = [
  "platform",
  "sdk",
  "mobile",
  "desktop",
  "docs",
  "integration",
  "tool",
] as const;

export type Kind = (typeof KIND_VALUES)[number];

export function isValidKind(value: string): value is Kind {
  return (KIND_VALUES as readonly string[]).includes(value);
}

type WithMaybeKind = { kind?: Kind | null | undefined };

/**
 * Resolve a source's effective kind. Returns the source's own `kind` if set,
 * otherwise the parent product's `kind` if a product is provided and set,
 * otherwise `null`. Null means "no opinion" — callers should treat unset rows
 * as default-weighted, not silently coerce to a specific value.
 */
export function resolveSourceKind(
  source: WithMaybeKind,
  product: WithMaybeKind | null | undefined,
): Kind | null {
  if (source.kind) return source.kind;
  if (product && product.kind) return product.kind;
  return null;
}
```

- [ ] **Step 4: Add the subpath export to `packages/core/package.json`**

Open `packages/core/package.json` and add `./kinds` to the `exports` map next to `./categories`:

```json
    "./kinds": {
      "types": "./dist/kinds.d.ts",
      "default": "./dist/kinds.js"
    },
```

(Use the exact same shape as the existing `./categories` entry — copy and rename.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/kinds.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit` (from repo root) and `npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/kinds.ts packages/core/package.json tests/unit/kinds.test.ts
git commit -m "feat(core): add KIND enum + resolveSourceKind helper"
```

---

### Task 2: Schema + D1 migration

**Files:**

- Modify: `packages/core/src/schema.ts` (products block ~L106–132, sources block ~L268–330)
- Create: `workers/api/migrations/20260519010000_source_kind.sql`

- [ ] **Step 1: Write the failing test**

`tests/unit/kind-column.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { products, sources } from "@buildinternet/releases-core/schema";
import { applyMigrations } from "../db-helper.js";

describe("products.kind / sources.kind column", () => {
  test("kind column accepts a valid enum value on products", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    await applyMigrations(sqlite);
    await db.insert(products).values({
      id: "prod_test1",
      name: "Test",
      slug: "test",
      orgId: "org_seed",
      kind: "sdk",
    });
    const row = await db.select().from(products).where(eq(products.id, "prod_test1")).get();
    expect(row?.kind).toBe("sdk");
  });

  test("kind column defaults to null on sources when omitted", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    await applyMigrations(sqlite);
    await db.insert(sources).values({
      id: "src_test1",
      name: "Test",
      slug: "test",
      url: "https://example.com",
      type: "feed",
      orgId: "org_seed",
    });
    const row = await db.select().from(sources).where(eq(sources.id, "src_test1")).get();
    expect(row?.kind).toBe(null);
  });
});
```

(If `tests/db-helper.ts` doesn't already seed `org_seed`, prepend a small insert in each test or extend the helper — read `tests/db-helper.ts` first and follow the pattern that already exists.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/kind-column.test.ts`
Expected: FAIL with "no such column: kind" (or drizzle type error on the insert).

- [ ] **Step 3: Add the column to drizzle schema**

In `packages/core/src/schema.ts`, inside the `products` table definition (currently ending around line 122 with `deletedAt`), add **above** `createdAt`:

```ts
    kind: text("kind"),
```

In the same file, inside the `sources` table definition, add **above** `createdAt` (mirror the products placement). Note: the existing `sources.type` column (fetch adapter) is unrelated and stays untouched.

```ts
    kind: text("kind"),
```

Add a non-unique partial index for filter performance — append to each table's indexes array.

For products (in the `(table) => [...]` after the existing `idx_products_deleted_at`):

```ts
    index("idx_products_kind").on(table.kind).where(sql`${table.kind} IS NOT NULL`),
```

For sources (after `idx_sources_deleted_at`):

```ts
    index("idx_sources_kind").on(table.kind).where(sql`${table.kind} IS NOT NULL`),
```

- [ ] **Step 4: Write the D1 migration**

`workers/api/migrations/20260519010000_source_kind.sql`:

```sql
-- Adds nullable `kind` enum column to products and sources. Validated in app
-- code against KIND_VALUES from @buildinternet/releases-core (no CHECK
-- constraint — keeping the SQL forgiving so an enum-list change doesn't
-- require a follow-up migration).
ALTER TABLE products ADD COLUMN kind TEXT;
ALTER TABLE sources ADD COLUMN kind TEXT;

CREATE INDEX IF NOT EXISTS idx_products_kind ON products(kind) WHERE kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind) WHERE kind IS NOT NULL;
```

- [ ] **Step 5: Make sure the test helper picks the new migration up**

Read `tests/db-helper.ts`. If it globs migrations from `workers/api/migrations/` in lexicographic order, the new file is picked up automatically. If it has a hand-maintained list, add the new filename in the right position.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/kind-column.test.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (note: `Product` and `Source` inferred types now include `kind: string | null`; downstream call sites compile because nullable fields are additive in selects).

- [ ] **Step 8: Apply migration to staging D1**

Per memory, staging DB autonomy is fine:

```bash
bunx wrangler d1 execute released-db-staging --remote --file=workers/api/migrations/20260519010000_source_kind.sql
```

Expected: `Executed 4 queries` (2 ALTERs + 2 CREATE INDEX). Prod migration is deferred until the API code lands — see Task 9, Step 6.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/schema.ts workers/api/migrations/20260519010000_source_kind.sql tests/unit/kind-column.test.ts
git commit -m "feat(db): add nullable kind column to products and sources"
```

---

### Task 3: api-types wire shape

**Files:**

- Modify: `packages/api-types/src/api-types.ts`
- Modify: `packages/api-types/src/schemas/*.ts` (whichever files define Product / Source / OrgCatalogEntry zod schemas — verify with `grep -rn "Product\|Source" packages/api-types/src/schemas/`)

- [ ] **Step 1: Locate the existing Product / Source DTOs**

Run: `grep -rn "name:.*z.string\|slug:.*z.string\|categorySlug" packages/api-types/src/`
Find the file that defines `ProductSchema` and `SourceSchema` (likely `packages/api-types/src/schemas/products.ts`, `sources.ts`, or a combined `catalog.ts`).

- [ ] **Step 2: Write the failing test**

`tests/unit/api-types-kind.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ProductSchema, SourceSchema } from "@buildinternet/releases-api-types";

describe("api-types kind field", () => {
  test("ProductSchema accepts kind", () => {
    const parsed = ProductSchema.parse({
      id: "prod_x",
      name: "X",
      slug: "x",
      orgId: "org_x",
      orgSlug: "x",
      kind: "sdk",
    });
    expect(parsed.kind).toBe("sdk");
  });

  test("ProductSchema accepts null kind", () => {
    const parsed = ProductSchema.parse({
      id: "prod_x",
      name: "X",
      slug: "x",
      orgId: "org_x",
      orgSlug: "x",
      kind: null,
    });
    expect(parsed.kind).toBe(null);
  });

  test("SourceSchema rejects an unknown kind value", () => {
    expect(() =>
      SourceSchema.parse({
        id: "src_x",
        name: "X",
        slug: "x",
        url: "https://example.com",
        type: "feed",
        orgSlug: "x",
        kind: "framework",
      }),
    ).toThrow();
  });
});
```

(Adjust the required fields in each `parse(...)` call to match the actual schema once you've read it.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/api-types-kind.test.ts`
Expected: FAIL with "Unrecognized key(s) in object: 'kind'" or similar.

- [ ] **Step 4: Add `kind` to the schemas**

In the file(s) found in Step 1, add to both `ProductSchema` and `SourceSchema`:

```ts
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";

// inside the z.object({...}):
  kind: z.enum(KIND_VALUES).nullable().optional(),
```

(The `.optional()` is so old payloads without the field still parse — important during rollout. The `.nullable()` already covers the "not set" case, so leave `.optional()` in place permanently — it just means clients aren't forced to send the key.)

Also add `kind` to any related read-only DTOs that surface products/sources to clients — e.g. catalog entries, source detail, search hits. Grep usage to be thorough:

```bash
grep -rln "ProductSchema\|SourceSchema\|productId.*z.string\|sourceId.*z.string" packages/api-types/src/
```

For any DTO that already includes `category` or `categorySlug`, also add `kind`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/api-types-kind.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check the whole repo**

Run: `npx tsc --noEmit`
Expected: no errors. (Downstream worker code still compiles because new optional/nullable fields don't break existing payload construction; they'll start being read from in later tasks.)

- [ ] **Step 7: Commit**

```bash
git add packages/api-types/src/ tests/unit/api-types-kind.test.ts
git commit -m "feat(api-types): add nullable kind field to Product and Source DTOs"
```

---

### Task 4: API — surface `kind` on read responses

**Files:**

- Modify: `workers/api/src/routes/products.ts`
- Modify: `workers/api/src/routes/sources.ts`
- Modify: `workers/api/src/routes/orgs.ts` (catalog handler)
- Modify: `workers/api/src/routes/search.ts` (org + catalog hit rows)

- [ ] **Step 1: Write the failing test**

`tests/api/source-kind-read.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { setupApi, seedProduct, seedSource } from "../api-helper.js";

describe("kind on read responses", () => {
  test("GET /v1/products/:slug returns kind", async () => {
    const { app, env } = await setupApi();
    await seedProduct(env, { slug: "test-sdk-py", orgSlug: "acme", kind: "sdk" });

    const res = await app.request("/v1/orgs/acme/products/test-sdk-py");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("sdk");
  });

  test("GET /v1/sources/:slug returns kind", async () => {
    const { app, env } = await setupApi();
    await seedSource(env, { slug: "acme-docs", orgSlug: "acme", kind: "docs" });

    const res = await app.request("/v1/orgs/acme/sources/acme-docs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("docs");
  });

  test("GET /v1/orgs/:slug/catalog returns kind on each entry", async () => {
    const { app, env } = await setupApi();
    await seedProduct(env, { slug: "py", orgSlug: "acme", kind: "sdk" });
    await seedSource(env, { slug: "docs", orgSlug: "acme", kind: "docs" });

    const res = await app.request("/v1/orgs/acme/catalog");
    const body = await res.json();
    const py = body.entries.find((e: any) => e.slug === "py");
    const docs = body.entries.find((e: any) => e.slug === "docs");
    expect(py?.kind).toBe("sdk");
    expect(docs?.kind).toBe("docs");
  });
});
```

(Verify the actual helper names in `tests/api-helper.ts` or the equivalent; if `seedProduct` / `seedSource` don't accept `kind`, extend them first — small adjacent change.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api/source-kind-read.test.ts`
Expected: FAIL — `kind` undefined in response bodies.

- [ ] **Step 3: Add `kind` to the SELECT lists**

In each of `workers/api/src/routes/products.ts`, `sources.ts`, `orgs.ts` (catalog), `search.ts` (org/catalog rows):

Find the drizzle `.select({ ... })` call for the product/source row and add:

```ts
kind: products.kind,
// or
kind: sources.kind,
```

Then in the response-shaping code (the bit that maps the DB row to the wire JSON), include `kind` on the output object.

For the catalog endpoint (`workers/api/src/routes/orgs.ts`), both product entries and direct-source entries need `kind`. The handler builds two queries and merges them — make sure both legs include the field.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/api/source-kind-read.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p workers/api`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/ tests/api/source-kind-read.test.ts
git commit -m "feat(api): surface kind on product, source, catalog, and search read responses"
```

---

### Task 5: API — accept `kind` on write (POST / PATCH)

**Files:**

- Modify: `workers/api/src/routes/products.ts` (POST + PATCH handlers)
- Modify: `workers/api/src/routes/sources.ts` (POST + PATCH handlers)

- [ ] **Step 1: Write the failing test**

`tests/api/source-kind-write.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { setupApi, authHeaders } from "../api-helper.js";

describe("kind on write paths", () => {
  test("POST /v1/products accepts kind:sdk", async () => {
    const { app } = await setupApi({ seedOrg: { slug: "acme" } });
    const res = await app.request("/v1/products", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ name: "Py SDK", slug: "py-sdk", orgSlug: "acme", kind: "sdk" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe("sdk");
  });

  test("PATCH /v1/sources/:slug updates kind", async () => {
    const { app } = await setupApi({ seedSource: { slug: "acme-feed", orgSlug: "acme" } });
    const res = await app.request("/v1/orgs/acme/sources/acme-feed", {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ kind: "sdk" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe("sdk");
  });

  test("PATCH allows clearing kind by sending null", async () => {
    const { app } = await setupApi({ seedSource: { slug: "x", orgSlug: "acme", kind: "sdk" } });
    const res = await app.request("/v1/orgs/acme/sources/x", {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ kind: null }),
    });
    expect((await res.json()).kind).toBe(null);
  });

  test("rejects an invalid kind value", async () => {
    const { app } = await setupApi({ seedOrg: { slug: "acme" } });
    const res = await app.request("/v1/products", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ name: "Y", slug: "y", orgSlug: "acme", kind: "framework" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api/source-kind-write.test.ts`
Expected: FAIL — POST/PATCH bodies don't recognize `kind`, returns 400 on every case or persists silently without it.

- [ ] **Step 3: Add `kind` to the request schema and write logic**

In each route file, find the zod request schema for POST and PATCH (look for the `z.object({...})` next to the route handler). Add:

```ts
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";

// In the request schema:
  kind: z.enum(KIND_VALUES).nullable().optional(),
```

Then in the handler, include `kind` in the `INSERT` / `UPDATE` value object. PATCH semantics: if the body has `kind` (even as `null`), apply it; if the key is absent, leave the row untouched. Use `"kind" in body` as the discriminator so `null` is preserved.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/api/source-kind-write.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/ tests/api/source-kind-write.test.ts
git commit -m "feat(api): accept kind on POST/PATCH for products and sources with enum validation"
```

---

### Task 6: API — list endpoint filters

**Files:**

- Modify: `workers/api/src/routes/products.ts` (`GET /v1/products`)
- Modify: `workers/api/src/routes/sources.ts` (`GET /v1/sources`)
- Modify: `workers/api/src/routes/orgs.ts` (`GET /v1/orgs/:slug/releases`, `GET /v1/orgs/:slug/catalog`)

- [ ] **Step 1: Write the failing test**

`tests/api/source-kind-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { setupApi, seedSource, seedProduct, seedRelease } from "../api-helper.js";

describe("kind filter on list endpoints", () => {
  test("GET /v1/sources?kind=sdk narrows to sdk sources", async () => {
    const { app, env } = await setupApi();
    await seedSource(env, { slug: "a", orgSlug: "acme", kind: "sdk" });
    await seedSource(env, { slug: "b", orgSlug: "acme", kind: "docs" });
    await seedSource(env, { slug: "c", orgSlug: "acme", kind: null });

    const res = await app.request("/v1/sources?kind=sdk&orgSlug=acme");
    const body = await res.json();
    const slugs = body.sources.map((s: any) => s.slug).sort();
    expect(slugs).toEqual(["a"]);
  });

  test("GET /v1/products?kind=sdk narrows to sdk products", async () => {
    const { app, env } = await setupApi();
    await seedProduct(env, { slug: "p1", orgSlug: "acme", kind: "sdk" });
    await seedProduct(env, { slug: "p2", orgSlug: "acme", kind: "platform" });

    const res = await app.request("/v1/products?kind=sdk&orgSlug=acme");
    const body = await res.json();
    expect(body.products.map((p: any) => p.slug)).toEqual(["p1"]);
  });

  test("GET /v1/orgs/:slug/releases?kind=platform excludes releases from sdk sources", async () => {
    const { app, env } = await setupApi();
    const sdk = await seedSource(env, { slug: "sdk-src", orgSlug: "acme", kind: "sdk" });
    const platform = await seedSource(env, {
      slug: "platform-src",
      orgSlug: "acme",
      kind: "platform",
    });
    await seedRelease(env, { sourceId: sdk.id, title: "sdk release" });
    await seedRelease(env, { sourceId: platform.id, title: "platform release" });

    const res = await app.request("/v1/orgs/acme/releases?kind=platform");
    const body = await res.json();
    const titles = body.releases.map((r: any) => r.title);
    expect(titles).toEqual(["platform release"]);
  });

  test("kind filter resolves through product when source.kind is null", async () => {
    const { app, env } = await setupApi();
    const prod = await seedProduct(env, { slug: "py", orgSlug: "acme", kind: "sdk" });
    const src = await seedSource(env, {
      slug: "py-src",
      orgSlug: "acme",
      productId: prod.id,
      kind: null,
    });
    await seedRelease(env, { sourceId: src.id, title: "py update" });

    const res = await app.request("/v1/orgs/acme/releases?kind=sdk");
    const body = await res.json();
    expect(body.releases.map((r: any) => r.title)).toEqual(["py update"]);
  });

  test("400 on unknown kind", async () => {
    const { app } = await setupApi();
    const res = await app.request("/v1/sources?kind=framework");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api/source-kind-filter.test.ts`
Expected: FAIL — filter not applied; returns all rows.

- [ ] **Step 3: Implement the filter on `/v1/sources` and `/v1/products`**

In each list handler:

```ts
import { isValidKind, KIND_VALUES, type Kind } from "@buildinternet/releases-core/kinds";

// inside the handler, after parsing other query params:
const kindParam = c.req.query("kind");
if (kindParam !== undefined && !isValidKind(kindParam)) {
  return c.json(
    { error: "bad_request", message: `Invalid kind. Expected one of: ${KIND_VALUES.join(", ")}` },
    400,
  );
}
const kind = kindParam as Kind | undefined;

// in the drizzle query .where(...) call, append the kind predicate alongside
// existing filters using the same pattern the handler already uses (and().push
// vs. inline conditional spread). Example with array-spread pattern:
//   ...(kind ? [eq(products.kind, kind)] : [])
```

- [ ] **Step 4: Implement filter with source→product fallback on `/v1/orgs/:slug/releases`**

The release feed joins releases to sources. To filter by resolved kind (`source.kind ?? product.kind`), `LEFT JOIN products` (if not already joined) and use `COALESCE`:

```ts
// in the .where(...) clause when kind is provided:
sql`COALESCE(${sources.kind}, ${products.kind}) = ${kind}`;
```

(If the existing query doesn't join products, add `.leftJoin(products, eq(sources.productId, products.id))` inside the chain.)

Same pattern for `/v1/orgs/:slug/catalog`: filter product entries on `products.kind`, filter direct-source entries on `sources.kind` (no fallback needed for catalog since each row's kind is its own).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/api/source-kind-filter.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Update OpenAPI annotations**

Find the `describeRoute({...})` for each modified endpoint and add the `kind` query parameter spec (mirror existing `category` / `orgSlug` entries in the same file). This is required for the OpenAPI coverage gate (per AGENTS.md).

Run: `bun run scripts/check-openapi-coverage.ts`
Expected: no warnings about new undocumented params.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/routes/ tests/api/source-kind-filter.test.ts
git commit -m "feat(api): kind filter on /v1/sources, /v1/products, /v1/orgs/:slug/{releases,catalog}"
```

---

### Task 7: API — `kind` filter on `/v1/search`

**Files:**

- Modify: `workers/api/src/routes/search.ts`
- Modify: `workers/api/src/lib/search-hybrid.ts` (if hybrid filtering goes through here)

- [ ] **Step 1: Write the failing test**

Append to `tests/api/source-kind-filter.test.ts`:

```ts
describe("kind filter on /v1/search", () => {
  test("filters release hits by resolved kind", async () => {
    const { app, env } = await setupApi();
    const sdkSrc = await seedSource(env, { slug: "sdk-src", orgSlug: "acme", kind: "sdk" });
    const platSrc = await seedSource(env, { slug: "plat-src", orgSlug: "acme", kind: "platform" });
    await seedRelease(env, { sourceId: sdkSrc.id, title: "shipping autograd" });
    await seedRelease(env, { sourceId: platSrc.id, title: "shipping new dashboard" });

    const res = await app.request("/v1/search?q=shipping&mode=lexical&kind=platform");
    const body = await res.json();
    const titles = body.releases.items.map((r: any) => r.title);
    expect(titles).toEqual(["shipping new dashboard"]);
  });

  test("filters catalog + org hits by kind", async () => {
    const { app, env } = await setupApi();
    await seedSource(env, {
      slug: "acme-sdk-py",
      orgSlug: "acme",
      name: "acme-sdk-py",
      kind: "sdk",
    });
    await seedSource(env, {
      slug: "acme-platform",
      orgSlug: "acme",
      name: "acme-platform",
      kind: "platform",
    });

    const res = await app.request("/v1/search?q=acme&kind=sdk");
    const body = await res.json();
    const catalogSlugs = body.catalog.items.map((c: any) => c.slug);
    expect(catalogSlugs).toEqual(["acme-sdk-py"]);
  });

  test("400 on unknown kind on /v1/search", async () => {
    const { app } = await setupApi();
    const res = await app.request("/v1/search?q=foo&kind=framework");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api/source-kind-filter.test.ts`
Expected: FAIL — no kind filter applied.

- [ ] **Step 3: Add `kind` to the search handler**

In `workers/api/src/routes/search.ts`, alongside the existing query param parsing block (`limit`, `offset`, `mode`, `domain`, `include_*`):

```ts
import { isValidKind, KIND_VALUES, type Kind } from "@buildinternet/releases-core/kinds";

const kindParam = c.req.query("kind");
if (kindParam !== undefined && !isValidKind(kindParam)) {
  return c.json(
    { error: "bad_request", message: `Invalid kind. Expected one of: ${KIND_VALUES.join(", ")}` },
    400,
  );
}
const kind = kindParam as Kind | undefined;
```

Thread `kind` into each section's query:

- **orgs section:** unaffected (orgs themselves aren't typed). Skip.
- **catalog section:** filter rows where the row's own `kind = ?` — product rows on `products.kind`, direct-source rows on `sources.kind`.
- **releases section:** apply the `COALESCE(sources.kind, products.kind) = ?` predicate from Task 6 inside the release subquery — both for the lexical FTS path and the hybrid/semantic post-filter on vector results.
- **collections section:** unaffected.

- [ ] **Step 4: Update OpenAPI annotation for `/v1/search`**

Add to the `parameters: [...]` array in `describeRoute(...)`:

```ts
{
  name: "kind",
  in: "query",
  required: false,
  schema: { type: "string", enum: KIND_VALUES as unknown as string[] },
  description:
    "Filter results to a specific source/product kind. Release and catalog rows resolve through source.kind ?? product.kind. The orgs section is unaffected.",
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/api/source-kind-filter.test.ts`
Expected: PASS (all 8 cases — the original 5 plus the 3 new search cases).

- [ ] **Step 6: Spot-check OpenAPI coverage**

Run: `bun run scripts/check-openapi-coverage.ts`
Expected: no new warnings.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/routes/search.ts workers/api/src/lib/ tests/api/source-kind-filter.test.ts
git commit -m "feat(api): kind filter on /v1/search across release, catalog sections"
```

---

### Task 8: MCP — `kind` filter on the `search` tool

**Files:**

- Modify: `workers/mcp/src/mcp-agent.ts` (input schema near L370)
- Modify: `workers/mcp/src/tools.ts` (forward param to API client)

- [ ] **Step 1: Write the failing test**

`tests/mcp/search-kind.test.ts` (mirror an existing MCP test in `tests/mcp/`):

```ts
import { describe, expect, test } from "bun:test";
import { setupMcp, seedSource } from "../mcp-helper.js";

describe("MCP search tool kind input", () => {
  test("forwards kind to the API and narrows results", async () => {
    const { client, env } = await setupMcp();
    await seedSource(env, { slug: "py", orgSlug: "acme", name: "acme-py-sdk", kind: "sdk" });
    await seedSource(env, { slug: "core", orgSlug: "acme", name: "acme-core", kind: "platform" });

    const result = await client.callTool({
      name: "search",
      arguments: { query: "acme", kind: "sdk" },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.catalog.items.map((c: any) => c.slug)).toEqual(["py"]);
  });
});
```

(Adapt to the actual MCP test helper shape in this repo.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/search-kind.test.ts`
Expected: FAIL — `kind` input ignored.

- [ ] **Step 3: Add `kind` to the tool input schema**

In `workers/mcp/src/mcp-agent.ts`, find the `search` tool registration block (around L370 — currently has `type: z.array(z.enum(["orgs", "catalog", "releases", "collections"]))`). Add to the same `z.object({...})`:

```ts
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";

  kind: z
    .enum(KIND_VALUES)
    .optional()
    .describe(
      "Filter to a specific source/product kind. Release and catalog rows resolve through source.kind ?? product.kind.",
    ),
```

- [ ] **Step 4: Forward `kind` to the API client**

In `workers/mcp/src/tools.ts`, find the `search` tool body (line ~1576 according to the earlier grep). Where it builds the request URL or query params for the upstream `/v1/search` call, append `kind` when set:

```ts
if (input.kind) params.set("kind", input.kind);
```

(Or whatever the existing param-building idiom is — match the existing pattern for `type`, `mode`, etc.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/mcp/search-kind.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/mcp/src/ tests/mcp/search-kind.test.ts
git commit -m "feat(mcp): add kind input to search tool"
```

---

### Task 9: api-types + core release prep (monorepo)

**Files:**

- Modify: `packages/core/package.json` (bump minor)
- Modify: `packages/api-types/package.json` (bump minor + bump core dep)

- [ ] **Step 1: Determine bump levels**

`@buildinternet/releases-core` — minor bump (new subpath export + schema-shape change). Example: 0.5.x → 0.6.0.
`@buildinternet/releases-api-types` — minor bump (new optional field). Example: 0.21.0 → 0.22.0. Also bump the `@buildinternet/releases-core` dependency in this manifest to the new caret-range.

Per memory `api-types: no workspace:* in manifest`, the api-types manifest must pin core to a real range, not `workspace:*`.

- [ ] **Step 2: Apply the bumps**

Edit both `package.json` files; no code change beyond version strings + the api-types core-dep range.

- [ ] **Step 3: Smoke build**

```bash
bun run build  # or whatever the package build script is — likely `tsc -p tsconfig.build.json` per package
```

Expected: clean build of both packages; no stale `.d.ts` referring to the old shapes.

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json packages/api-types/package.json
git commit -m "chore(release): bump core + api-types for kind enum"
```

- [ ] **Step 5: Publish workflow**

Open a PR with Tasks 1–9. After merge, follow the existing publish flow (the monorepo runs `npm publish` per memory — verify in repo root scripts or `.github/workflows/`). Both `@buildinternet/releases-core` and `@buildinternet/releases-api-types` need to land on npm before Phase B starts.

- [ ] **Step 6: Run prod D1 migration after deploy**

```bash
bunx wrangler d1 execute released-db --remote --file=workers/api/migrations/20260519010000_source_kind.sql
```

**Confirm with the user before this** — production migration is the one destructive operation in this plan that needs explicit approval per the user's standing instructions.

---

### Task 10 (Phase B): CLI — write + read filter support

**Repo:** `~/Code/releases-cli`

**Files:**

- Modify: `~/Code/releases-cli/package.json` (bump `@buildinternet/releases-core` + `@buildinternet/releases-api-types` deps to the just-published versions)
- Modify: `~/Code/releases-cli/src/cli/commands/admin/source.ts` (or wherever `admin source update` is defined)
- Modify: `~/Code/releases-cli/src/cli/commands/admin/product.ts` (or `admin/product/update.ts`)
- Modify: `~/Code/releases-cli/src/cli/commands/sources.ts` / `products.ts` / equivalent list commands
- Modify: `~/Code/releases-cli/src/cli/commands/search.ts` (or whichever file hosts `releases search`)

- [ ] **Step 1: Bump api-types + core in the CLI**

```bash
cd ~/Code/releases-cli
bun add @buildinternet/releases-core@^X.Y.Z @buildinternet/releases-api-types@^A.B.C
```

(Substitute the versions published in Phase A.) Per memory `feedback_cli_changesets`, this CLI uses changesets — add `.changeset/source-kind.md` capturing the bump (target `@buildinternet/releases`, fixed-group cascades).

- [ ] **Step 2: Write the failing test (write command)**

In CLI test layout (`~/Code/releases-cli/tests/...` — verify shape first), add:

```ts
import { describe, expect, test } from "bun:test";
import { runCli, mockApi } from "../helper.js";

describe("releases admin source update --kind", () => {
  test("sets kind on a source", async () => {
    const mock = mockApi();
    mock.expectPatch("/v1/orgs/acme/sources/feed", { kind: "sdk" }, { ok: true, kind: "sdk" });

    const out = await runCli(["admin", "source", "update", "acme/feed", "--kind", "sdk"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("kind: sdk");
  });

  test("rejects an invalid kind locally before hitting the API", async () => {
    const out = await runCli(["admin", "source", "update", "acme/feed", "--kind", "framework"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toMatch(/invalid kind/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run from `~/Code/releases-cli`: `bun test tests/cli/admin-source-kind.test.ts`
Expected: FAIL — `--kind` flag unknown.

- [ ] **Step 4: Add `--kind` to the relevant admin commands**

Mirror the existing `--priority` or `--category` flag pattern in `admin source update` / `admin product update`. Validate locally via `isValidKind` from `@buildinternet/releases-core/kinds`; on invalid, print an error listing `KIND_VALUES` and exit non-zero. Pass through to the API client as a PATCH body field.

- [ ] **Step 5: Add `--kind` read filter to list commands**

In whichever files host `releases sources list`, `releases products list`, `releases search`, add `--kind <value>` as an optional flag, validate locally, append to the outbound query string.

- [ ] **Step 6: Add test for the read filter**

```ts
test("releases sources list --kind sdk passes ?kind=sdk to the API", async () => {
  const mock = mockApi();
  mock.expectGet("/v1/sources?kind=sdk", { sources: [{ slug: "a", kind: "sdk" }] });
  const out = await runCli(["sources", "list", "--kind", "sdk"]);
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toContain("a");
});
```

- [ ] **Step 7: Run all tests**

Run: `bun test` (in `~/Code/releases-cli`)
Expected: all green.

- [ ] **Step 8: Update CLI docs / help text**

Surface `--kind` in:

- `--help` output (Commander descriptions, etc.)
- Any plugin skill files under `~/Code/releases-cli/plugins/claude/releases/commands/` that document the relevant commands.

- [ ] **Step 9: Commit + changeset entry + PR**

```bash
cd ~/Code/releases-cli
git add .
git commit -m "feat(cli): kind enum support — admin source/product update --kind, list/search filters"
```

Open PR. After merge + release, `releases admin source update foo/bar --kind sdk` is live.

---

## Update memory after approval

Once the user confirms `kind` (vs `type`) and approves this plan, update `/Users/zachdunn/.claude/projects/-Users-zachdunn-Code-releases/memory/project_source_type_grouping.md`:

- Rename slug to `source-kind-grouping`
- Update title and body references from `type` to `kind`
- Note the rename rationale (collision with existing MCP `search.type`)

---

## Self-review

**Spec coverage:**

- Settled design (kind enum on products + sources, source inherits from product) — Tasks 1, 2.
- CLI support — Task 10.
- API support — Tasks 4, 5.
- Filter common paths (search etc.) — Tasks 6, 7, 8.
- Out-of-scope items called out explicitly (curated backfill, agent proposal, overview weighting, web display, other MCP tools).

**Placeholder scan:** No TBDs in code blocks; the only "verify with grep" steps are at the top of Task 3 (api-types DTO file location), which is a legitimate small lookup, not a hidden TBD.

**Type consistency:** `Kind` type is defined once in Task 1 and re-used everywhere via `import { KIND_VALUES, Kind, isValidKind, resolveSourceKind } from "@buildinternet/releases-core/kinds"`. `kind` column name is consistent across schema, migration SQL, drizzle field, zod schemas, query params, and CLI flags.

---

## Execution handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Before either, confirm:

- **Field name `kind` vs `type`?** Recommend `kind` to avoid the MCP `search.type` collision. (Plan written for `kind`; trivially renameable if you want `type` + a different filter param name on search.)
- **Enum values** — proposed `["platform", "sdk", "mobile", "desktop", "docs", "integration", "tool"]`. Tighten / extend before we start?
- **Scope cutoff** — out-of-scope list above (curated backfill, agent proposal, overview weighting, web display, other MCP tools) — anything you want pulled in?
