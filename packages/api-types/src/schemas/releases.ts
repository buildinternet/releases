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

/**
 * Nested org context joined into the `GET /v1/releases/:id` response.
 * Both fields are nullable — releases whose source has no org attached
 * return `null` for this object entirely.
 */
export const ReleaseDetailOrgSchema = z.object({
  slug: z.string(),
  name: z.string(),
});

/**
 * Full release detail returned by `GET /v1/releases/:id`. Joins source
 * name/slug/type and a nullable org object; media is parsed from the raw
 * JSON stored in D1 and typed URLs are rewritten to the CDN origin. The
 * route only surfaces non-suppressed, non-coverage rows (filtered via the
 * `releases_visible` view).
 */
export const ReleaseDetailResponseSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  version: z.string().nullable(),
  type: ReleaseTypeSchema,
  title: z.string(),
  content: z.string(),
  summary: z.string().nullable(),
  titleGenerated: z.string().nullable(),
  titleShort: z.string().nullable(),
  url: z.string().nullable(),
  contentHash: z.string().nullable(),
  media: z.array(MediaItemSchema),
  publishedAt: z.string().nullable(),
  suppressed: z.boolean().nullable(),
  suppressedReason: z.string().nullable(),
  prerelease: z.boolean().nullable(),
  fetchedAt: z.string().nullable(),
  sourceName: z.string().nullable(),
  sourceSlug: z.string().nullable(),
  sourceType: z.enum(SOURCE_TYPES).nullable(),
  org: ReleaseDetailOrgSchema.nullable(),
});

/**
 * Body accepted by `PATCH /v1/releases/:id`. All fields are optional;
 * omitted fields are not updated. AI-generated fields (`summary`,
 * `titleGenerated`, `titleShort`) accept `null` to explicitly clear the
 * stored value.
 */
export const UpdateReleaseBodySchema = z.object({
  title: z.string().optional(),
  version: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
  publishedAt: z.string().optional(),
  contentHash: z.string().optional(),
  summary: z.string().nullable().optional(),
  titleGenerated: z.string().nullable().optional(),
  titleShort: z.string().nullable().optional(),
});

/**
 * Response returned by `PATCH /v1/releases/:id`. The handler returns the raw
 * Drizzle row from the `releases` table — distinct from the augmented
 * `ReleaseDetailResponseSchema` shape served by `GET /v1/releases/:id`, which
 * adds joined source/org metadata and parses `media` from raw JSON. Clients
 * that need the augmented shape after an edit should re-fetch via GET.
 */
export const ReleasePatchResponseSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  version: z.string().nullable(),
  type: ReleaseTypeSchema,
  title: z.string(),
  content: z.string(),
  summary: z.string().nullable(),
  titleGenerated: z.string().nullable(),
  titleShort: z.string().nullable(),
  url: z.string().nullable(),
  contentHash: z.string().nullable(),
  metadata: z.string().nullable(),
  // Raw JSON string of the media array — not parsed at this endpoint.
  media: z.string().nullable(),
  publishedAt: z.string().nullable(),
  prerelease: z.boolean().nullable(),
  suppressed: z.boolean().nullable(),
  suppressedReason: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  embeddedAt: z.string().nullable(),
});

/** Response returned by `DELETE /v1/releases/:id`. */
export const ReleaseDeleteResponseSchema = z.object({
  deleted: z.literal(true),
});

/** Response returned by `POST /v1/releases/:id/suppress`. */
export const ReleaseSuppressResponseSchema = z.object({
  suppressed: z.literal(true),
});

/** Response returned by `POST /v1/releases/:id/unsuppress`. */
export const ReleaseUnsuppressResponseSchema = z.object({
  unsuppressed: z.literal(true),
});

/**
 * Body accepted by `POST /v1/releases/:id/suppress`. The `reason` field
 * is optional; when omitted the stored `suppressed_reason` is set to null.
 */
export const ReleaseSuppressBodySchema = z.object({
  reason: z.string().optional(),
});

/**
 * WebSocket message schema for the `GET /v1/releases/stream` endpoint.
 * Each message is a JSON object with one of the following shapes:
 * - `{ type: "ready", seq: number }` — sent on connect to give the caller
 *   the current head sequence number for later resume.
 * - `{ type: "release.created", seq: number, release: object }` — a new
 *   release was indexed; `release` carries the full release row.
 * - `{ type: "snapshot_gap" }` — the requested `since` sequence fell
 *   behind the oldest buffered event; the client must REST-backfill.
 */
export const ReleaseStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), seq: z.number().int() }),
  z.object({
    type: z.literal("release.created"),
    seq: z.number().int(),
    release: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("snapshot_gap") }),
]);
