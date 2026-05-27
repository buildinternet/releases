# Product-first URL resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bare `/[org]/[slug]` resolve **product-first** (with a source fallback), give shadowed sources a stable home at `/sources/:id`, and collapse the `/product/` prefix to a permanent 308 — non-breaking, lean/by-precedence.

**Architecture:** A new `GET /v1/orgs/:org/resolve/:slug` returns a discriminated `{ kind: "product" | "source" }` full-detail payload in one round trip. The web `[orgSlug]/[sourceSlug]` and `[orgSlug]/product/[productSlug]` routes merge into one `[orgSlug]/[slug]` segment that dispatches on `kind`. A new ID-keyed `/sources/[id]` route renders shadowed sources. `web/src/lib/links.ts` is the single seam that flips `productPath` to the bare form.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono + hono-openapi, Drizzle/D1, Next.js 15 (App Router, RSC), Zod (`@buildinternet/releases-api-types`), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-27-product-first-url-resolution-design.md` · **Issue:** #1190

**Rollout:** Tasks 1–8 are dark infrastructure (no rendered-URL change) → **PR 1**. Tasks 9–14 are the cutover → **PR 2**. Land PR 1 and let it bake before PR 2. Both can be one PR if the diff stays reviewable.

**Conventions you must follow (this codebase):**

- Worker tests import the route sub-app directly and call `routes.request(path, init, env, ctx)` via `makeCaller` from `tests/api/route-test-helpers.ts`; there is **no** `createTestApp`. Test DB via `createTestDb()` from `tests/db-helper.ts` (`db` doubles as a drizzle handle and a D1 shim; pass `db as unknown as never` for `env.DB`).
- Worker logs use `logEvent("warn"|"info"|"error", { component, event, ... })` from `@releases/lib/log-event`. No `level` field.
- Next.js 15 async params: `const { orgSlug } = await params;`. 308 via `permanentRedirect(...)` from `next/navigation` (throws; no `return`).
- Run gate before declaring done: `npx tsc --noEmit` (root + `web` + `workers/api`), `bun run lint`, `bun test`, `bun run scripts/check-openapi-coverage.ts`.

---

## File structure

**Create:**

- `packages/api-types/src/schemas/resolve.ts` — `ResolveResponseSchema` discriminated union.
- `tests/api/orgs-resolve.test.ts` — resolver endpoint tests.
- `packages/core/src/reserved-slugs.test.ts` — reserved-slug regression tests.
- `web/src/app/sources/[id]/page.tsx`, `.../changelog/page.tsx`, `.../highlights/page.tsx`, `.../layout.tsx`, `.../_lib/source-by-id.ts` — ID-keyed source render route.
- `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx`, `.../_views/source-view.tsx` — extracted render bodies shared by the merged dispatcher.

**Modify:**

- `packages/core/src/reserved-slugs.ts` — extend `NESTED_RESERVED`.
- `packages/api-types/src/api-types.ts` — re-export `ResolveResponseSchema`/`ResolveResponse`.
- `workers/api/src/routes/sources.ts` — extract `buildSourceDetailPayload`; export it.
- `workers/api/src/routes/products.ts` — extract `buildProductDetailPayload`; add the resolve route; add the shadow-guard warning.
- `web/src/lib/api.ts` — add `resolve(...)` and `sourceById(...)` client methods.
- `web/src/lib/links.ts` — flip `productPath`; add `sourceIdPath`.
- `web/src/lib/links.test.ts` — update/extend.
- `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` — becomes a `permanentRedirect`.
- `web/src/app/[orgSlug]/[sourceSlug]/*` → moved/renamed under `web/src/app/[orgSlug]/[slug]/*`.
- `web/src/app/sitemap.ts` — products → bare; shadowed sources → `/sources/:id`.

---

## Phase 1 — Dark infrastructure (PR 1)

### Task 1: Extend the reserved nested-slug set

**Files:**

- Modify: `packages/core/src/reserved-slugs.ts:286-291`
- Test: `packages/core/src/reserved-slugs.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/reserved-slugs.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { isReservedSlug } from "./reserved-slugs";

describe("isReservedSlug nested scope — product-first additions", () => {
  it("reserves the static second-segment routes that bare = product introduces", () => {
    for (const slug of ["product", "products", "playbook", "fetch-log"]) {
      expect(isReservedSlug(slug, "nested")).toBe(true);
    }
  });

  it("still reserves the pre-existing org/source sub-tabs", () => {
    for (const slug of ["releases", "sources", "highlights", "changelog"]) {
      expect(isReservedSlug(slug, "nested")).toBe(true);
    }
  });

  it("does not reserve an ordinary product slug", () => {
    expect(isReservedSlug("next-js", "nested")).toBe(false);
    expect(isReservedSlug("turborepo", "nested")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isReservedSlug("Playbook", "nested")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/reserved-slugs.test.ts`
Expected: FAIL — `product`/`products`/`playbook`/`fetch-log` return `false`.

- [ ] **Step 3: Add the four slugs to `NESTED_RESERVED`**

In `packages/core/src/reserved-slugs.ts`, in the `NESTED_RESERVED` array, after the `"changelog"` line (291) add:

```ts
  // Static second-segment routes that bare `/{org}/{slug}` = product introduces
  // (#1190). `product` is the redirect prefix; `playbook`/`fetch-log` are org
  // tabs; `products` is defensive. A product/source slug matching any would be
  // shadowed by the static route.
  "product",
  "products",
  "playbook",
  "fetch-log",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/reserved-slugs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/reserved-slugs.ts packages/core/src/reserved-slugs.test.ts
git commit -m "feat(core): reserve product/products/playbook/fetch-log nested slugs (#1190)"
```

---

### Task 2: `ResolveResponse` wire schema

**Files:**

- Create: `packages/api-types/src/schemas/resolve.ts`
- Modify: `packages/api-types/src/api-types.ts`

- [ ] **Step 1: Create the schema**

Create `packages/api-types/src/schemas/resolve.ts`:

```ts
import { z } from "zod";
import { ProductDetailSchema } from "./products.js";
import { SourceDetailSchema } from "./sources.js";

/**
 * Response of `GET /v1/orgs/:org/resolve/:slug` (#1190). Product-first: when a
 * product and a source share a slug in an org, the product variant is returned.
 * A 404 (ErrorResponse) is returned when neither matches.
 */
export const ResolveResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product"), product: ProductDetailSchema }),
  z.object({ kind: z.literal("source"), source: SourceDetailSchema }),
]);

export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;
```

- [ ] **Step 2: Re-export from the package entry**

In `packages/api-types/src/api-types.ts`, add an export block (next to the other `export { ... } from "./schemas/..."` lines):

```ts
export { ResolveResponseSchema } from "./schemas/resolve.js";
export type { ResolveResponse } from "./schemas/resolve.js";
```

- [ ] **Step 3: Type-check**

Run: `cd packages/api-types && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add packages/api-types/src/schemas/resolve.ts packages/api-types/src/api-types.ts
git commit -m "feat(api-types): ResolveResponse discriminated union (#1190)"
```

---

### Task 3: Extract `buildProductDetailPayload`

**Files:**

- Modify: `workers/api/src/routes/products.ts:358-397`

This is a pure refactor — behavior must not change. The existing product-detail tests are the guard.

- [ ] **Step 1: Run the existing product-detail tests (baseline green)**

Run: `bun test tests/api/ -t "product"` (or the specific product-detail test file).
Expected: PASS. Record the count.

- [ ] **Step 2: Extract the builder**

In `workers/api/src/routes/products.ts`, add an exported function that contains the body of `getProductDetailHandler` _after_ the `resolveProductFromContext` + 404 guard:

```ts
export async function buildProductDetailPayload(
  db: ReturnType<typeof createDb>,
  product: typeof products.$inferSelect,
) {
  const [productSources, tagRows, aliasRows] = await Promise.all([
    db
      .select({
        id: sourcesActive.id,
        slug: sourcesActive.slug,
        name: sourcesActive.name,
        type: sourcesActive.type,
        url: sourcesActive.url,
        metadata: sourcesActive.metadata,
        kind: sourcesActive.kind,
      })
      .from(sourcesActive)
      .where(eq(sourcesActive.productId, product.id))
      .orderBy(sourcesActive.name),
    db
      .select({ name: tags.name })
      .from(productTags)
      .innerJoin(tags, eq(productTags.tagId, tags.id))
      .where(eq(productTags.productId, product.id))
      .orderBy(tags.name),
    db
      .select({ domain: domainAliases.domain })
      .from(domainAliases)
      .where(eq(domainAliases.productId, product.id))
      .orderBy(domainAliases.domain),
  ]);

  return {
    ...product,
    sources: productSources,
    tags: tagRows.map((t) => t.name),
    aliases: aliasRows.map((a) => a.domain),
  };
}
```

Then replace the handler body so it delegates:

```ts
const getProductDetailHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);
  return c.json(await buildProductDetailPayload(db, product));
};
```

- [ ] **Step 3: Re-run the product-detail tests**

Run: `bun test tests/api/ -t "product"`
Expected: PASS — same count as Step 1 (refactor preserved behavior).

- [ ] **Step 4: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/products.ts
git commit -m "refactor(api): extract buildProductDetailPayload (#1190)"
```

---

### Task 4: Extract `buildSourceDetailPayload`

**Files:**

- Modify: `workers/api/src/routes/sources.ts:1846-2074`

Pure refactor. The existing source-detail tests are the guard. The wrapper keeps query parsing, the 404, and the `text/markdown` content negotiation; only the JSON-payload construction moves.

- [ ] **Step 1: Run existing source-detail tests (baseline green)**

Run: `bun test tests/api/ -t "source"`
Expected: PASS. Record the count.

- [ ] **Step 2: Extract the builder**

In `workers/api/src/routes/sources.ts`, define an exported function whose body is everything in `getSourceDetailHandler` between the `if (!src) return …404` guard and the final `return c.json(...)` (i.e. all the parallel queries + payload assembly). Signature:

```ts
export interface SourceDetailOpts {
  cursor: string | null;
  limit: number;
  includeCoverage: boolean;
  includePrereleases: boolean;
}

export async function buildSourceDetailPayload(
  db: ReturnType<typeof createDb>,
  src: typeof sources.$inferSelect,
  opts: SourceDetailOpts,
) {
  // ← move the body of getSourceDetailHandler here (the part that builds the
  //   JSON object: releases query, pagination, summaries, counts, org ref,
  //   productSlug, etc.). It must return the same object shape the handler
  //   currently passes to c.json(...).
}
```

Rewrite the wrapper to parse query → resolve → delegate, preserving the markdown branch exactly as it is today:

```ts
const getSourceDetailHandler = async (c: import("hono").Context<Env>) => {
  const opts: SourceDetailOpts = {
    cursor: c.req.query("cursor") ?? null,
    limit: parseLimitParam(c.req.query("limit"), 20, 100),
    includeCoverage: parseBoolParam(c.req.query("include_coverage")),
    includePrereleases: parseBoolParam(c.req.query("include_prereleases")),
  };
  const db = createDb(c.env.DB);
  const src = await resolveSourceFromContext(c, db);
  if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

  const payload = await buildSourceDetailPayload(db, src, opts);
  // …keep the existing Accept: text/markdown negotiation branch here, operating
  //   on `payload` exactly as the current handler does…
  return c.json(payload);
};
```

> Mechanical move — do not change query names, COALESCE logic, or the markdown branch. If the markdown branch reads intermediate values that aren't on the JSON payload, return them from the builder too (extend the return object) rather than recomputing.

- [ ] **Step 3: Re-run source-detail tests**

Run: `bun test tests/api/ -t "source"`
Expected: PASS — same count as Step 1.

- [ ] **Step 4: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "refactor(api): extract buildSourceDetailPayload (#1190)"
```

---

### Task 5: `GET /v1/orgs/:org/resolve/:slug` endpoint

**Files:**

- Modify: `workers/api/src/routes/products.ts` (add route; it already owns `/orgs/...products` and imports the helpers)
- Test: `tests/api/orgs-resolve.test.ts` (create)

> Registered on `productRoutes` because it already imports `findProductForOrgSlug`, `buildProductDetailPayload`, and the product schemas. Import `findSourceForOrgSlug` + `buildSourceDetailPayload` from sources. The `/orgs/` prefix is already in `publicReadRoutes` — no `route-namespaces.ts` change.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/orgs-resolve.test.ts`:

```ts
import { beforeEach, afterEach, describe, it, expect } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { productRoutes } from "../../workers/api/src/routes/products.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.cleanup();
});
const makeEnv = () => ({ DB: testDb.db as unknown as never });
const call = makeCaller(productRoutes, makeEnv);

async function seed() {
  await testDb.db.insert(organizations).values({
    id: "org_vercel",
    name: "Vercel",
    slug: "vercel",
    discovery: "curated",
  });
  await testDb.db.insert(products).values({
    id: "prod_turbo",
    name: "Turborepo",
    slug: "turborepo",
    orgId: "org_vercel",
    kind: "tool",
  });
  // Shadowed source: same slug as the product, in the same org.
  await testDb.db.insert(sources).values({
    id: "src_turbo",
    name: "Turborepo repo",
    slug: "turborepo",
    orgId: "org_vercel",
    productId: "prod_turbo",
    type: "github",
    url: "https://github.com/vercel/turborepo",
    metadata: "{}",
  });
  // Orphan source with a unique slug.
  await testDb.db.insert(sources).values({
    id: "src_docs",
    name: "Vercel Docs",
    slug: "vercel-docs",
    orgId: "org_vercel",
    type: "scrape",
    url: "https://vercel.com/docs",
    metadata: "{}",
  });
}

describe("GET /v1/orgs/:org/resolve/:slug", () => {
  it("returns kind=product when a product owns the slug (product-first, even on collision)", async () => {
    await seed();
    const res = await call("/orgs/vercel/resolve/turborepo");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("product");
    expect(body.product.slug).toBe("turborepo");
  });

  it("returns kind=source for a non-shadowed source slug", async () => {
    await seed();
    const res = await call("/orgs/vercel/resolve/vercel-docs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("source");
    expect(body.source.slug).toBe("vercel-docs");
  });

  it("404s when neither a product nor a source matches", async () => {
    await seed();
    const res = await call("/orgs/vercel/resolve/nope");
    expect(res.status).toBe(404);
  });

  it("404s for an unknown org", async () => {
    await seed();
    const res = await call("/orgs/ghost/resolve/turborepo");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/api/orgs-resolve.test.ts`
Expected: FAIL — route not registered (404 for the product case, or route-not-found).

- [ ] **Step 3: Implement the route**

In `workers/api/src/routes/products.ts`:

Add imports near the top:

```ts
import { findProductForOrgSlug, findSourceForOrgSlug } from "../utils.js";
import { buildSourceDetailPayload } from "./sources.js";
import { ResolveResponseSchema } from "@buildinternet/releases-api-types";
```

Add the handler + described route + registration (after the product-detail registration block ~line 424):

```ts
const resolveRoute = describeRoute({
  tags: ["Orgs"],
  summary: "Resolve an org-scoped slug to a product or source",
  description:
    'Product-first: returns `{ kind: "product", product }` when a product owns the slug, else `{ kind: "source", source }` for a source, else 404. One round trip for the bare `/[org]/[slug]` web route (#1190).',
  responses: {
    200: {
      description: "Discriminated product or source detail",
      content: { "application/json": { schema: resolver(ResolveResponseSchema) } },
    },
    404: {
      description: "Neither a product nor a source matched",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});

const resolveHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const org = c.req.param("org");
  const slug = c.req.param("slug");
  if (!org || !slug) return c.json({ error: "bad_request", message: "org and slug required" }, 400);

  const product = await findProductForOrgSlug(db, org, slug);
  if (product) {
    return c.json({ kind: "product", product: await buildProductDetailPayload(db, product) });
  }
  const src = await findSourceForOrgSlug(db, org, slug);
  if (src) {
    return c.json({
      kind: "source",
      source: await buildSourceDetailPayload(db, src, {
        cursor: null,
        limit: 20,
        includeCoverage: false,
        includePrereleases: false,
      }),
    });
  }
  return c.json({ error: "not_found", message: "No product or source for that slug" }, 404);
};

productRoutes.get("/orgs/:org/resolve/:slug", resolveRoute, resolveHandler);
```

> If `ErrorResponseSchema` / `Env` aren't already imported in this file, add them (they are used by the existing product routes, so they should be present).
>
> `products.ts` importing `buildSourceDetailPayload` from `sources.ts` is request-time only (called inside the handler, not at module top level), so even if a `sources ↔ products` import cycle exists it resolves fine. `tsc`/`build` will flag a genuine problem; if one appears, move the resolve route to `orgs.ts` (which imports both builders one-directionally) and import `orgRoutes` in the test instead.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/api/orgs-resolve.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify OpenAPI coverage gate passes**

Run: `bun run scripts/check-openapi-coverage.ts`
Expected: PASS — `GET /orgs/:org/resolve/:slug` is documented via `describeRoute`. If it reports a hole, the annotation isn't wired to the route; fix the registration order so `resolveRoute` precedes `resolveHandler`.

- [ ] **Step 6: Type-check + commit**

Run: `cd workers/api && npx tsc --noEmit` → PASS

```bash
git add workers/api/src/routes/products.ts tests/api/orgs-resolve.test.ts
git commit -m "feat(api): product-first resolve endpoint (#1190)"
```

---

### Task 6: Shadow-guard warning on product create

**Files:**

- Modify: `workers/api/src/routes/products.ts` (the `POST /v1/products` handler, before each `db.insert(products)`)
- Test: `tests/api/orgs-resolve.test.ts` (extend) or a new `tests/api/product-shadow-guard.test.ts`

> Warn-but-allow: shadowing is the _intended_ wrap mechanism. We log it and surface a non-blocking `warning` on the 201 body; we never block.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/orgs-resolve.test.ts` (it already imports `productRoutes`; add a json caller):

```ts
import { makeJsonCaller } from "./route-test-helpers.js";
// ...
const callJson = makeJsonCaller(productRoutes, makeEnv);

describe("POST /v1/products shadow guard", () => {
  it("warns but still creates when the new product slug shadows an existing source", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_acme",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await testDb.db.insert(sources).values({
      id: "src_cli",
      name: "Acme CLI",
      slug: "acme-cli",
      orgId: "org_acme",
      type: "github",
      url: "https://github.com/acme/cli",
      metadata: "{}",
    });
    const res = await callJson("/products", "POST", {
      name: "Acme CLI",
      slug: "acme-cli",
      orgSlug: "acme",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe("acme-cli");
    expect(body.warning).toContain("shadow");
  });

  it("omits the warning when there is no shadowed source", async () => {
    await testDb.db.insert(organizations).values({
      id: "org_beta",
      name: "Beta",
      slug: "beta",
      discovery: "curated",
    });
    const res = await callJson("/products", "POST", {
      name: "Beta SDK",
      slug: "beta-sdk",
      orgSlug: "beta",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warning).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/api/orgs-resolve.test.ts -t "shadow guard"`
Expected: FAIL — no `warning` field on the 201 body.

- [ ] **Step 3: Implement the guard**

In `workers/api/src/routes/products.ts`, add a helper near the top:

```ts
async function detectSourceSlugShadow(
  db: ReturnType<typeof createDb>,
  orgId: string,
  slug: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.orgId, orgId), eq(sources.slug, slug)))
    .limit(1);
  return Boolean(row);
}
```

In the `POST` handler, immediately before **each** `db.insert(products)` call (there are two slug-derivation branches — lines ~250 and ~495), after the `isReservedSlug` check, compute the warning and thread it into the success response:

```ts
const shadowed = await detectSourceSlugShadow(db, org.id, slug);
if (shadowed) {
  logEvent("warn", {
    component: "products",
    event: "slug-shadows-source",
    orgId: org.id,
    slug,
  });
}
// ...after a successful insert:
return c.json(
  shadowed
    ? {
        ...created,
        warning: `Product slug "${slug}" shadows an existing source in this org; the product will win the bare URL.`,
      }
    : created,
  201,
);
```

> Use the org-id variable that's in scope at each branch (`org.id` or `sourceOrg.id`). Keep `warning` off the response when not shadowed so the schema stays additive.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/api/orgs-resolve.test.ts -t "shadow guard"`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check + commit**

Run: `cd workers/api && npx tsc --noEmit` → PASS

```bash
git add workers/api/src/routes/products.ts tests/api/orgs-resolve.test.ts
git commit -m "feat(api): warn when a product slug shadows a source (#1190)"
```

---

### Task 7: Web API client — `resolve` and `sourceById`

**Files:**

- Modify: `web/src/lib/api.ts` (near `productDetail` ~line 430 and `sourceDetail` ~line 347)

- [ ] **Step 1: Add the client methods**

Add the import for the type at the top of `web/src/lib/api.ts` (alongside the other `@buildinternet/releases-api-types` imports):

```ts
import type { ResolveResponse } from "@buildinternet/releases-api-types";
```

Add the methods to the `api` object:

```ts
  resolve: (ref: { orgSlug: string; slug: string }) =>
    fetchApi<ResolveResponse>(`/v1/orgs/${ref.orgSlug}/resolve/${ref.slug}`),

  sourceById: (
    id: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.cursor != null) params.set("cursor", opts.cursor);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return fetchApi<SourceDetail>(`/v1/sources/${id}${qs ? `?${qs}` : ""}`);
  },
```

> `/v1/sources/:id` accepts a typed `src_…` ID on the bare path (`BareSlugRejected` only fires for non-ID bare slugs), so `sourceById` needs no new API endpoint.

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. (`ResolveResponse` and `SourceDetail` resolve from the workspace package.)

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(web): api.resolve + api.sourceById client methods (#1190)"
```

---

### Task 8: `/sources/[id]` render route (dark — nothing links here yet)

**Files:**

- Create: `web/src/app/sources/[id]/_lib/source-by-id.ts`
- Create: `web/src/app/sources/[id]/page.tsx`
- Create: `web/src/app/sources/[id]/changelog/page.tsx`
- Create: `web/src/app/sources/[id]/highlights/page.tsx`
- Create: `web/src/app/sources/[id]/layout.tsx`

> Reuses the same render components the existing source route uses (`SourceReleaseList`, the changelog/highlights bodies). The data fetch differs only in keying by ID. For an **orphan** source, 308 to its bare canonical home; for a **member** source, render here.

- [ ] **Step 1: Create the cached fetch**

`web/src/app/sources/[id]/_lib/source-by-id.ts`:

```ts
import { cache } from "react";
import { api } from "@/lib/api";

export const getSourceById = cache((id: string) => api.sourceById(id));
```

- [ ] **Step 2: Create the page**

`web/src/app/sources/[id]/page.tsx` — mirror `web/src/app/[orgSlug]/[sourceSlug]/page.tsx`'s render, but fetch by ID and redirect orphans to their bare home:

```tsx
import { notFound, permanentRedirect } from "next/navigation";
import { ApiNotFoundError } from "@/lib/api";
import { SourceReleaseList } from "@/components/source-release-list";
import { getSourceById } from "./_lib/source-by-id";

export default async function SourceByIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let source;
  try {
    source = await getSourceById(id);
  } catch (e) {
    if (e instanceof ApiNotFoundError) notFound();
    throw e;
  }
  // Orphan sources keep their bare human URL as canonical.
  if (source.org && !source.productId) {
    permanentRedirect(`/${source.org.slug}/${source.slug}`);
  }
  return <SourceReleaseList source={source} />;
}
```

> Match the prop shape `SourceReleaseList` actually expects — open `web/src/app/[orgSlug]/[sourceSlug]/page.tsx:150-162` and copy the exact props/wrappers it passes (RelatedRail, JsonLd, Suspense). Keep them identical.

- [ ] **Step 3: Create the layout (canonical + sub-tab chrome)**

`web/src/app/sources/[id]/layout.tsx` — mirror `[orgSlug]/[sourceSlug]/layout.tsx` (the tabs chrome) but key by ID; emit `<link rel="canonical">` to `/sources/${id}` for member sources, and to the bare URL for orphans. Replace the `getSource(orgSlug, sourceSlug)` call with `getSourceById(id)` and the tab hrefs with `/sources/${id}`, `/sources/${id}/changelog`, `/sources/${id}/highlights`.

> **DRY:** the source tab-chrome will be needed by both this route and the merged `[orgSlug]/[slug]` layout (Task 11). Extract the chrome (the tab-bar JSX that takes a `base` path + `hasChangelog`/`hasHighlights` flags) into a shared component, e.g. `web/src/components/source-tabs.tsx`, and have both layouts render it with their respective `base`. Do this extraction here so Task 11 reuses it rather than copying.

- [ ] **Step 4: Create changelog + highlights sub-pages**

`web/src/app/sources/[id]/changelog/page.tsx` and `.../highlights/page.tsx` — copy the bodies of the existing `[orgSlug]/[sourceSlug]/changelog/page.tsx` and `.../highlights/page.tsx`, swapping `getSource(orgSlug, sourceSlug)` → `getSourceById(id)` and `params` to `{ id: string }`. Keep the `notFound()`-when-no-content guards.

- [ ] **Step 5: Verify it builds and renders**

Run: `cd web && npx tsc --noEmit` → PASS
Run: `cd web && npm run build` (or `bun run build`) → the route `/sources/[id]` compiles with no type errors.
Manual: with dev running, hit `/sources/src_<a-known-member-source-id>` → renders; `/sources/src_<an-orphan-id>` → 308 to its bare URL. (Pick IDs from prod data or a local seed.)

- [ ] **Step 6: Commit**

```bash
git add web/src/app/sources
git commit -m "feat(web): ID-keyed /sources/:id render route (#1190)"
```

---

> **PR 1 boundary.** Run the full gate (`npx tsc --noEmit` ×3, `bun run lint`, `bun test`, `bun run scripts/check-openapi-coverage.ts`). Everything above is dark: no rendered URL changed. Open PR 1, let it deploy and bake.

---

## Phase 2 — Cutover (PR 2)

### Task 9: Flip the `links.ts` seam

**Files:**

- Modify: `web/src/lib/links.ts:15-17` (`productPath`)
- Modify: `web/src/lib/links.ts` (add `sourceIdPath`)
- Test: `web/src/lib/links.test.ts`

- [ ] **Step 1: Update the tests first**

In `web/src/lib/links.test.ts`, change the `productPath` expectations to the bare form and add `sourceIdPath`:

```ts
import { describe, it, expect } from "bun:test";
import { productPath, sourcePath, sourceOrProductPath, sourceIdPath } from "./links";

describe("productPath (bare, post-flip)", () => {
  it("emits the bare org-scoped path", () => {
    expect(productPath("vercel", "next-js")).toBe("/vercel/next-js");
  });
  it("falls back to /product/:slug when org is unknown", () => {
    expect(productPath(null, "next-js")).toBe("/product/next-js");
  });
});

describe("sourceIdPath", () => {
  it("builds the ID-keyed source path", () => {
    expect(sourceIdPath("src_abc123")).toBe("/sources/src_abc123");
  });
});

describe("sourceOrProductPath", () => {
  it("prefers the product (now bare) when productSlug is set", () => {
    expect(
      sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "next-js", productSlug: "next-js" }),
    ).toBe("/vercel/next-js");
  });
  it("uses the source path when there is no product", () => {
    expect(sourceOrProductPath({ orgSlug: "vercel", sourceSlug: "vercel-docs" })).toBe(
      "/vercel/vercel-docs",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test web/src/lib/links.test.ts`
Expected: FAIL — `productPath("vercel","next-js")` still returns `/vercel/product/next-js`; `sourceIdPath` undefined.

- [ ] **Step 3: Implement**

In `web/src/lib/links.ts`, change `productPath` and add `sourceIdPath`:

```ts
export function productPath(orgSlug: string | null, productSlug: string): string {
  return orgSlug ? `/${orgSlug}/${productSlug}` : `/product/${productSlug}`;
}

/** ID-keyed source page. The stable home for product-member / shadowed sources. */
export function sourceIdPath(sourceId: string): string {
  return `/sources/${sourceId}`;
}
```

Update the module doc comment: the flip described in it has now happened.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test web/src/lib/links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/links.ts web/src/lib/links.test.ts
git commit -m "feat(web): flip productPath to bare /[org]/[slug]; add sourceIdPath (#1190)"
```

---

### Task 10: Extract the product and source render bodies into shared views

**Files:**

- Create: `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx`
- Create: `web/src/app/[orgSlug]/[slug]/_views/source-view.tsx`

> Prep for the merge: the product page body must move out of `product/[productSlug]/` (which becomes a redirect) and the source page body out of `[sourceSlug]/`. Each view is a server component taking the already-resolved detail object so the dispatcher fetches once.

- [ ] **Step 1: Create `product-view.tsx`**

Move the JSX/logic from `web/src/app/[orgSlug]/product/[productSlug]/page.tsx`'s default export into:

```tsx
import type { ProductDetail } from "@buildinternet/releases-api-types";
// + the same imports the product page used

export async function ProductView({
  orgSlug,
  product,
}: {
  orgSlug: string;
  product: ProductDetail;
}) {
  // ← the product page's render body, minus the data fetch and the
  //   `org.products.length <= 1` collapse (that moves to the dispatcher).
  //   Change the "Available on" app-chip href from `/${orgSlug}/${e.slug}`
  //   to sourceIdPath(s.id) — see Task 11.
}
```

- [ ] **Step 2: Create `source-view.tsx`**

Move the render body from `web/src/app/[orgSlug]/[sourceSlug]/page.tsx` into:

```tsx
import type { SourceDetail } from "@buildinternet/releases-api-types";

export async function SourceView({ orgSlug, source }: { orgSlug: string; source: SourceDetail }) {
  // ← the source page's render body (SourceReleaseList + RelatedRails + JsonLd),
  //   taking the resolved `source` instead of fetching.
}
```

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/[orgSlug]/[slug]/_views
git commit -m "refactor(web): extract ProductView and SourceView (#1190)"
```

---

### Task 11: The merged `[orgSlug]/[slug]` dispatcher + sub-tabs

**Files:**

- Create: `web/src/app/[orgSlug]/[slug]/page.tsx`, `.../layout.tsx`, `.../error.tsx`, `.../opengraph-image.tsx`, `.../_lib/resolve.ts`
- Move: `web/src/app/[orgSlug]/[sourceSlug]/changelog/` and `.../highlights/` → `web/src/app/[orgSlug]/[slug]/`
- Delete: `web/src/app/[orgSlug]/[sourceSlug]/` (after moving sub-tabs)
- Modify: `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` → redirect

> The single fiddliest task. The dispatcher resolves once (cached); the layout reuses the cached resolve to choose chrome; the changelog/highlights sub-tabs keep fetching the **source** directly (so product-only slugs `notFound()` and collision slugs still show the real source changelog).

- [ ] **Step 1: Cached resolve helper**

`web/src/app/[orgSlug]/[slug]/_lib/resolve.ts`:

```ts
import { cache } from "react";
import { api } from "@/lib/api";

export const getResolved = cache((orgSlug: string, slug: string) => api.resolve({ orgSlug, slug }));
```

- [ ] **Step 2: Dispatcher page**

`web/src/app/[orgSlug]/[slug]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ApiNotFoundError } from "@/lib/api";
import { getOrg } from "../_lib/org-data";
import { getResolved } from "./_lib/resolve";
import { ProductView } from "./_views/product-view";
import { SourceView } from "./_views/source-view";

export default async function OrgSlugPage({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}) {
  const { orgSlug, slug } = await params;
  let resolved;
  try {
    resolved = await getResolved(orgSlug, slug);
  } catch (e) {
    if (e instanceof ApiNotFoundError) notFound();
    throw e;
  }

  if (resolved.kind === "product") {
    // Preserve the single-product collapse the old product page had.
    const org = await getOrg(orgSlug);
    if (org.products.length <= 1) permanentRedirect(`/${orgSlug}`);
    return <ProductView orgSlug={orgSlug} product={resolved.product} />;
  }
  return <SourceView orgSlug={orgSlug} source={resolved.source} />;
}

export async function generateMetadata({ params }): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  try {
    const resolved = await getResolved(orgSlug, slug);
    // delegate to the product/source metadata builders the old pages used,
    // branching on resolved.kind. Copy those builders' logic here.
    return resolved.kind === "product"
      ? productMetadata(orgSlug, resolved.product)
      : sourceMetadata(orgSlug, resolved.source);
  } catch {
    return {};
  }
}
```

> Port the two `generateMetadata` implementations from the old product and source pages into `productMetadata` / `sourceMetadata` helpers (same file or `_views`). Don't invent new metadata — copy verbatim, adapting to take the resolved object.

- [ ] **Step 3: Kind-aware layout**

`web/src/app/[orgSlug]/[slug]/layout.tsx` — start from `[orgSlug]/[sourceSlug]/layout.tsx`. Resolve via `getResolved` (cached — no extra fetch). If `kind === "source"`, render the existing source tab-chrome around `children` (with tab hrefs `/${orgSlug}/${slug}`, `/${orgSlug}/${slug}/changelog`, `/${orgSlug}/${slug}/highlights`). If `kind === "product"`, render `children` bare (products carry their own chrome in `ProductView`). Drop the old `source.org.slug !== orgSlug` correction (the resolver is already org-scoped); keep a `notFound()` on `ApiNotFoundError`.

- [ ] **Step 4: Move the sub-tabs**

```bash
git mv web/src/app/[orgSlug]/[sourceSlug]/changelog web/src/app/[orgSlug]/[slug]/changelog
git mv web/src/app/[orgSlug]/[sourceSlug]/highlights web/src/app/[orgSlug]/[slug]/highlights
```

In both moved `page.tsx` files, change `params` to `{ orgSlug: string; slug: string }` and the fetch from `getSource(orgSlug, sourceSlug)` to a source-scoped fetch keyed on `slug`. Add a co-located `_lib/source-data.ts` under `[slug]/` (copy the old `_lib/source-data.ts`) so `getSource(orgSlug, slug)` still works. These sub-routes resolve the **source** only — a product-only slug throws `ApiNotFoundError` → `notFound()` (products have no changelog), and a collision slug renders the real shadowed source's changelog (acceptable).

- [ ] **Step 5: Move error + opengraph-image; delete the old segment**

```bash
git mv web/src/app/[orgSlug]/[sourceSlug]/error.tsx web/src/app/[orgSlug]/[slug]/error.tsx
git mv web/src/app/[orgSlug]/[sourceSlug]/opengraph-image.tsx web/src/app/[orgSlug]/[slug]/opengraph-image.tsx
```

Update `opengraph-image.tsx` to resolve by kind (it currently calls `api.sourceDetail`; make it branch via `getResolved` and render the product or source OG image — reuse the product OG logic from `product/[productSlug]/opengraph-image.tsx`). Then remove the now-empty old directory:

```bash
git rm -r web/src/app/[orgSlug]/[sourceSlug]
```

- [ ] **Step 6: Convert the product prefix to a permanent redirect**

Replace `web/src/app/[orgSlug]/product/[productSlug]/page.tsx` entirely:

```tsx
import { permanentRedirect } from "next/navigation";

export default async function LegacyProductRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}) {
  const { orgSlug, productSlug } = await params;
  permanentRedirect(`/${orgSlug}/${productSlug}`);
}
```

Delete `web/src/app/[orgSlug]/product/[productSlug]/opengraph-image.tsx` and `.../error.tsx` (the bare route now owns rendering); keep only the redirect `page.tsx`.

- [ ] **Step 7: Verify build + routes**

Run: `cd web && npx tsc --noEmit` → PASS
Run: `cd web && bun run build` → no route conflicts; `[orgSlug]/[slug]` compiles.
Manual (dev): `/vercel/turborepo` → product; `/vercel/vercel-docs` (orphan) → source; `/vercel/product/turborepo` → 308 → `/vercel/turborepo`; `/<org>/<bad>` → 404; `/<org>/<source>/changelog` → source changelog; `/<org>/<product-only-slug>/changelog` → 404.

- [ ] **Step 8: Commit**

```bash
git add web/src/app/[orgSlug]
git commit -m "feat(web): merge [orgSlug]/[slug] dispatcher; product/ → 308 (#1190)"
```

---

### Task 12: Repoint product-page source links to `/sources/:id`

**Files:**

- Modify: `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx` (the "Available on" app chips)

- [ ] **Step 1: Change the chip href**

In `ProductView`, the "Available on" chips currently link to `/${orgSlug}/${e.slug}`. After the flip, a shadowed app-source slug would 308 back to the product (self-loop). Change to the ID route. Update the `appEntries` map to carry `id`, and the chip:

```tsx
const appEntries = product.sources
  .map((s) => { const app = getAppInfo(s); return app ? { id: s.id, slug: s.slug, name: s.name, app } : null; })
  .filter((e): e is { id: string; slug: string; name: string; app: AppInfo } => e !== null);
// ...
<Link key={e.slug} href={sourceIdPath(e.id)} /* ...unchanged classes... */>
```

Import `sourceIdPath` from `@/lib/links`. (`ProductDetailSourceSchema` includes `id`.)

- [ ] **Step 2: Type-check + manual check**

Run: `cd web && npx tsc --noEmit` → PASS
Manual: on a multi-product org with app sources, the "Available on" chips navigate to `/sources/:id` and render, not loop.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/[orgSlug]/[slug]/_views/product-view.tsx
git commit -m "feat(web): product-page source chips link to /sources/:id (#1190)"
```

---

### Task 13: Sitemap canonicalization

**Files:**

- Modify: `web/src/app/sitemap.ts:91` (products) and `:101` (sources)

> Products → bare; shadowed sources → `/sources/:id`. The sitemap payload (`api.sitemap()`) returns products with `{ orgSlug, slug }` and sources with `{ orgSlug, slug, ... }`. "Shadowed" = a product in the same org shares the slug; compute it client-side from the two arrays (no API change).

- [ ] **Step 1: Implement**

In `web/src/app/sitemap.ts`, after fetching `data = await api.sitemap()`:

```ts
// Build the set of "orgSlug/slug" owned by a product (these are bare-product URLs).
const productKeys = new Set(data.products.map((p) => `${p.orgSlug}/${p.slug}`));

// Products → bare /[org]/[slug] (was /[org]/product/[slug]).
const productUrls = data.products.map((p) => ({
  url: `${BASE}/${p.orgSlug}/${p.slug}`,
  // ...keep the existing changeFrequency/priority fields...
}));

// Sources: shadowed ones move to /sources/:id; the rest keep their bare URL.
const sourceUrls = data.sources.flatMap((s) => {
  const shadowed = productKeys.has(`${s.orgSlug}/${s.slug}`);
  const base = shadowed ? `${BASE}/sources/${s.id}` : `${BASE}/${s.orgSlug}/${s.slug}`;
  const urls = [{ url: base /* ...existing fields... */ }];
  if (!shadowed && s.hasChangelog) urls.push({ url: `${base}/changelog` /* ... */ });
  if (!shadowed && s.hasHighlights) urls.push({ url: `${base}/highlights` /* ... */ });
  return urls;
});
```

> The sitemap API payload must include the source `id`. Check `workers/api/src/routes/sitemap.ts`'s sources SELECT — if `id` isn't already returned, add `id: sourcesActive.id` to the select and to the `SitemapResponse` source shape in `@buildinternet/releases-api-types` (additive). If `id` is already present, no API change.

- [ ] **Step 2: Verify**

Run: `cd web && npx tsc --noEmit` → PASS
Manual: `curl localhost:<port>/sitemap.xml` → product URLs are bare; a known shadowed source appears as `/sources/src_…`; orphan sources keep bare URLs + sub-tab entries.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/sitemap.ts workers/api/src/routes/sitemap.ts packages/api-types/src/schemas
git commit -m "feat(web): canonicalize sitemap to bare product URLs; shadowed sources to /sources/:id (#1190)"
```

---

### Task 14: Final verification + docs

- [ ] **Step 1: Full gate**

Run each, expect PASS:

```bash
npx tsc --noEmit                                  # root
( cd web && npx tsc --noEmit )
( cd workers/api && npx tsc --noEmit )
bun run lint
bun test
bun run scripts/check-openapi-coverage.ts
( cd web && bun run build )
```

- [ ] **Step 2: Manual smoke of the resolution matrix**

With dev running (or against a branch deploy), confirm each row of the spec's resolution matrix:

- `/[org]/[product-slug]` → product page
- `/[org]/[orphan-source-slug]` → source page
- `/[org]/[shadowed-source-slug]` → product page (collision resolves to product)
- `/[org]/[bad]` → 404
- `/[org]/product/[slug]` → 308 → `/[org]/[slug]`
- `/sources/[member-id]` → source page
- `/sources/[orphan-id]` → 308 → bare
- `/source/[slug]` → unchanged legacy 308

- [ ] **Step 3: Update architecture docs**

Add a short "Product-first URL resolution" note to `docs/architecture/web.md` (the routing section): the resolution matrix, the `links.ts` seam, and a pointer to this plan + the spec. Mention the deferred edges (shadowed-source changelog chunk deep-links and `/[org]/[productSlug]/changelog` 404) and the committed sources-by-ID destination via #1194.

```bash
git add docs/architecture/web.md
git commit -m "docs: product-first URL resolution routing (#1190)"
```

---

## Deferred from the spec (deliberate trims — record in the PR description)

- **Changelog _chunk_ deep-link rerouting.** The spec's Unit 4 branches `chunkDeepLink` to `/sources/:id/changelog` for member sources. That needs a `sourceId` on the search chunk hit (a search-query-layer + wire change). It affects only the ~11 shadowed sources that have a changelog file, and is the sibling of the `/[org]/[productSlug]/changelog` 404 the spec already defers. **Left as-is** (chunk deep-links stay on the bare `sourcePath`); the fix rides with the product-scoped-views follow-up (#1191-adjacent). No regression for orphan or non-shadowed sources.
- **Single-source product surfacing its source's changelog/highlights.** Same follow-up.
- **MCP search `productSlug`/`sourceId` parity.** #1195.

## Self-review notes

- **Spec coverage:** resolver (T5), route merge (T10–11), `/sources/:id` (T8), `links.ts` seam (T9), `/product/` 308 (T11), reserved set (T1), shadow guard (T6), sitemap (T13), canonical tags (T8), testing (throughout), forward-compat (docs T14). The two changelog edges are explicitly deferred above, consistent with the spec.
- **Type consistency:** `ResolveResponse` (T2) is consumed by `api.resolve` (T7) and `getResolved` (T11); `buildProductDetailPayload` (T3) / `buildSourceDetailPayload` (T4) feed the resolve handler (T5); `sourceIdPath` (T9) is used by T8/T11/T12; `sourceById` (T7) backs `/sources/:id` (T8).
- **No new schema/migration:** the only `packages/core` edit is a constant array, so the migration-pairing CI gate does not apply.
