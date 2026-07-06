import { and, eq, isNull } from "drizzle-orm";
import {
  organizations,
  products,
  sources,
  releaseLocations,
} from "@buildinternet/releases-core/schema";
import type {
  ReleasesJsonDomain,
  ReleasesJsonProduct,
  ReleasesJsonDomainRelease,
} from "@buildinternet/releases-api-types";
import { isValidKind } from "@buildinternet/releases-core/kinds";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { logEvent } from "@releases/lib/log-event";
import type { createDb } from "../../db.js";
import {
  reconcileDomainEntities,
  locationMatchesSource,
  type DeclaredLocation,
  type EntityMaterializationPlan,
  type MaterializationOptions,
} from "./materialize.js";

type Db = ReturnType<typeof createDb>;

export interface PromoteStubResult {
  promoted: boolean;
  /** True when the org was already `tracked` — a no-op success (idempotent). */
  alreadyTracked?: boolean;
  sourcesCreated: number;
  sourcesMatched: number;
  /** release_locations rows stamped with the source they materialized into. */
  locatorsStamped: number;
  /** The materialization plan (also the whole payload under dryRun). */
  plan?: EntityMaterializationPlan;
}

/** Turn a stored locator row back into the wire locator shape the materializer
 *  consumes. Only set keys are emitted so the discriminator stays clean. */
function rowToRelease(row: typeof releaseLocations.$inferSelect): ReleasesJsonDomainRelease {
  return {
    ...(row.url ? { url: row.url } : {}),
    ...(row.feed ? { feed: row.feed } : {}),
    ...(row.github ? { github: row.github } : {}),
    ...(row.appstore ? { appstore: row.appstore } : {}),
    ...(row.file ? { file: row.file } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.canonical ? { canonical: true } : {}),
  } as ReleasesJsonDomainRelease;
}

/**
 * Promote a stub org to `tracked` (#1947). Reconstructs a domain manifest from
 * the org's stored `release_locations` (+ existing products) and runs the
 * shipped `reconcileDomainEntities` pipeline over it — probing tier-1 locators
 * (feed/github/appstore) into live sources and pending tier-2 (bare url/file)
 * as paused sources for curator review, exactly as owner-declared
 * materialization does. Each created/matched source is then stamped back onto
 * its locator row (`source_id`), and the org flips to `tier: "tracked"`.
 *
 * Locators are NOT consumed — they stay as the durable declared record so
 * demotion (sources removed → back to stub) is symmetric and lossless.
 *
 * Idempotent: an already-`tracked` org is a no-op success; a re-run of a
 * partially-promoted stub matches its existing sources (no duplicates) and
 * re-stamps. Materialization is forced on (`enabled: true`) — promotion is an
 * explicit admin action, distinct from the flag that gates automatic sweeps.
 */
export async function promoteStubOrg(
  db: Db,
  orgId: string,
  opts: {
    dryRun?: boolean;
    fetchImpl?: typeof fetch;
    githubToken?: string;
    probe?: MaterializationOptions["probe"];
  } = {},
): Promise<PromoteStubResult> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new Error(`org not found: ${orgId}`);
  if (org.tier === "tracked") {
    return {
      promoted: false,
      alreadyTracked: true,
      sourcesCreated: 0,
      sourcesMatched: 0,
      locatorsStamped: 0,
    };
  }

  const [locators, productRows] = await Promise.all([
    db
      .select()
      .from(releaseLocations)
      .where(and(eq(releaseLocations.orgId, orgId), isNull(releaseLocations.deletedAt))),
    db
      .select()
      .from(products)
      .where(and(eq(products.orgId, orgId), isNull(products.deletedAt))),
  ]);

  // Rebuild the manifest: product-scoped locators nest under their product;
  // the rest ride the top-level releases[]. reconcileDomainEntities matches the
  // existing products by name (they already exist), so no duplicates are made.
  const productManifest: ReleasesJsonProduct[] = productRows.map((product) => ({
    name: product.name,
    slug: product.slug,
    ...(product.description ? { description: product.description } : {}),
    ...(product.url ? { website: product.url } : {}),
    ...(product.category ? { category: product.category } : {}),
    ...(product.kind && isValidKind(product.kind) ? { kind: product.kind } : {}),
    releases: locators.filter((l) => l.productId === product.id).map(rowToRelease),
  }));
  // A locator's product_id is only nulled on HARD delete, so a locator pointing
  // at a soft-deleted (tombstoned) product still carries the dead id — and
  // `productRows` excludes tombstoned products. Treat any locator whose product
  // is missing from the active set as top-level, else it'd be dropped from both
  // the product manifest and releases[] and never materialize on promotion.
  const activeProductIds = new Set(productRows.map((p) => p.id));
  const topLevelReleases = locators
    .filter((l) => l.productId === null || !activeProductIds.has(l.productId))
    .map(rowToRelease);

  const manifest: ReleasesJsonDomain = {
    version: 2,
    ...(org.name ? { name: org.name } : {}),
    ...(productManifest.length > 0 ? { products: productManifest } : {}),
    ...(topLevelReleases.length > 0 ? { releases: topLevelReleases } : {}),
  };

  const { plan } = await reconcileDomainEntities(db, orgId, manifest, {
    dryRun: opts.dryRun === true,
    // Forced on: promotion is an explicit admin action, not subject to the
    // sweep-facing WELL_KNOWN_MATERIALIZATION_ENABLED gate.
    enabled: true,
    source: "well-known",
    fetchImpl: opts.fetchImpl,
    githubToken: opts.githubToken,
    probe: opts.probe,
    resolveCategory: async (input) => {
      const result = await resolveCategoryInput(db, input);
      return result.ok ? result.slug : null;
    },
  });

  const sourcesCreated = plan.sources.filter((s) => s.action === "create").length;
  const sourcesMatched = plan.sources.filter((s) => s.action === "match").length;

  if (opts.dryRun) {
    return { promoted: false, sourcesCreated, sourcesMatched, locatorsStamped: 0, plan };
  }

  // Stamp each locator with the source it materialized into, matched via the
  // same primitive the materializer uses. Idempotent — re-stamps to the same id.
  const orgSources = await db
    .select()
    .from(sources)
    .where(and(eq(sources.orgId, orgId), isNull(sources.deletedAt)));
  let locatorsStamped = 0;
  for (const locator of locators) {
    const location = rowToRelease(locator) as DeclaredLocation;
    const match = orgSources.find((source) => locationMatchesSource(location, source));
    if (!match || locator.sourceId === match.id) continue;
    // oxlint-disable-next-line no-await-in-loop -- per-locator stamp; bounded by the org's locator count
    await db
      .update(releaseLocations)
      .set({ sourceId: match.id, updatedAt: new Date().toISOString() })
      .where(eq(releaseLocations.id, locator.id));
    locatorsStamped++;
  }

  await db
    .update(organizations)
    .set({ tier: "tracked", updatedAt: new Date().toISOString() })
    .where(eq(organizations.id, orgId));

  logEvent("info", {
    component: "well-known",
    event: "stub-promoted",
    orgId,
    sourcesCreated,
    sourcesMatched,
    locatorsStamped,
  });

  return { promoted: true, sourcesCreated, sourcesMatched, locatorsStamped, plan };
}
