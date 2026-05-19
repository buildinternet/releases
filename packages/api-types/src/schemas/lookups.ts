import { z } from "zod";
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";
import { CategorySchema } from "./shared.js";

/**
 * Status flags returned by `POST /v1/lookups`:
 * - `indexed` — the source was just materialized and releases were ingested.
 * - `existing` — the source already lives in the registry; we returned it as-is.
 * - `empty` — the repo exists but has no releases or CHANGELOG to ingest. A
 *   hidden stub row is left behind so the next cron pass can pick it up.
 * - `not_found` — the repo doesn't exist, is archived, or isn't reachable.
 * - `deferred` — GitHub probe rate-limited or 5xx'd; the next cron pass retries.
 */
export const LookupStatusSchema = z.enum(["indexed", "existing", "empty", "not_found", "deferred"]);

/** Body accepted by `POST /v1/lookups`. v1 only supports GitHub coordinates. */
export const LookupBodySchema = z.object({
  provider: z.literal("github"),
  coordinate: z.string().regex(/^[^/\s]+\/[^/\s]+$/, {
    message: "coordinate must match {org}/{repo}",
  }),
});

/**
 * Source row embedded in `LookupResponse`. The handler returns the full
 * Drizzle row, so `z.looseObject(...)` lets stable fields stay typed while
 * letting timestamps/counters that aren't load-bearing for callers ride
 * along unmodelled. Same pattern as `SourceMutationResponseSchema`.
 */
export const LookupSourceSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: z.string(),
  url: z.string(),
  orgId: z.string().nullable(),
  productId: z.string().nullable(),
  isHidden: z.boolean().nullable().optional(),
  discovery: z.enum(["curated", "agent", "on_demand"]).optional(),
  metadata: z.string().nullable(),
  createdAt: z.string().optional(),
});

/** Release row embedded in `LookupResponse.releases`. Loose for the same reason as `LookupSourceSchema`. */
export const LookupReleaseSchema = z.looseObject({
  id: z.string(),
  sourceId: z.string(),
  version: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
});

/** "Did you mean" rail returned alongside not_found / empty / deferred outcomes. */
export const LookupRelatedOrgSchema = z
  .object({
    org: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    sources: z.array(
      z.object({ id: z.string(), slug: z.string(), name: z.string(), url: z.string() }),
    ),
  })
  .nullable();

/**
 * Response returned by `POST /v1/lookups`. The `source` and `releases` fields
 * are populated for `indexed` / `existing` outcomes; `empty` populates only
 * `source`; `not_found` / `deferred` populate neither.
 */
export const LookupResponseSchema = z.object({
  status: LookupStatusSchema,
  source: LookupSourceSchema.optional(),
  releases: z.array(LookupReleaseSchema).optional(),
  relatedOrg: LookupRelatedOrgSchema,
});

/** Response from `GET /v1/lookups/source-by-slug?slug=…`. */
export const LookupSourceBySlugResponseSchema = z.object({
  sourceId: z.string(),
  sourceSlug: z.string(),
  orgSlug: z.string(),
});

/** Response from `GET /v1/lookups/product-by-slug?slug=…`. */
export const LookupProductBySlugResponseSchema = z.object({
  productId: z.string(),
  productSlug: z.string(),
  orgSlug: z.string(),
});

/**
 * Response from `GET /v1/lookups/by-domain?domain=…`. Pure resolution: an
 * unknown domain returns 404, never probes. Both an org and product list can
 * be present when a product alias points at the same domain its parent org
 * owns.
 */
export const DomainLookupOrgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  matchedVia: z.enum(["primary", "alias"]),
});

export const DomainLookupProductSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  orgId: z.string(),
  orgSlug: z.string(),
  orgName: z.string(),
  // Reuses the canonical `CategorySchema` enum because the products read
  // path resolves through `resolveCategoryInput` before persisting — unlike
  // the search catalog category, which passes the column through raw.
  category: CategorySchema.nullable(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
});

export const DomainLookupResponseSchema = z.object({
  domain: z.string(),
  org: DomainLookupOrgSchema.nullable(),
  products: z.array(DomainLookupProductSchema),
});
