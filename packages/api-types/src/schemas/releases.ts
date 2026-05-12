import { z } from "zod";
import { SOURCE_TYPES } from "@buildinternet/releases-core/source-enums";
import { MediaItemSchema, ReleaseTypeSchema } from "./shared.js";

/**
 * Per-row shape returned by `GET /v1/releases/latest`. Distinct from the
 * shared `ReleaseItemSchema` because the latest-feed handler joins the
 * source row in and exposes it as a nested `source` object instead of
 * leaving the caller to do a second lookup.
 *
 * `type` is required here — the latest handler reads it directly from
 * `releases.type` (NOT NULL with DB-default `'feature'`), so mid-deploy
 * degrade-gracefully nullability doesn't apply on this path.
 */
export const ReleaseLatestSourceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  type: z.enum(SOURCE_TYPES),
  orgSlug: z.string().nullable(),
});

export const ReleaseLatestItemSchema = z.object({
  id: z.string(),
  version: z.string().nullable(),
  type: ReleaseTypeSchema,
  title: z.string(),
  summary: z.string().nullable(),
  titleGenerated: z.string().nullable(),
  titleShort: z.string().nullable(),
  publishedAt: z.string().nullable(),
  url: z.string().nullable(),
  media: z.array(MediaItemSchema),
  source: ReleaseLatestSourceSchema,
});

export const ReleaseLatestResponseSchema = z.object({
  releases: z.array(ReleaseLatestItemSchema),
});

/**
 * Single row of the `release_coverage` join table. Drives the
 * GET /releases/:id/coverage response.
 */
export const ReleaseCoverageRowSchema = z.object({
  coverageId: z.string(),
  canonicalId: z.string(),
  reason: z.string().nullable(),
  decidedBy: z.string(),
  decidedAt: z.string(),
});

/**
 * Discriminated by `role`:
 * - `standalone` — release is neither canonical nor coverage of anything.
 * - `coverage` — release is coverage rolling up to `canonical`.
 * - `canonical` — release is the canonical row; `covers` enumerates rollups.
 */
export const ReleaseCoverageResponseSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("standalone"),
    canonical: z.null(),
    covers: z.array(z.never()).length(0),
  }),
  z.object({
    role: z.literal("coverage"),
    canonical: ReleaseCoverageRowSchema,
    covers: z.array(z.never()).length(0),
  }),
  z.object({
    role: z.literal("canonical"),
    canonical: z.null(),
    covers: z.array(ReleaseCoverageRowSchema),
  }),
]);

/**
 * Body accepted by `POST /v1/releases/:id/coverage`. `decidedBy` MUST be
 * prefixed with `human:` or `agent:` so the audit trail records who linked
 * the rows; the handler enforces this with a regex.
 */
export const LinkReleaseCoverageBodySchema = z.object({
  coverageIds: z.array(z.string()).min(1),
  reason: z.string().nullable().optional(),
  decidedBy: z.string().regex(/^(human:|agent:)/),
});

export const LinkReleaseCoverageResponseSchema = z.object({
  canonicalId: z.string(),
  coverageIds: z.array(z.string()),
  linked: z.number().int().min(0),
});

/**
 * Response for `DELETE /v1/releases/:id/coverage`. Idempotent — the handler
 * returns `{ unlinked: false }` when the release isn't in a cluster, so the
 * remote client can skip a brittle error-message sniff.
 */
export const UnlinkReleaseCoverageResponseSchema = z.object({
  unlinked: z.boolean(),
});

/**
 * Row returned by `GET /v1/releases?hasMedia=true`. Internal/admin escape
 * hatch consumed by the `media backfill` CLI command.
 */
export const ReleaseWithMediaRowSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  media: z.string().nullable(),
});

export const ReleasesWithMediaResponseSchema = z.array(ReleaseWithMediaRowSchema);
