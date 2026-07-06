# Self-Serve Listing Backend (`/v1/listing/*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public anonymous `POST /v1/listing/validate` + `POST /v1/listing/activate` routes — live releases.json validation with a purpose-built preview, and instant-stub activation with a request-tracking signal — per the spec at `docs/superpowers/specs/2026-07-06-stub-tier-phase2-self-serve-listing-design.md` (slice 1: backend + api-types; web and CLI are separate plans).

**Architecture:** New public route family in `workers/api/src/routes/listing.ts` sharing library internals with the admin stub path: `fetchReleasesJson` (SSRF/64KB/5s guards), `ReleasesJsonDomainSchema`, `classifyLocation()`, and `createStubFromManifest`. A new `validateListing()` lib builds the stable public projection (`ListingValidationResult` in api-types), independent of the internal materialization plan. New nullable `organizations.tracking_requested_at` column records owner demand. Anonymous access via a new `publicWriteRoutes` namespace bucket; abuse gates are two CF-native rate limiters (per-IP 10/min shared, per-domain 3/min on activate) and a `listing-self-serve-enabled` kill-switch flag.

**Tech Stack:** Bun, TypeScript strict, Hono, Drizzle + D1, zod (api-types), CF-native rate limiters, Flagship flags.

## Global Constraints

- Repo checks: `bun run check` must pass; run `bun test workers/api` and `bun test packages/api-types` (root-cwd) for touched suites.
- Every non-2xx response is the nested envelope `{ error: { code, type, message, details? } }` — `throw` a `ReleasesError` subclass (`@releases/lib/releases-error`) and let `respondError` serialize; never hand-roll `c.json({ error })`.
- Worker logging via `logEvent()` from `@releases/lib/log-event` only.
- `packages/core/src/schema.ts` edits REQUIRE a paired migration in `workers/api/migrations/` (CI gate). Migration filename pattern: `YYYYMMDDhhmmss_snake_case_name.sql` with a purpose comment header.
- api-types changes are additive only; `packages/api-types` is zod-home (core stays zod-free). Publish (version bump PR → CI OIDC) is out of scope for this plan — schemas land unpublished and ship with the next bump.
- D1 hard limit: 100 bound params/statement (not expected to bite here; no new batch inserts).
- New Flagship flag keys must be created in BOTH Flagship apps (`releases-platform{,-staging}`) — manual deploy step, listed in the final task.
- This repo is public: no PII, no real tokens, `@example.com` in fixtures.
- Commit after every green test cycle; commit messages follow `feat(listing): …` / `chore(listing): …` style, referencing #1947.

**Spec deviations locked in this plan (flagged to and accepted by the user):**
1. `publicReadRoutes` gates all writes behind auth, so the anonymous POSTs get a new third namespace bucket `publicWriteRoutes` in `route-namespaces.ts`.
2. Per-domain activate limit is **3/min via a CF-native limiter** (native limiters only support 10s/60s windows; activation is idempotent so a daily KV counter isn't warranted).

---

### Task 1: api-types — listing wire schemas

**Files:**
- Create: `packages/api-types/src/schemas/listing.ts`
- Modify: `packages/api-types/src/api-types.ts` (barrel re-export)
- Test: `packages/api-types/test/listing.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4, 6, 7): `ListingValidateBodySchema` / `ListingValidateBody` (`{ domain: string }`), `ListingActivateBodySchema` / `ListingActivateBody` (`{ domain: string; requestTracking?: boolean }`), `ListingLocationSchema` / `ListingLocation`, `ListingValidationResultSchema` / `ListingValidationResult`, `ListingActivateResultSchema` / `ListingActivateResult`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api-types/test/listing.test.ts
import { describe, it, expect } from "bun:test";
import {
  ListingValidateBodySchema,
  ListingActivateBodySchema,
  ListingValidationResultSchema,
  ListingActivateResultSchema,
} from "../src/api-types.js";

describe("listing schemas", () => {
  it("accepts a bare domain body and rejects extras", () => {
    expect(ListingValidateBodySchema.safeParse({ domain: "acme.com" }).success).toBe(true);
    expect(ListingValidateBodySchema.safeParse({ domain: "" }).success).toBe(false);
    expect(ListingValidateBodySchema.safeParse({ domain: "acme.com", x: 1 }).success).toBe(false);
  });

  it("activate body defaults requestTracking to undefined and stays strict", () => {
    const ok = ListingActivateBodySchema.safeParse({ domain: "acme.com" });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.requestTracking).toBeUndefined();
    expect(
      ListingActivateBodySchema.safeParse({ domain: "acme.com", requestTracking: true }).success,
    ).toBe(true);
  });

  it("validation result round-trips an unlisted preview", () => {
    const parsed = ListingValidationResultSchema.safeParse({
      valid: true,
      errors: [],
      domainStatus: "unlisted",
      identity: { name: "Acme", slug: "acme", domain: "acme.com" },
      products: [{ name: "Widget", locationCount: 1 }],
      locations: [
        {
          locator: "https://acme.com/feed.xml",
          kind: "feed",
          classification: "tier1-live",
          becomes: "Live source when tracked",
          productName: "Widget",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("validation result carries errors + org pointer for a listed domain", () => {
    const parsed = ListingValidationResultSchema.safeParse({
      valid: false,
      errors: [{ path: "products.0.releases.0", message: "must declare exactly one locator" }],
      domainStatus: "listed",
      org: { slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" },
      locations: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("activate result covers created and existing shapes", () => {
    expect(
      ListingActivateResultSchema.safeParse({
        activated: true,
        org: { slug: "acme", name: "Acme", status: "stub", webUrl: "https://releases.sh/acme" },
        trackingRequested: false,
      }).success,
    ).toBe(true);
    expect(
      ListingActivateResultSchema.safeParse({
        activated: false,
        org: { slug: "acme", name: "Acme", status: "stub", webUrl: "https://releases.sh/acme" },
        trackingRequested: true,
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/api-types/test/listing.test.ts`
Expected: FAIL — `ListingValidateBodySchema` is not exported.

- [ ] **Step 3: Write the schemas**

```ts
// packages/api-types/src/schemas/listing.ts
import { z } from "zod";

/**
 * Public wire contract for the self-serve listing lane (#1947 phase 2):
 * POST /v1/listing/validate and POST /v1/listing/activate. This projection is
 * deliberately independent of the internal materialization plan — it is the
 * stable shape web/CLI consume while internals stay free to change.
 */

export const ListingValidateBodySchema = z.strictObject({
  domain: z.string().min(1).max(255),
});
export type ListingValidateBody = z.infer<typeof ListingValidateBodySchema>;

export const ListingActivateBodySchema = z.strictObject({
  domain: z.string().min(1).max(255),
  requestTracking: z.boolean().optional(),
});
export type ListingActivateBody = z.infer<typeof ListingActivateBodySchema>;

export const ListingIssueSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});
export type ListingIssue = z.infer<typeof ListingIssueSchema>;

export const ListingLocationSchema = z.strictObject({
  /** The declared locator value (feed URL, github ref, url, appstore id, file). */
  locator: z.string(),
  kind: z.enum(["feed", "github", "appstore", "url", "file"]),
  classification: z.enum(["tier1-live", "tier2-paused-review"]),
  /** Plain-English "what this becomes" for the preview UI. */
  becomes: z.string(),
  /** Present when the locator is nested under a manifest product. */
  productName: z.string().optional(),
});
export type ListingLocation = z.infer<typeof ListingLocationSchema>;

export const ListingOrgPointerSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  webUrl: z.string(),
});

export const ListingValidationResultSchema = z.strictObject({
  valid: z.boolean(),
  errors: z.array(ListingIssueSchema),
  domainStatus: z.enum(["unlisted", "listed", "stub"]),
  /** Present when domainStatus is "listed" or "stub". */
  org: ListingOrgPointerSchema.optional(),
  /** Present when valid: identity fields as they would land. */
  identity: z
    .strictObject({
      name: z.string(),
      slug: z.string(),
      domain: z.string(),
    })
    .optional(),
  products: z.array(z.strictObject({ name: z.string(), locationCount: z.number() })).optional(),
  locations: z.array(ListingLocationSchema),
});
export type ListingValidationResult = z.infer<typeof ListingValidationResultSchema>;

export const ListingActivateResultSchema = z.strictObject({
  /** True when this call created the stub; false for the existing-stub carve-out. */
  activated: z.boolean(),
  org: z.strictObject({
    slug: z.string(),
    name: z.string(),
    status: z.enum(["stub", "tracked"]),
    webUrl: z.string(),
  }),
  trackingRequested: z.boolean(),
});
export type ListingActivateResult = z.infer<typeof ListingActivateResultSchema>;
```

- [ ] **Step 4: Barrel export**

In `packages/api-types/src/api-types.ts`, next to the existing `well-known` re-exports, add:

```ts
export {
  ListingValidateBodySchema,
  ListingActivateBodySchema,
  ListingIssueSchema,
  ListingLocationSchema,
  ListingOrgPointerSchema,
  ListingValidationResultSchema,
  ListingActivateResultSchema,
  type ListingValidateBody,
  type ListingActivateBody,
  type ListingIssue,
  type ListingLocation,
  type ListingValidationResult,
  type ListingActivateResult,
} from "./schemas/listing.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/api-types/test/listing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api-types/src/schemas/listing.ts packages/api-types/src/api-types.ts packages/api-types/test/listing.test.ts
git commit -m "feat(api-types): listing validate/activate wire schemas (#1947 phase 2)"
```

---

### Task 2: Schema column + migration — `organizations.tracking_requested_at`

**Files:**
- Modify: `packages/core/src/schema.ts` (organizations table, next to `promotingAt` around line 94)
- Create: `workers/api/migrations/20260707000000_add_organizations_tracking_requested_at.sql`

**Interfaces:**
- Produces (consumed by Task 7): `organizations.trackingRequestedAt` drizzle column (`text("tracking_requested_at")`, nullable).

- [ ] **Step 1: Add the column to the drizzle schema**

In `packages/core/src/schema.ts`, immediately after the `promotingAt` column in the `organizations` table:

```ts
  // Owner demand signal (#1947 phase 2): stamped when a domain owner requests
  // tracking through the self-serve listing lane (POST /v1/listing/activate
  // with requestTracking). Repeat requests refresh the timestamp. Internal —
  // surfaced only on admin read surfaces, never in public api-types.
  trackingRequestedAt: text("tracking_requested_at"),
```

- [ ] **Step 2: Write the paired migration**

```sql
-- workers/api/migrations/20260707000000_add_organizations_tracking_requested_at.sql
-- Owner demand signal for the promotion loop (#1947 phase 2). Stamped when a
-- domain owner requests tracking via the self-serve listing lane
-- (POST /v1/listing/activate with requestTracking: true), on stub creation or
-- on the existing-stub carve-out; repeat requests refresh it. NULL = never
-- requested. Internal-only — read via admin surfaces, not public api-types.
ALTER TABLE organizations ADD COLUMN tracking_requested_at TEXT;
```

- [ ] **Step 3: Verify the pairing gate + types**

Run: `bun run check`
Expected: PASS (the schema/migration pairing gate sees both files changed together).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/schema.ts workers/api/migrations/20260707000000_add_organizations_tracking_requested_at.sql
git commit -m "feat(core): organizations.tracking_requested_at demand-signal column (#1947 phase 2)"
```

---

### Task 3: Extract `resolveDomainOrg()` from stub.ts

The domain → existing-org resolution (`organizations.domain` + `domain_aliases`, both soft-delete-aware) currently lives inline in `createStubFromManifest` (`workers/api/src/lib/well-known/stub.ts` ~lines 349–362). The validate lane needs the same resolution *plus the org row* (to build the pointer + status). Extract it; behavior unchanged.

**Files:**
- Modify: `workers/api/src/lib/well-known/stub.ts`
- Test: `workers/api/test/orgs-stub-routes.test.ts` (existing suite is the regression net; plus one new direct unit test in `workers/api/src/lib/well-known/stub.test.ts` if that file exists, otherwise add the unit test to the route test file)

**Interfaces:**
- Produces (consumed by Tasks 4, 7):

```ts
export async function resolveDomainOrg(
  db: Db,
  domain: string,
): Promise<typeof organizations.$inferSelect | null>;
```

Returns the live (non-soft-deleted) org whose `organizations.domain` or `domain_aliases.domain` matches the normalized domain, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
// append to workers/api/test/orgs-stub-routes.test.ts
import { resolveDomainOrg } from "../src/lib/well-known/stub.js";

describe("resolveDomainOrg", () => {
  it("resolves by organizations.domain and returns the org row", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Acme", slug: "acme", domain: "acme.com", products: [], locations: [] },
      { basis: "curator" },
    );
    const hit = await resolveDomainOrg(db as never, "acme.com");
    expect(hit?.id).toBe(org.id);
    expect(await resolveDomainOrg(db as never, "other.com")).toBeNull();
  });
});
```

(Adjust the `createStubOrg` input shape to the actual `StubOrgInput` fields — check the interface at the top of stub.ts; `locations` may be named differently. Use the same fixture shape the existing tests in this file use.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/api/test/orgs-stub-routes.test.ts`
Expected: FAIL — `resolveDomainOrg` is not exported.

- [ ] **Step 3: Extract the helper**

In `stub.ts`, add the exported function and replace the inline lookups in `createStubFromManifest` with a call to it:

```ts
/** Resolve a normalized domain to its live org via `organizations.domain` or
 *  a `domain_aliases` row — the same two backends GET /v1/lookups/by-domain
 *  resolves through. Returns the org row (for status/pointer) or null. */
export async function resolveDomainOrg(
  db: Db,
  domain: string,
): Promise<typeof organizations.$inferSelect | null> {
  const [direct] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.domain, domain), isNull(organizations.deletedAt)))
    .limit(1);
  if (direct) return direct;
  const [alias] = await db
    .select({ orgId: domainAliases.orgId })
    .from(domainAliases)
    .where(eq(domainAliases.domain, domain))
    .limit(1);
  if (!alias) return null;
  const [aliasOrg] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, alias.orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return aliasOrg ?? null;
}
```

In `createStubFromManifest`, replace the two inline guard queries with:

```ts
  if (await resolveDomainOrg(db, domain)) {
    return { created: false, skippedReason: "org_exists" };
  }
```

(Preserve the existing behavior — the old code returned `org_exists` for both the direct and alias hit.)

- [ ] **Step 4: Run the full stub suite**

Run: `bun test workers/api/test/orgs-stub-routes.test.ts`
Expected: PASS — new test green, zero regressions in the existing stub-from-domain tests.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/well-known/stub.ts workers/api/test/orgs-stub-routes.test.ts
git commit -m "refactor(well-known): extract resolveDomainOrg for the listing lane (#1947 phase 2)"
```

---

### Task 4: `validateListing()` projection lib

**Files:**
- Create: `workers/api/src/lib/listing/validate.ts`
- Test: `workers/api/src/lib/listing/validate.test.ts`

**Interfaces:**
- Consumes: `fetchReleasesJson` (`../well-known/fetch.js`), `ReleasesJsonDomainSchema` (api-types), `classifyLocation` + `DeclaredLocation` (`../well-known/materialize.js`), `resolveDomainOrg` (Task 3), `manifestToStubInput` is NOT used (identity preview derives from the manifest directly).
- Produces (consumed by Tasks 6, 7):

```ts
export async function validateListing(
  db: Db,
  rawDomain: string,
  opts: { webBaseUrl: string; fetchImpl?: typeof fetch } = { webBaseUrl: "https://releases.sh" },
): Promise<ListingValidationResult>;
```

Also exports `normalizeListingDomain(raw: string): string | null` (lowercase, strip trailing dots, reject non-`[a-z0-9.-]`; returns null when invalid — same normalization `createStubFromManifest` applies).

- [ ] **Step 1: Write the failing tests**

```ts
// workers/api/src/lib/listing/validate.test.ts
import { describe, it, expect } from "bun:test";
import { createTestDb } from "../../../test/setup";
import { createStubOrg } from "../well-known/stub.js";
import { validateListing, normalizeListingDomain } from "./validate.js";

const WEB = { webBaseUrl: "https://releases.sh" };

/** fetchImpl that serves a manifest for https://<domain>/.well-known/releases.json */
const manifestFetch = (manifest: unknown) => async () =>
  new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const VALID_MANIFEST = {
  version: 2,
  name: "Acme",
  products: [{ name: "Widget", releases: [{ feed: "https://acme.com/widget.xml" }] }],
  releases: [{ url: "https://acme.com/blog" }],
};

describe("normalizeListingDomain", () => {
  it("lowercases, strips trailing dots, rejects junk", () => {
    expect(normalizeListingDomain("Acme.COM.")).toBe("acme.com");
    expect(normalizeListingDomain("not a domain!")).toBeNull();
  });
});

describe("validateListing", () => {
  it("returns a valid unlisted preview with classified locations", async () => {
    const db = createTestDb();
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch(VALID_MANIFEST),
    });
    expect(res.valid).toBe(true);
    expect(res.domainStatus).toBe("unlisted");
    expect(res.identity).toEqual({ name: "Acme", slug: "acme", domain: "acme.com" });
    expect(res.locations).toEqual([
      {
        locator: "https://acme.com/widget.xml",
        kind: "feed",
        classification: "tier1-live",
        becomes: "Live source when tracked",
        productName: "Widget",
      },
      {
        locator: "https://acme.com/blog",
        kind: "url",
        classification: "tier2-paused-review",
        becomes: "Queued for curator review when tracked",
      },
    ]);
  });

  it("reports schema issues with paths, still resolving domainStatus", async () => {
    const db = createTestDb();
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch({ version: 2, products: [{ releases: [{}] }] }),
    });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toHaveProperty("path");
    expect(res.errors[0]).toHaveProperty("message");
    expect(res.locations).toEqual([]);
  });

  it("maps fetch failures to a single actionable error", async () => {
    const db = createTestDb();
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: async () => new Response("nope", { status: 404 }),
    });
    expect(res.valid).toBe(false);
    expect(res.errors[0]!.path).toBe("");
    expect(res.errors[0]!.message).toContain("releases.json");
  });

  it("flags a stub domain with the org pointer", async () => {
    const db = createTestDb();
    await createStubOrg(
      db as never,
      { name: "Acme", slug: "acme", domain: "acme.com", products: [], locations: [] },
      { basis: "curator" },
    );
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch(VALID_MANIFEST),
    });
    expect(res.domainStatus).toBe("stub");
    expect(res.org).toEqual({ slug: "acme", name: "Acme", webUrl: "https://releases.sh/acme" });
  });

  it("flags a tracked domain as listed", async () => {
    const db = createTestDb();
    const { org } = await createStubOrg(
      db as never,
      { name: "Acme", slug: "acme", domain: "acme.com", products: [], locations: [] },
      { basis: "curator" },
    );
    const { organizations } = await import("@buildinternet/releases-core/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(organizations).set({ tier: "tracked" }).where(eq(organizations.id, org.id));
    const res = await validateListing(db as never, "acme.com", {
      ...WEB,
      fetchImpl: manifestFetch(VALID_MANIFEST),
    });
    expect(res.domainStatus).toBe("listed");
  });
});
```

(As in Task 3: match the `createStubOrg` input field names to the real `StubOrgInput` interface.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test workers/api/src/lib/listing/validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// workers/api/src/lib/listing/validate.ts
import {
  ReleasesJsonDomainSchema,
  type ListingValidationResult,
  type ListingLocation,
  type ReleasesJsonDomain,
} from "@buildinternet/releases-api-types";
import { toSlug } from "@buildinternet/releases-core/slug";
import { fetchReleasesJson } from "../well-known/fetch.js";
import { classifyLocation, type DeclaredLocation } from "../well-known/materialize.js";
import { resolveDomainOrg } from "../well-known/stub.js";
import type { createDb } from "../../db.js";

type Db = ReturnType<typeof createDb>;

/** Same normalization createStubFromManifest applies to its raw domain. */
export function normalizeListingDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.length === 0) return null;
  return domain;
}

const BECOMES: Record<"tier1" | "tier2", string> = {
  tier1: "Live source when tracked",
  tier2: "Queued for curator review when tracked",
};

function locatorKind(loc: DeclaredLocation): ListingLocation["kind"] {
  if (loc.feed) return "feed";
  if (loc.github) return "github";
  if (loc.appstore) return "appstore";
  if (loc.file) return "file";
  return "url";
}

function toListingLocation(loc: DeclaredLocation, productName?: string): ListingLocation {
  const classified = classifyLocation(loc);
  return {
    locator: classified.locator,
    kind: locatorKind(loc),
    classification: classified.tier === 1 ? "tier1-live" : "tier2-paused-review",
    becomes: classified.tier === 1 ? BECOMES.tier1 : BECOMES.tier2,
    ...(productName ? { productName } : {}),
  };
}

/** Human-readable fetch-failure copy keyed by FetchSkipReason. */
const FETCH_ERROR: Record<string, string> = {
  blocked: "That domain can't be fetched (blocked or not publicly reachable over HTTPS).",
  not_found: "No releases.json found at /.well-known/releases.json on that domain.",
  http_error: "Fetching /.well-known/releases.json returned an HTTP error.",
  network_error: "Could not reach that domain to fetch /.well-known/releases.json.",
  too_large: "releases.json is larger than the 64KB limit.",
  invalid_json: "releases.json is not valid JSON.",
};

export async function validateListing(
  db: Db,
  rawDomain: string,
  opts: { webBaseUrl: string; fetchImpl?: typeof fetch },
): Promise<ListingValidationResult> {
  const domain = normalizeListingDomain(rawDomain);
  if (!domain) {
    return {
      valid: false,
      errors: [{ path: "domain", message: "Not a valid domain name." }],
      domainStatus: "unlisted",
      locations: [],
    };
  }

  const existing = await resolveDomainOrg(db, domain);
  const domainStatus: ListingValidationResult["domainStatus"] = existing
    ? existing.tier === "stub"
      ? "stub"
      : "listed"
    : "unlisted";
  const org = existing
    ? { slug: existing.slug, name: existing.name, webUrl: `${opts.webBaseUrl}/${existing.slug}` }
    : undefined;

  const fetched = await fetchReleasesJson(`https://${domain}/.well-known/releases.json`, {
    fetchImpl: opts.fetchImpl,
  });
  if (!fetched.ok) {
    return {
      valid: false,
      errors: [{ path: "", message: FETCH_ERROR[fetched.reason] ?? FETCH_ERROR.network_error! }],
      domainStatus,
      ...(org ? { org } : {}),
      locations: [],
    };
  }

  const parsed = ReleasesJsonDomainSchema.safeParse(fetched.json);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      domainStatus,
      ...(org ? { org } : {}),
      locations: [],
    };
  }

  const manifest: ReleasesJsonDomain = parsed.data;
  const name = manifest.name ?? domain;
  const locations: ListingLocation[] = [
    ...(manifest.products ?? []).flatMap((p) =>
      (p.releases ?? []).map((r) => toListingLocation(r as DeclaredLocation, p.name)),
    ),
    ...(manifest.releases ?? []).map((r) => toListingLocation(r as DeclaredLocation)),
  ];

  return {
    valid: true,
    errors: [],
    domainStatus,
    ...(org ? { org } : {}),
    identity: { name, slug: toSlug(name), domain },
    products: (manifest.products ?? []).map((p) => ({
      name: p.name,
      locationCount: (p.releases ?? []).length,
    })),
    locations,
  };
}
```

(If `ReleasesJsonProduct.name` is optional in the schema, guard with `p.name ?? domain`-style fallback matching what `manifestToStubInput` does — check stub.ts and mirror it so preview and activation agree.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test workers/api/src/lib/listing/validate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/listing/
git commit -m "feat(listing): validateListing projection over the shared well-known machinery (#1947 phase 2)"
```

---

### Task 5: Flag + rate-limiter bindings + env plumbing

**Files:**
- Modify: `packages/lib/src/flags.ts` (FLAGS registry)
- Modify: `workers/api/wrangler.jsonc` (vars + two `unsafe.bindings` ratelimit entries, prod AND `[env.staging]` blocks)
- Modify: `workers/api/src/index.ts` (Env bindings type)

**Interfaces:**
- Produces (consumed by Task 6/7): `FLAGS.listingSelfServeEnabled`; Env bindings `LISTING_SELF_SERVE_ENABLED?: string`, `LISTING_RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> }`, `LISTING_DOMAIN_RATE_LIMITER?: same shape`.

- [ ] **Step 1: Registry entry**

In `packages/lib/src/flags.ts`, add to `FLAGS` (alphabetical/grouped consistent with neighbors):

```ts
  listingSelfServeEnabled: {
    key: "listing-self-serve-enabled",
    env: "LISTING_SELF_SERVE_ENABLED",
    default: true,
    kind: "kill-switch",
    reads: ["api"],
    description:
      "Anonymous self-serve listing lane (/v1/listing validate + activate). Off = both routes refuse.",
  },
```

- [ ] **Step 2: wrangler.jsonc**

In the top-level `vars` block: `"LISTING_SELF_SERVE_ENABLED": "true",` (mirror into `[env.staging]` vars).

In `unsafe.bindings`, after the existing ratelimit entries (last namespace_id is 1007):

```jsonc
    {
      // Self-serve listing lane (#1947 phase 2): per-IP across validate+activate.
      "name": "LISTING_RATE_LIMITER",
      "type": "ratelimit",
      "namespace_id": "1008",
      "simple": { "limit": 10, "period": 60 },
    },
    {
      // Per-domain churn brake on activate. CF-native limiters cap at 60s
      // windows; activation is idempotent so a daily KV counter isn't needed.
      "name": "LISTING_DOMAIN_RATE_LIMITER",
      "type": "ratelimit",
      "namespace_id": "1009",
      "simple": { "limit": 3, "period": 60 },
    },
```

(Mirror both into the `[env.staging]` unsafe.bindings if that block declares the other limiters — check how AUTH_RATE_LIMITER is handled in staging and match.)

- [ ] **Step 3: Env type**

In `workers/api/src/index.ts` `Env.Bindings`, next to the existing limiter bindings:

```ts
    LISTING_SELF_SERVE_ENABLED?: string;
    LISTING_RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
    LISTING_DOMAIN_RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
```

(Match the exact limiter type alias the codebase already uses for `AUTH_RATE_LIMITER` — grep for its declaration and reuse the same type.)

- [ ] **Step 4: Verify**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/flags.ts workers/api/wrangler.jsonc workers/api/src/index.ts
git commit -m "chore(listing): kill-switch flag + rate-limiter bindings (#1947 phase 2)"
```

---

### Task 6: `POST /v1/listing/validate` route

**Files:**
- Create: `workers/api/src/routes/listing.ts`
- Test: `workers/api/test/listing-routes.test.ts`

**Interfaces:**
- Consumes: `validateListing` (Task 4), `ListingValidateBodySchema` (Task 1), `FLAGS.listingSelfServeEnabled` + bindings (Task 5), `respondError` + `NotFoundError`/`RateLimitedError` (`@releases/lib/releases-error`), `describeRoute`/`validateJson` per the orgs.ts pattern.
- Produces: `export const listingRoutes = new Hono<Env>()` with the validate handler (activate added in Task 7); shared `guardListing(c)` helper (flag + per-IP limit) reused by both handlers.

- [ ] **Step 1: Write the failing tests**

```ts
// workers/api/test/listing-routes.test.ts
import { describe, it, expect } from "bun:test";
import { listingRoutes } from "../src/routes/listing.js";
import { createTestDb, createTestApp } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const okLimiter = { limit: async () => ({ success: true }) };
const noLimiter = { limit: async () => ({ success: false }) };

const MANIFEST = {
  version: 2,
  name: "Acme",
  products: [{ name: "Widget", releases: [{ feed: "https://acme.com/widget.xml" }] }],
};

function mockManifestFetch(manifest: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function app(db: ReturnType<typeof createTestDb>, env: Record<string, unknown> = {}) {
  return createTestApp(db, listingRoutes, {
    env: {
      WEB_BASE_URL: "https://releases.sh",
      LISTING_RATE_LIMITER: okLimiter,
      LISTING_DOMAIN_RATE_LIMITER: okLimiter,
      ...env,
    },
  });
}

describe("POST /v1/listing/validate", () => {
  it("returns the projection for an unlisted domain, no auth required", async () => {
    mockManifestFetch(MANIFEST);
    const res = await app(createTestDb())(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ domain: "acme.com" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; domainStatus: string };
    expect(body.valid).toBe(true);
    expect(body.domainStatus).toBe("unlisted");
  });

  it("refuses when the kill switch is off", async () => {
    const res = await app(createTestDb(), { LISTING_SELF_SERVE_ENABLED: "false" })(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ domain: "acme.com" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found");
  });

  it("429s when the per-IP limiter says no", async () => {
    const res = await app(createTestDb(), { LISTING_RATE_LIMITER: noLimiter })(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ domain: "acme.com" }),
      }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("rate_limited");
  });

  it("422s a malformed body via the standard envelope", async () => {
    const res = await app(createTestDb())(
      new Request("https://x/v1/listing/validate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ nope: true }),
      }),
    );
    expect([400, 422]).toContain(res.status);
  });
});
```

Add `restoreGlobalFetch` from `../../../tests/global-fetch` in an `afterEach`, mirroring `orgs-stub-routes.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test workers/api/test/listing-routes.test.ts`
Expected: FAIL — `../src/routes/listing.js` not found.

- [ ] **Step 3: Implement the route file**

```ts
// workers/api/src/routes/listing.ts
import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { ListingValidateBodySchema } from "@buildinternet/releases-api-types";
import { FLAGS, flag } from "@releases/lib/flags";
import { NotFoundError, RateLimitedError } from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { validateListing } from "../lib/listing/validate.js";
import { respondError } from "../lib/error-response.js";
import { validateJson } from "../lib/validate.js"; // ← match the exact helper orgs.ts imports
import { errorEnvelopeSchema } from "../lib/error-envelope-schema.js"; // ← match orgs.ts import

export const listingRoutes = new Hono<Env>();

/**
 * Self-serve listing lane (#1947 phase 2). Both routes are PUBLIC and
 * anonymous — integrity comes from manifest host-scoping (you can only
 * declare a domain you control), the kill switch, and the rate limiters.
 */
async function guardListing(c: Context<Env>): Promise<Response | null> {
  const enabled = await flag(
    c.env.FLAGS,
    c.env.LISTING_SELF_SERVE_ENABLED,
    FLAGS.listingSelfServeEnabled,
  );
  if (!enabled) {
    // 404 (not 403): when the lane is off it simply doesn't exist.
    return respondError(c, new NotFoundError("Not found"));
  }
  const limiter = c.env.LISTING_RATE_LIMITER;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `listing:${ip}` });
    if (!success) {
      return respondError(c, new RateLimitedError("Too many listing requests; slow down."));
    }
  }
  return null;
}

listingRoutes.post(
  "/listing/validate",
  describeRoute({
    tags: ["Listing"],
    summary: "Validate a domain's releases.json and preview its listing",
    description:
      "Fetches https://{domain}/.well-known/releases.json live (HTTPS-only, 64KB, 5s), validates it against the v2 manifest schema, and returns a preview: identity, products, and per-locator classification, plus whether the domain is already listed. Public and anonymous; rate limited.",
    responses: {
      200: { description: "ListingValidationResult" },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
    },
  }),
  validateJson(ListingValidateBodySchema),
  async (c) => {
    const guarded = await guardListing(c);
    if (guarded) return guarded;
    const { domain } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const result = await validateListing(db, domain, {
      webBaseUrl: c.env.WEB_BASE_URL ?? "https://releases.sh",
    });
    logEvent("info", {
      component: "listing",
      event: "listing-validated",
      domain,
      valid: result.valid,
      domainStatus: result.domainStatus,
    });
    return c.json(result);
  },
);
```

(Check the real import paths for `validateJson`, `errorEnvelopeSchema`, `respondError`, and `WEB_BASE_URL` in `routes/orgs.ts` / Env and match them exactly — orgs.ts imports are the source of truth.)

- [ ] **Step 4: Run tests**

Run: `bun test workers/api/test/listing-routes.test.ts`
Expected: PASS (4 tests). Note the route isn't mounted in the real app yet — `createTestApp` mounts the module directly; app wiring is Task 8.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/listing.ts workers/api/test/listing-routes.test.ts
git commit -m "feat(listing): public validate route (#1947 phase 2)"
```

---

### Task 7: `POST /v1/listing/activate` route

**Files:**
- Modify: `workers/api/src/routes/listing.ts`
- Test: `workers/api/test/listing-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `createStubFromManifest` + `resolveDomainOrg` (stub.ts), `ListingActivateBodySchema` + `ListingActivateResult` (Task 1), `organizations.trackingRequestedAt` (Task 2), `ConflictError`, `guardListing` + per-domain limiter (Tasks 5/6).

- [ ] **Step 1: Write the failing tests** (append to `listing-routes.test.ts`)

```ts
import { eq } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";

describe("POST /v1/listing/activate", () => {
  const activate = (db: ReturnType<typeof createTestDb>, body: unknown, env = {}) =>
    app(db, env)(
      new Request("https://x/v1/listing/activate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }),
    );

  it("creates a stub for an unlisted domain and returns the pointer", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    const res = await activate(db, { domain: "acme.com" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      activated: boolean;
      org: { slug: string; status: string; webUrl: string };
      trackingRequested: boolean;
    };
    expect(body.activated).toBe(true);
    expect(body.org.status).toBe("stub");
    expect(body.trackingRequested).toBe(false);
    const [org] = await db.select().from(organizations);
    expect(org!.tier).toBe("stub");
    expect(org!.trackingRequestedAt).toBeNull();
  });

  it("stamps tracking_requested_at when requested at creation", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    const res = await activate(db, { domain: "acme.com", requestTracking: true });
    expect(res.status).toBe(201);
    const [org] = await db.select().from(organizations);
    expect(org!.trackingRequestedAt).not.toBeNull();
  });

  it("existing-stub carve-out: no new org, refreshes the tracking stamp", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    await activate(db, { domain: "acme.com" });
    const res = await activate(db, { domain: "acme.com", requestTracking: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activated: boolean; trackingRequested: boolean };
    expect(body.activated).toBe(false);
    expect(body.trackingRequested).toBe(true);
    const rows = await db.select().from(organizations);
    expect(rows.length).toBe(1);
    expect(rows[0]!.trackingRequestedAt).not.toBeNull();
  });

  it("409s a tracked (listed) domain with the org pointer in details", async () => {
    mockManifestFetch(MANIFEST);
    const db = createTestDb();
    await activate(db, { domain: "acme.com" });
    const [org] = await db.select().from(organizations);
    await db
      .update(organizations)
      .set({ tier: "tracked" })
      .where(eq(organizations.id, org!.id));
    const res = await activate(db, { domain: "acme.com" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { type: string; details?: { slug?: string } } };
    expect(body.error.type).toBe("conflict");
    expect(body.error.details?.slug).toBe(org!.slug);
  });

  it("422s an invalid manifest instead of writing", async () => {
    mockManifestFetch({ version: 1 });
    const db = createTestDb();
    const res = await activate(db, { domain: "acme.com" });
    expect(res.status).toBe(422);
    expect((await db.select().from(organizations)).length).toBe(0);
  });

  it("429s when the per-domain limiter refuses", async () => {
    mockManifestFetch(MANIFEST);
    const res = await activate(createTestDb(), { domain: "acme.com" }, {
      LISTING_DOMAIN_RATE_LIMITER: noLimiter,
    });
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test workers/api/test/listing-routes.test.ts`
Expected: FAIL — 404 on `/listing/activate`.

- [ ] **Step 3: Implement the activate handler** (append to `routes/listing.ts`)

```ts
import { ListingActivateBodySchema } from "@buildinternet/releases-api-types";
import { ConflictError, ValidationError } from "@releases/lib/releases-error";
import { organizations } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { createStubFromManifest, resolveDomainOrg } from "../lib/well-known/stub.js";
import { normalizeListingDomain } from "../lib/listing/validate.js";

listingRoutes.post(
  "/listing/activate",
  describeRoute({
    tags: ["Listing"],
    summary: "Activate an instant stub listing for an unlisted domain",
    description:
      "Re-validates https://{domain}/.well-known/releases.json server-side, then creates a stub org (basis: declared) for an unlisted domain. Already-stub domains take no write except an optional tracking-request stamp; tracked domains 409 with the org pointer. Public and anonymous; rate limited per IP and per domain.",
    responses: {
      201: { description: "Stub created (ListingActivateResult)" },
      200: { description: "Existing stub; tracking stamp updated (ListingActivateResult)" },
      409: {
        description: "Domain already listed (tracked)",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      422: {
        description: "Manifest invalid or unfetchable",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
    },
  }),
  validateJson(ListingActivateBodySchema),
  async (c) => {
    const guarded = await guardListing(c);
    if (guarded) return guarded;
    const { domain: rawDomain, requestTracking } = c.req.valid("json");
    const domain = normalizeListingDomain(rawDomain);
    if (!domain) return respondError(c, new ValidationError("Not a valid domain name."));

    const domainLimiter = c.env.LISTING_DOMAIN_RATE_LIMITER;
    if (domainLimiter) {
      const { success } = await domainLimiter.limit({ key: `listing-activate:${domain}` });
      if (!success) {
        return respondError(c, new RateLimitedError("Too many activations for this domain."));
      }
    }

    const db = createDb(c.env.DB);
    const webBaseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";
    const now = new Date().toISOString();

    const existing = await resolveDomainOrg(db, domain);
    if (existing) {
      if (existing.tier !== "stub") {
        return respondError(
          c,
          new ConflictError("This domain is already listed.", {
            details: { slug: existing.slug, webUrl: `${webBaseUrl}/${existing.slug}` },
          }),
        );
      }
      // Existing-stub carve-out: the only write is the tracking stamp.
      if (requestTracking) {
        await db
          .update(organizations)
          .set({ trackingRequestedAt: now, updatedAt: now })
          .where(eq(organizations.id, existing.id));
        logEvent("info", {
          component: "listing",
          event: "tracking-requested",
          orgId: existing.id,
          domain,
        });
      }
      return c.json(
        {
          activated: false,
          org: {
            slug: existing.slug,
            name: existing.name,
            status: "stub",
            webUrl: `${webBaseUrl}/${existing.slug}`,
          },
          trackingRequested: requestTracking === true,
        },
        200,
      );
    }

    const result = await createStubFromManifest(db, domain, {});
    if (!result.created) {
      // Every skip here is a manifest/fetch problem (org_exists was handled
      // above; a create race lands org_exists too — treat it as conflict).
      if (result.skippedReason === "org_exists") {
        return respondError(c, new ConflictError("This domain is already listed."));
      }
      return respondError(
        c,
        new ValidationError("The manifest could not be activated.", {
          details: { reason: result.skippedReason },
        }),
      );
    }

    if (requestTracking) {
      await db
        .update(organizations)
        .set({ trackingRequestedAt: now, updatedAt: now })
        .where(eq(organizations.id, result.orgId!));
    }
    const [created] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, result.orgId!));
    logEvent("info", {
      component: "listing",
      event: "listing-activated",
      orgId: result.orgId,
      domain,
      trackingRequested: requestTracking === true,
      locationCount: result.locationCount,
    });
    return c.json(
      {
        activated: true,
        org: {
          slug: created!.slug,
          name: created!.name,
          status: "stub",
          webUrl: `${webBaseUrl}/${created!.slug}`,
        },
        trackingRequested: requestTracking === true,
      },
      201,
    );
  },
);
```

(Consolidate the imports at the top of the file rather than mid-file; shown here inline for task locality. If `ValidationError`'s wire status is not 422, check `statusForType` in `packages/lib/src/releases-error.ts` and use the subclass that maps to 422 — adjust the test expectation to the envelope's real status for `validation`.)

- [ ] **Step 4: Run tests**

Run: `bun test workers/api/test/listing-routes.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/listing.ts workers/api/test/listing-routes.test.ts
git commit -m "feat(listing): anonymous activate route with tracking-request stamp (#1947 phase 2)"
```

---

### Task 8: Wire into the app — mount, namespace bucket, OpenAPI gate

**Files:**
- Modify: `workers/api/src/v1-routes.ts` (mount)
- Modify: `workers/api/src/route-namespaces.ts` (new `publicWriteRoutes` bucket)
- Modify: `workers/api/src/index.ts` (middleware wiring for the new bucket)
- Test: existing OpenAPI coverage gate + one smoke assertion

**Interfaces:**
- Produces: `export const publicWriteRoutes = ["listing"] as const;` — namespaces with NO auth middleware on any method (handler-level guards only). Used by `index.ts` wiring and `scripts/check-openapi-coverage.ts`.

- [ ] **Step 1: Add the bucket**

In `route-namespaces.ts`:

```ts
/**
 * Public-WRITE namespaces: even non-SAFE methods are open to anonymous
 * callers. Integrity lives in the handlers (host-scoped manifest fetch,
 * kill-switch flag, per-IP + per-domain rate limiters) — NOT in auth
 * middleware. Currently only the self-serve listing lane (#1947 phase 2).
 */
export const publicWriteRoutes = ["listing"] as const;
```

- [ ] **Step 2: Wire middleware + mount**

In `index.ts`, where `publicReadRoutes`/`adminRoutes` drive middleware attachment, add the `publicWriteRoutes` loop attaching ONLY the shared plumbing the public-read bucket gets minus auth (trace through what `publicReadAuthMiddleware` provides — if it's auth+rate-limit fused, the listing namespaces get NO middleware from this loop; the handlers carry their own limiter). Read the existing loop and mirror its structure; the diff should be small and obvious once read.

In `v1-routes.ts`:

```ts
import { listingRoutes } from "./routes/listing.js";
// inside mountV1Routes:
  v1.route("/", listingRoutes);
```

- [ ] **Step 3: OpenAPI coverage**

Run: `bun scripts/check-openapi-coverage.ts` (or however CI invokes it — check `package.json` scripts / `.github/workflows`).
Expected: PASS with the two new `/listing/*` operations present. If the script derives its route universe from `publicReadRoutes ∪ adminRoutes`, extend it to include `publicWriteRoutes`.

- [ ] **Step 4: Full worker suite + check**

Run: `bun test workers/api && bun run check`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/v1-routes.ts workers/api/src/route-namespaces.ts workers/api/src/index.ts scripts/check-openapi-coverage.ts
git commit -m "feat(listing): mount /v1/listing as a public-write namespace (#1947 phase 2)"
```

---

### Task 9: Curator visibility — `trackingRequested` filter on the admin org list

**Files:**
- Modify: the admin org listing route (find it under `workers/api/src/routes/` — the handler behind `GET /v1/admin/orgs`; check `route-namespaces.ts`'s `admin/orgs` entry for the file)
- Test: the existing admin-orgs route test file (extend)

**Interfaces:**
- Consumes: `organizations.trackingRequestedAt` (Task 2).
- Produces: `GET /v1/admin/orgs?trackingRequested=1` returns only orgs with a non-NULL `tracking_requested_at`, newest request first, and each row includes `trackingRequestedAt` in the admin (not public) projection.

- [ ] **Step 1: Write the failing test** — in the existing admin-orgs test file, seed two orgs via the established fixtures, stamp `trackingRequestedAt` on one (`db.update(organizations).set({ trackingRequestedAt: new Date().toISOString() })…`), then:

```ts
it("filters to tracking-requested orgs and exposes the stamp", async () => {
  // ...seed as above...
  const res = await app(
    new Request("https://x/v1/admin/orgs?trackingRequested=1", { headers: adminAuth }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { slug: string; trackingRequestedAt?: string }[] };
  expect(body.items.map((o) => o.slug)).toEqual(["stamped-org"]);
  expect(body.items[0]!.trackingRequestedAt).toBeTruthy();
});
```

(Mirror the file's existing request/auth/assert helpers exactly — pagination envelope field names included.)

- [ ] **Step 2: Run test to verify it fails** — expected: filter ignored, both orgs returned.

- [ ] **Step 3: Implement** — in the admin org list handler: when `c.req.query("trackingRequested") === "1"`, add `isNotNull(organizations.trackingRequestedAt)` to the where clause and order by `trackingRequestedAt` desc; add `trackingRequestedAt` to the admin row projection.

- [ ] **Step 4: Run the admin-orgs test file** — expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add -A workers/api
git commit -m "feat(listing): trackingRequested filter on the admin org list (#1947 phase 2)"
```

---

### Task 10: Docs + conventions + deploy notes

**Files:**
- Modify: `AGENTS.md` (one-line convention entry pointing at the doc)
- Modify: `docs/architecture/well-known-config.md` (new "Self-serve listing lane" section)
- Modify: `docs/architecture/feature-flags.md` (flag table entry for `listing-self-serve-enabled`)

- [ ] **Step 1: AGENTS.md one-liner** (in Conventions, near the well-known manifest entry)

```markdown
- **Self-serve listing lane (#1947 phase 2)**: anonymous `POST /v1/listing/{validate,activate}` — live manifest validation + instant-stub activation with a `tracking_requested_at` demand signal; per-IP + per-domain CF limiters, kill switch `listing-self-serve-enabled`. See [well-known-config.md → Self-serve listing](docs/architecture/well-known-config.md).
```

- [ ] **Step 2: well-known-config.md section** — document: the two routes and their contracts (`ListingValidationResult` / `ListingActivateResult`), the anonymous posture rationale (host-scoping as the integrity gate), the stub carve-out and 409 semantics, rate limiter names/quotas, the flag, and the `publicWriteRoutes` bucket. 20–30 lines, following the doc's existing tone.

- [ ] **Step 3: feature-flags.md** — add `listing-self-serve-enabled` to the per-flag reference table (kind: kill-switch, reads: api, default: true).

- [ ] **Step 4: Format + verify**

Run: `bunx oxfmt AGENTS.md docs/architecture/well-known-config.md docs/architecture/feature-flags.md && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/architecture/well-known-config.md docs/architecture/feature-flags.md
git commit -m "docs(listing): self-serve listing lane conventions + flag reference (#1947 phase 2)"
```

- [ ] **Step 6: Record manual deploy steps in the PR description** (do NOT perform them in this plan):
  - Create Flagship key `listing-self-serve-enabled` in BOTH apps (`releases-platform`, `releases-platform-staging`).
  - api-types publish: separate bump-only PR after merge (additive minor), per the established 0.38.0 flow.

---

## Verification (whole plan)

1. `bun run check` — green.
2. `bun test workers/api` (separate process per root convention) — green.
3. `bun test packages/api-types packages/core packages/lib tests/` from root — green.
4. Migration smoke: `bun run db:reset:local` applies cleanly through the new migration.
5. OpenAPI coverage gate passes with the two new operations.

## Out of scope (later plans)

- Web `/submit` owner path (slice 2) — after these routes deploy.
- CLI `releases json validate` (slice 3, OSS repo) — after api-types publish.
- Admin surface filter for `tracking_requested_at` (decide shape when the first requests exist).
