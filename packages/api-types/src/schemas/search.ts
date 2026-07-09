import { z } from "zod";
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";
import {
  AppStoreSourceInfoSchema,
  MediaItemSchema,
  OrgStatusSchema,
  ReleaseTypeSchema,
  VideoSourceInfoSchema,
} from "./shared.js";
import { SourceTypeSchema } from "./sources.js";
import { LookupStatusSchema } from "./lookups.js";
import { CollectionMemberSchema } from "./collections.js";

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
  /**
   * Org tier (#1947/#2034). Optional for mid-deploy tolerance; absent ⇒
   * `"tracked"`. Lets search render the icon-only stub marker (#2031 parity).
   */
  status: OrgStatusSchema.optional(),
  /**
   * Org-level alternate domains (product-scoped aliases excluded, sorted),
   * for the `+N` hover on the origin domain — the anti-impersonation anchor
   * mirrored from the catalog row (#2031/#2034). Optional; absent ⇒ none.
   */
  aliasDomains: z.array(z.string()).optional(),
});

/**
 * Unified catalog entry — either a product row or a standalone source
 * presented as product-shaped. `entryType` discriminates between the two
 * row shapes (`"product"` vs `"source"`). `kind` carries the entity
 * taxonomy (platform/sdk/mobile/…). `entryType` (not `type`) because
 * source rows already carry `type: github|scrape|feed|agent` on the wire.
 */
export const SearchCatalogHitSchema = z.object({
  slug: z.string(),
  name: z.string(),
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable(),
  /** Owning org's avatar URL, for a small inline byline avatar. Products have
   *  no avatar of their own, so the web row anchors on the org's instead. */
  orgAvatarUrl: z.string().nullable().optional(),
  // Loose `z.string().nullable()` rather than the canonical `CategorySchema`
  // enum because `foldSourcesIntoCatalog` and the catalog-search handlers
  // pass `s.productCategory` / `o.category` through without validating
  // against `resolveCategoryInput`. Legacy rows may carry deprecated slugs
  // that haven't been migrated yet. Tighten once #689 (category overlay
  // backfill) lands across the prod data set.
  category: z.string().nullable(),
  entryType: z.enum(["product", "source"]),
  kind: z.enum(KIND_VALUES).nullable().optional(),
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
  stars: z.number().int().min(0).nullable().optional(),
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
  /**
   * App Store platform + icon for `type: "appstore"` sources, null/absent
   * otherwise. Powers the compact app-update treatment on the search card. #1206
   */
  appStore: AppStoreSourceInfoSchema.nullable().optional(),
  /**
   * Video provider tag for `type: "video"` sources, absent otherwise. Powers
   * the thumbnail-forward video row on search cards. #video
   */
  video: VideoSourceInfoSchema.nullable().optional(),
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable().optional(),
  /** Owning product slug — present when the source belongs to a product. Lets
   *  the web byline link to the product page instead of the source. */
  productSlug: z.string().nullable().optional(),
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
  coverageCount: z.number().int().min(0).optional(),
});

/**
 * Collection hit on the unified `/v1/search` response. Two origins are folded
 * into the same wire shape via the `via` discriminator:
 *
 * - `direct`  — the collection itself matched (name/description via LIKE in
 *               every mode, plus vector match in hybrid/semantic mode).
 * - `member`  — the collection was surfaced because one of the orgs that
 *               *did* match the query is a member of it; `matchedOrgSlugs`
 *               carries the subset of result-set org slugs that triggered
 *               the rollup so the UI can render an "includes X, Y" hint.
 *
 * `direct` rows always sort ahead of `member` rows; ties break on
 * `score` then `memberCount`. Slugs are unique across the array — a
 * direct hit that's also a member rollup keeps only the `direct` row
 * with `matchedOrgSlugs` carried over.
 */
export const SearchCollectionHitSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().min(0),
  via: z.enum(["direct", "member"]),
  /** Hybrid/semantic fusion score; absent on pure-lexical hits. */
  score: z.number().optional(),
  /** Result-set org slugs that triggered this rollup. Always present on `via=member`. */
  matchedOrgSlugs: z.array(z.string()).optional(),
  /**
   * A small org preview (capped at 3) for an inline avatar facepile on the
   * search card, mirroring the collections list page. Org-kind only — search's
   * `memberCount` counts orgs, so the facepile and its "+N more" stay
   * consistent. Attached after hit merge; optional on the wire so older workers
   * mid-rollout don't trip the schema.
   */
  previewMembers: z.array(CollectionMemberSchema).optional(),
});

/**
 * Heading-aware CHANGELOG.md slice returned by hybrid / semantic search.
 * Clients can deep-link to
 * `/<orgSlug>/<sourceSlug>/changelog?offset=<offset>#chunk` to read the
 * surrounding file content (the web `chunkDeepLink` builder; falls back to
 * the `/source/<sourceSlug>` redirect shim when `orgSlug` is null).
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
      stars: z.number().int().min(0).nullable().optional(),
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
  /**
   * Curated collections matching the query, either directly (name/description
   * match or vector hit) or via member rollup (one of the result orgs is in
   * the collection). Optional on the wire so older workers mid-rollout don't
   * trip the schema check; clients should treat missing and `[]` identically.
   */
  collections: z.array(SearchCollectionHitSchema).optional(),
  chunks: z.array(SearchChunkHitSchema).optional(),
  mode: z.enum(["lexical", "semantic", "hybrid"]).optional(),
  degraded: z.boolean().optional(),
  degradedReason: z.string().optional(),
  lookup: LookupResultPayloadSchema.nullable().optional(),
});
