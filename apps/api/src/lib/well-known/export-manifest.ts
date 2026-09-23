import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  organizations,
  orgTags,
  productTags,
  products,
  sources,
  tags,
} from "@buildinternet/releases-core/schema";
import { isValidKind } from "@buildinternet/releases-core/kinds";
import type {
  ReleasesJsonDomain,
  ReleasesJsonDomainRelease,
  ReleasesJsonProduct,
} from "@buildinternet/releases-api-types";
import type { createDb } from "../../db.js";

type Db = ReturnType<typeof createDb>;
type OrgRow = typeof organizations.$inferSelect;
type SourceRow = typeof sources.$inferSelect;

/**
 * Reconstruct an owner-declared `releases.json` v2 **domain manifest** from an
 * org's live registry data — the inverse of the well-known materializer, and
 * the single source of truth behind `GET /v1/orgs/:slug/manifest`, the
 * `releases json export` CLI command, and the `export-org-manifest` script.
 *
 * Projects from live `products` + `sources` (not `release_locations`, which is
 * populated only for stub/manifest-originated orgs — see promote.ts), so it
 * covers every tracked org regardless of onboarding path. Each source maps to a
 * single locator following the same discriminator precedence the fetch planner
 * uses (`packages/adapters/src/fetch-plan.ts`):
 *
 *   github   ← source.type === "github"  OR  metadata.githubUrl set
 *   appstore ← source.type === "appstore"
 *   feed     ← metadata.feedUrl set
 *   url      ← everything else (scrape / agent / video / crawl)
 *
 * A source nests under its product (via `product_id`) or, if unlinked, rides
 * the top-level `releases[]`. `is_primary` becomes `canonical: true` (deduped
 * to one per array, all the schema allows). The output validates against
 * `ReleasesJsonDomainSchema`, so it round-trips through the fill-if-empty
 * well-known sweep for upstream enrichment.
 *
 * Hidden and soft-deleted sources/products are excluded — the manifest is a
 * public, owner-facing artifact.
 */
export async function buildOrgManifest(db: Db, org: OrgRow): Promise<ReleasesJsonDomain> {
  const [productRows, sourceRows, orgTagNames] = await Promise.all([
    db
      .select()
      .from(products)
      .where(and(eq(products.orgId, org.id), isNull(products.deletedAt))),
    db
      .select()
      .from(sources)
      .where(
        and(eq(sources.orgId, org.id), isNull(sources.deletedAt), eq(sources.isHidden, false)),
      ),
    db
      .select({ name: tags.name })
      .from(orgTags)
      .innerJoin(tags, eq(orgTags.tagId, tags.id))
      .where(eq(orgTags.orgId, org.id)),
  ]);

  const productIds = productRows.map((p) => p.id);
  const productTagMap = await loadProductTags(db, productIds);

  // Bucket each source's locator under its product, or top-level when unlinked
  // (or pointing at a tombstoned product no longer in the active set).
  const activeProductIds = new Set(productIds);
  const byProduct = new Map<string, ReleasesJsonDomainRelease[]>();
  const topLevel: ReleasesJsonDomainRelease[] = [];
  for (const source of sourceRows) {
    const locator = sourceToLocator(source);
    if (!locator) continue;
    if (source.productId && activeProductIds.has(source.productId)) {
      const bucket = byProduct.get(source.productId) ?? [];
      bucket.push(locator);
      byProduct.set(source.productId, bucket);
    } else {
      topLevel.push(locator);
    }
  }

  const manifestProducts: ReleasesJsonProduct[] = productRows.map((p) => {
    const releases = dedupeCanonical(byProduct.get(p.id) ?? []);
    const kind = p.kind && isValidKind(p.kind) ? p.kind : undefined;
    const productTagNames = productTagMap.get(p.id) ?? [];
    return {
      name: p.name,
      slug: p.slug,
      ...(kind ? { kind } : {}),
      ...(p.category ? { category: p.category } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.url ? { website: p.url } : {}),
      ...(productTagNames.length > 0 ? { tags: productTagNames } : {}),
      ...(releases.length > 0 ? { releases } : {}),
    } as ReleasesJsonProduct;
  });

  const dedupedTop = dedupeCanonical(topLevel);
  const avatar = org.avatarUrl && org.avatarUrl.startsWith("https://") ? org.avatarUrl : undefined;

  return {
    version: 2,
    ...(org.name ? { name: org.name } : {}),
    ...(org.description ? { description: org.description } : {}),
    ...(org.category ? { category: org.category } : {}),
    ...(avatar ? { avatar } : {}),
    ...(orgTagNames.length > 0 ? { tags: orgTagNames.map((t) => t.name) } : {}),
    ...(manifestProducts.length > 0 ? { products: manifestProducts } : {}),
    ...(dedupedTop.length > 0 ? { releases: dedupedTop } : {}),
  } as ReleasesJsonDomain;
}

/** Batch-load product → tag-name[] for the given product ids (one query). */
async function loadProductTags(db: Db, productIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (productIds.length === 0) return map;
  const rows = await db
    .select({ productId: productTags.productId, name: tags.name })
    .from(productTags)
    .innerJoin(tags, eq(productTags.tagId, tags.id))
    .where(inArray(productTags.productId, productIds));
  for (const row of rows) {
    const list = map.get(row.productId) ?? [];
    list.push(row.name);
    map.set(row.productId, list);
  }
  return map;
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "https://github.com/owner/repo(.git)" | "owner/repo" → "owner/repo". */
function githubCoord(value: string): string | null {
  const m = value.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  const [owner, repo] = m ? [m[1], m[2]] : value.split("/");
  if (!owner || !repo) return null;
  return `${owner}/${repo.replace(/\.git$/i, "")}`;
}

/** Project one source row onto a single locator, or null when none can be derived. */
function sourceToLocator(source: SourceRow): ReleasesJsonDomainRelease | null {
  const meta = parseMeta(source.metadata);
  const githubUrl = typeof meta.githubUrl === "string" ? meta.githubUrl : undefined;
  const feedUrl = typeof meta.feedUrl === "string" ? meta.feedUrl : undefined;

  let base: ReleasesJsonDomainRelease | null = null;
  if (source.type === "github" || githubUrl) {
    const coord = githubCoord(githubUrl ?? source.url);
    if (coord) base = { github: coord };
    else if (source.url) base = { url: source.url }; // github override w/o parseable coord
  } else if (source.type === "appstore" && source.url) {
    base = { appstore: source.url };
  } else if (feedUrl) {
    base = { feed: feedUrl };
  } else if (source.url) {
    base = { url: source.url };
  }
  if (!base) return null;
  if (source.isPrimary) base.canonical = true;
  return base;
}

/** Enforce the schema's ≤1-canonical-per-array rule: keep the first, drop the rest. */
function dedupeCanonical(locators: ReleasesJsonDomainRelease[]): ReleasesJsonDomainRelease[] {
  let seen = false;
  return locators.map((loc) => {
    if (!loc.canonical) return loc;
    if (seen) {
      const { canonical: _drop, ...rest } = loc;
      return rest as ReleasesJsonDomainRelease;
    }
    seen = true;
    return loc;
  });
}
