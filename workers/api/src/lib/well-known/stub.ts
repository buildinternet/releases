import { and, eq, isNull } from "drizzle-orm";
import {
  organizations,
  products,
  domainAliases,
  releaseLocations,
  orgTags,
  orgAccounts,
} from "@buildinternet/releases-core/schema";
import { newProductId, newReleaseLocationId } from "@buildinternet/releases-core/id";
import { isValidKind } from "@buildinternet/releases-core/kinds";
import { toSlug } from "@buildinternet/releases-core/slug";
import {
  ReleasesJsonDomainSchema,
  type ReleasesJsonDomain,
} from "@buildinternet/releases-api-types";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { logEvent } from "@releases/lib/log-event";
import { getOrCreateTagsD1, isConflictError } from "../../utils.js";
import type { createDb } from "../../db.js";
import { RELEASE_LOCATIONS_INSERT_CHUNK_SIZE, ENTITY_TAG_INSERT_CHUNK_SIZE } from "../d1-limits.js";
import type { DeclaredLocation } from "./materialize.js";
import { releaseLocationMatchKey } from "./locator.js";
import { fetchReleasesJson } from "./fetch.js";
import { configHash } from "./self-declared.js";

type Db = ReturnType<typeof createDb>;

/** Provenance ladder from #1947 / #1872 — the source of a declared locator. */
export type LocatorBasis = "curator" | "declared" | "detected" | "generated";

/** One product a stub declares, plus its release locations. */
export interface StubProductInput {
  name: string;
  slug?: string;
  kind?: string | null;
  /** Already-resolved category slug (route resolves the alias), or null. */
  category?: string | null;
  description?: string | null;
  url?: string | null;
  archived?: boolean;
  locations: DeclaredLocation[];
}

/** Normalized input for {@link createStubOrg}. Callers resolve categories and
 *  pick a final org slug before handing off; this writer only inserts. */
export interface StubOrgInput {
  name: string;
  slug: string;
  domain?: string | null;
  description?: string | null;
  /** Already-resolved category slug, or null. */
  category?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  socials?: { platform: string; handle: string }[];
  products?: StubProductInput[];
  /** Org-scoped (product-less) release locations. */
  locations?: DeclaredLocation[];
}

export interface CreateStubResult {
  org: typeof organizations.$inferSelect;
  productCount: number;
  locationCount: number;
}

/**
 * Build one `release_locations` row with a uniform column set (every key
 * present, absent locators as null) so a multi-row insert keeps a stable
 * prepared-statement shape within the D1 bind budget.
 */
function locatorRow(
  location: DeclaredLocation,
  ctx: {
    orgId: string;
    productId: string | null;
    basis: LocatorBasis;
    evidence: unknown;
    now: string;
  },
): typeof releaseLocations.$inferInsert {
  const github = location.github && location.github !== "self" ? location.github : null;
  return {
    id: newReleaseLocationId(),
    orgId: ctx.orgId,
    productId: ctx.productId,
    url: location.url ?? null,
    feed: location.feed ?? null,
    github,
    appstore: location.appstore ?? null,
    file: location.file ?? null,
    title: location.title ?? null,
    canonical: location.canonical === true,
    basis: ctx.basis,
    evidence: ctx.evidence ?? null,
    sourceId: null,
    matchKey: releaseLocationMatchKey(location),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/**
 * Create a stub-tier org (#1947): an `organizations` row with `tier: "stub"`,
 * optional `products` rows, and `release_locations` locator rows — and NO
 * `sources`. Nothing here is schedulable; promotion (a later step) materializes
 * the locators into sources.
 *
 * The caller owns identity resolution: `slug` must be final and non-reserved,
 * `category` an already-resolved slug. A slug/domain UNIQUE collision throws
 * (the route maps it to 409). The write is best-effort sequential, not a
 * transaction (D1 has no interactive transactions): a failure mid locator-batch
 * leaves a stub with a partial locator set and, in phase 1, NO automatic repair
 * path — the org row already exists, so a re-run 409s at the org insert before
 * it can reach the locators. Manual repair (or the deferred locator-sync mode)
 * is required. The locator insert is `onConflictDoNothing` so that a future
 * repair/re-sync pass can safely run over an already-populated stub.
 */
export async function createStubOrg(
  db: Db,
  input: StubOrgInput,
  opts: { basis: LocatorBasis; evidence?: unknown },
): Promise<CreateStubResult> {
  const now = new Date().toISOString();

  const [org] = await db
    .insert(organizations)
    .values({
      name: input.name,
      slug: input.slug,
      domain: input.domain ?? null,
      description: input.description ?? null,
      category: input.category ?? null,
      avatarUrl: input.avatarUrl ?? null,
      tier: "stub",
      // Owner/curator-declared, not agent-discovered — and NOT `on_demand`, so
      // the stub stays visible in `organizations_public` (the catalog badge is
      // the point). No releases → keep auto content generation off.
      discovery: "curated",
      autoGenerateContent: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Additive tags (mirrors POST /v1/orgs).
  if (input.tags && input.tags.length > 0) {
    const tagRows = await getOrCreateTagsD1(db, input.tags);
    const rows = tagRows.map((t) => ({ orgId: org.id, tagId: t.id, createdAt: now }));
    for (let i = 0; i < rows.length; i += ENTITY_TAG_INSERT_CHUNK_SIZE) {
      // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100-bind cap)
      await db
        .insert(orgTags)
        .values(rows.slice(i, i + ENTITY_TAG_INSERT_CHUNK_SIZE))
        .onConflictDoNothing();
    }
  }

  // Additive socials.
  if (input.socials && input.socials.length > 0) {
    await db
      .insert(orgAccounts)
      .values(
        input.socials.map((s) => ({
          orgId: org.id,
          platform: s.platform,
          handle: s.handle,
          createdAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  // Products. Slugs are made unique within the org up front (the DB also
  // enforces UNIQUE(org_id, slug)).
  const usedProductSlugs = new Set<string>();
  const productIdByIndex: (string | null)[] = [];
  for (const product of input.products ?? []) {
    const slug = nextSlug(product.slug ?? product.name, usedProductSlugs);
    const productId = newProductId();
    // oxlint-disable-next-line no-await-in-loop -- sequential product inserts; count is bounded by MAX_PRODUCTS
    await db.insert(products).values({
      id: productId,
      orgId: org.id,
      name: product.name,
      slug,
      description: product.description ?? null,
      url: product.url ?? null,
      category: product.category ?? null,
      kind: product.kind && isValidKind(product.kind) ? product.kind : null,
      createdAt: now,
    });
    productIdByIndex.push(productId);
  }

  // Collect every locator (org-level + per-product), dedup by match_key so the
  // per-org UNIQUE(org_id, match_key) can't trip within a single create. First
  // declaration wins; a product-scoped locator does not displace an identical
  // org-scoped one already claimed.
  const evidence = opts.evidence ?? null;
  const seen = new Set<string>();
  const rows: (typeof releaseLocations.$inferInsert)[] = [];
  const collect = (location: DeclaredLocation, productId: string | null) => {
    const row = locatorRow(location, {
      orgId: org.id,
      productId,
      basis: opts.basis,
      evidence,
      now,
    });
    if (seen.has(row.matchKey)) return;
    seen.add(row.matchKey);
    rows.push(row);
  };
  for (const location of input.locations ?? []) collect(location, null);
  (input.products ?? []).forEach((product, index) => {
    const productId = productIdByIndex[index] ?? null;
    for (const location of product.locations) collect(location, productId);
  });

  for (let i = 0; i < rows.length; i += RELEASE_LOCATIONS_INSERT_CHUNK_SIZE) {
    // onConflictDoNothing on the partial-unique (org_id, match_key): a fresh
    // create never conflicts (rows are deduped above), but it keeps a future
    // repair/re-sync pass safe to run over an already-populated stub.
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100-bind cap)
    await db
      .insert(releaseLocations)
      .values(rows.slice(i, i + RELEASE_LOCATIONS_INSERT_CHUNK_SIZE))
      .onConflictDoNothing();
  }

  logEvent("info", {
    component: "well-known",
    event: "stub-created",
    orgId: org.id,
    basis: opts.basis,
    productCount: productIdByIndex.length,
    locationCount: rows.length,
  });

  return { org, productCount: productIdByIndex.length, locationCount: rows.length };
}

function nextSlug(base: string, used: Set<string>): string {
  const normalized = toSlug(base) || "product";
  for (let attempt = 1; attempt <= 50; attempt++) {
    const candidate = attempt === 1 ? normalized : `${normalized}-${attempt}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `${normalized}-${crypto.randomUUID().slice(0, 8)}`;
  used.add(fallback);
  return fallback;
}

/** Map a validated domain manifest into {@link StubOrgInput}, resolving each
 *  category alias against the DB. Product/org taxonomy that doesn't resolve is
 *  dropped (null), never fatal — same leniency as the reconciler. */
export async function manifestToStubInput(
  db: Db,
  domain: string,
  config: ReleasesJsonDomain,
): Promise<StubOrgInput> {
  const resolveCategory = async (input: string | undefined): Promise<string | null> => {
    if (!input) return null;
    const result = await resolveCategoryInput(db, input);
    return result.ok ? result.slug : null;
  };

  const orgCategory = await resolveCategory(config.category);
  const productInputs: StubProductInput[] = [];
  for (const product of config.products ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- bounded by MAX_PRODUCTS; per-product alias resolution
    const category = await resolveCategory(product.category);
    productInputs.push({
      name: product.name,
      slug: product.slug,
      kind: product.kind ?? null,
      category,
      description: product.description ?? null,
      url: product.website ?? null,
      archived: product.archived === true,
      locations: product.releases ?? [],
    });
  }

  const socials = config.social
    ? Object.entries(config.social).map(([platform, handle]) => ({ platform, handle }))
    : [];

  return {
    name: config.name ?? domain,
    slug: toSlug(config.name ?? domain),
    domain,
    description: config.description ?? null,
    category: orgCategory,
    avatarUrl: config.avatar ?? null,
    tags: config.tags,
    socials,
    products: productInputs,
    locations: config.releases ?? [],
  };
}

export interface StubFromManifestResult {
  created: boolean;
  orgId?: string;
  skippedReason?: string;
  productCount?: number;
  locationCount?: number;
  /** Populated on dryRun: the input that WOULD be written. */
  plan?: StubOrgInput;
}

/**
 * Unlisted-domain path (#1947): a valid `.well-known/releases.json` on a domain
 * with no org yet → a stub org + declared locators (`basis: "declared"`).
 * Distinct from `syncOrgWellKnown`, which reconciles an EXISTING org and
 * materializes sources; this creates identity + locators only, no sources.
 *
 * Fail-closed and idempotent-ish: if the domain already resolves to an org (or
 * the manifest names a registry org), it skips rather than duplicating. A later
 * automatic trigger (#1910 activation) is the intended production caller; phase
 * 1 exposes it via POST /v1/orgs/stub-from-domain.
 */
export async function createStubFromManifest(
  db: Db,
  rawDomain: string,
  opts: {
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    dryRun?: boolean;
  } = {},
): Promise<StubFromManifestResult> {
  const domain = rawDomain.toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    return { created: false, skippedReason: "invalid_domain" };
  }

  // Guard: never shadow an existing org. Matches organizations.domain and any
  // domain alias (the two backends GET /v1/lookups/by-domain resolves through).
  const [existingOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.domain, domain), isNull(organizations.deletedAt)))
    .limit(1);
  if (existingOrg) return { created: false, skippedReason: "org_exists" };
  const [aliasOrg] = await db
    .select({ orgId: domainAliases.orgId })
    .from(domainAliases)
    .where(eq(domainAliases.domain, domain))
    .limit(1);
  if (aliasOrg) return { created: false, skippedReason: "org_exists" };

  const url = `https://${domain}/.well-known/releases.json`;
  const fetched = await fetchReleasesJson(url, { fetchImpl: opts.fetchImpl });
  if (!fetched.ok) {
    logEvent("info", {
      component: "well-known",
      event: "stub-fetch-skip",
      domain,
      reason: fetched.reason,
    });
    return { created: false, skippedReason: fetched.reason };
  }

  const validated = ReleasesJsonDomainSchema.safeParse(fetched.json);
  if (!validated.success) {
    logEvent("warn", { component: "well-known", event: "stub-validate-skip", domain });
    return { created: false, skippedReason: "invalid_schema" };
  }
  const config = validated.data;
  // A manifest that names a registry org is a claim on an existing/tracked org,
  // not an unlisted domain — leave it to the reconciler path.
  if (config.registries?.["releases.sh"]?.org) {
    return { created: false, skippedReason: "registry_org_declared" };
  }

  const input = await manifestToStubInput(db, domain, config);
  if (opts.dryRun) return { created: false, skippedReason: "dry_run", plan: input };

  try {
    const result = await createStubOrg(db, input, {
      basis: "declared",
      evidence: { domain, configHash: configHash(config) },
    });
    return {
      created: true,
      orgId: result.org.id,
      productCount: result.productCount,
      locationCount: result.locationCount,
    };
  } catch (err) {
    // ONLY a slug/domain UNIQUE race (a concurrent create won) is a skip — the
    // fail-closed label has to be accurate. Any other throw (CHECK violation,
    // transient D1 error) rethrows so the route surfaces a 5xx and a sweep
    // caller's own per-domain catch logs the real error, rather than every
    // failure masquerading as `slug_conflict`.
    if (isConflictError(err)) {
      logEvent("warn", { component: "well-known", event: "stub-create-conflict", domain });
      return { created: false, skippedReason: "slug_conflict" };
    }
    throw err;
  }
}
