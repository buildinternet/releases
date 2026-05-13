import { z } from "zod";
import { MediaItemSchema, ReleaseTypeSchema } from "./shared.js";
import { SourceTypeSchema } from "./sources.js";
import { LookupStatusSchema } from "./lookups.js";

/**
 * Org hit on the unified `/v1/search` response. The list is built either
 * from `searchOrgs` LIKE matches or, when `?domain=` resolves, from a
 * single-row "scoped org" projection — both produce the same wire shape.
 *
 * `category` is loose (`z.string().nullable()`) rather than the canonical
 * `CategorySchema` enum because the scoped-org projection passes the raw
 * DB column through without going through `resolveCategoryInput`; legacy
 * rows may carry deprecated slugs that haven't been migrated yet. Tighten
 * once #689 (category overlay backfill) lands across the prod data set.
 */
export const SearchOrgHitSchema = z.object({
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  category: z.string().nullable(),
});

/**
 * Unified catalog entry — either a product row or a standalone source
 * presented as product-shaped. `kind` routes clicks to the right URL but
 * the two forms are otherwise interchangeable for display. `kind` (not
 * `type`) because source rows already carry
 * `type: github|scrape|feed|agent` on the wire.
 */
export const SearchCatalogHitSchema = z.object({
  slug: z.string(),
  name: z.string(),
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable(),
  // Loose `z.string().nullable()` rather than the canonical `CategorySchema`
  // enum because `foldSourcesIntoCatalog` and the catalog-search handlers
  // pass `s.productCategory` / `o.category` through without validating
  // against `resolveCategoryInput`. Legacy rows may carry deprecated slugs
  // that haven't been migrated yet. Tighten once #689 (category overlay
  // backfill) lands across the prod data set.
  category: z.string().nullable(),
  kind: z.enum(["product", "source"]),
  sourceSlug: z.string().optional(),
  sourceType: SourceTypeSchema.optional(),
});

export const SearchSourceHitSchema = z.object({
  slug: z.string(),
  name: z.string(),
  type: SourceTypeSchema,
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable(),
  productSlug: z.string().nullable(),
});

export const SearchReleaseHitSchema = z.object({
  id: z.string(),
  sourceSlug: z.string(),
  sourceName: z.string(),
  // Loose `z.string()` rather than `SourceTypeSchema` because the
  // release-hit hydration path reads `sources.type` straight from the DB
  // without re-validating; legacy rows occasionally drift from the
  // canonical four-value set. Used by the web byline icon.
  sourceType: z.string().optional(),
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable().optional(),
  version: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  titleGenerated: z.string().nullable().optional(),
  titleShort: z.string().nullable().optional(),
  content: z.string().optional(),
  media: z.array(MediaItemSchema).optional(),
  publishedAt: z.string().nullable(),
  // Hybrid fusion score; absent on pure-lexical results.
  score: z.number().optional(),
  type: ReleaseTypeSchema.optional(),
});

/**
 * Heading-aware CHANGELOG.md slice returned by hybrid / semantic search.
 * Clients can deep-link to
 * `/source/<sourceSlug>?tab=changelog&offset=<offset>` to read the
 * surrounding file content.
 */
export const SearchChunkHitSchema = z.object({
  sourceSlug: z.string(),
  sourceName: z.string(),
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable().optional(),
  filePath: z.string(),
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
  heading: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
});

/**
 * Slim wire payload embedded in a search response when the query is a
 * GitHub `org/repo` coordinate and no existing entity matched. Reuses
 * `LookupStatusSchema` from `./lookups.js` rather than redefining — the
 * thick `POST /v1/lookups` response and the slim search-embedded payload
 * share the same status set.
 */
export const LookupResultPayloadSchema = z.object({
  status: LookupStatusSchema,
  source: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      url: z.string(),
      discovery: z.enum(["curated", "agent", "on_demand"]),
    })
    .optional(),
  releases: z
    .array(
      z.object({
        id: z.string(),
        version: z.string().nullable(),
        title: z.string(),
        publishedAt: z.string().nullable(),
      }),
    )
    .optional(),
  // Unambiguous "did you mean" rail; null when the org segment matches
  // multiple curated orgs or none.
  relatedOrg: z
    .object({
      org: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
      sources: z.array(
        z.object({ id: z.string(), slug: z.string(), name: z.string(), url: z.string() }),
      ),
    })
    .nullable(),
});

export const UnifiedSearchResponseSchema = z.object({
  query: z.string(),
  // Normalized `?domain=` echo + resolution outcome. Both absent when no
  // domain filter was applied.
  domain: z.string().optional(),
  domainStatus: z.enum(["matched", "not_found"]).optional(),
  orgs: z.array(SearchOrgHitSchema),
  catalog: z.array(SearchCatalogHitSchema),
  sources: z.array(SearchSourceHitSchema),
  releases: z.array(SearchReleaseHitSchema),
  chunks: z.array(SearchChunkHitSchema).optional(),
  mode: z.enum(["lexical", "semantic", "hybrid"]).optional(),
  degraded: z.boolean().optional(),
  degradedReason: z.string().optional(),
  lookup: LookupResultPayloadSchema.nullable().optional(),
});
