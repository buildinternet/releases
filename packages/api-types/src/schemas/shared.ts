import { z } from "zod";
import { RELEASE_TYPES } from "@buildinternet/releases-core/schema";
import { CATEGORIES } from "@buildinternet/releases-core/categories";

export const CategorySchema = z.enum(CATEGORIES);

export const MediaItemSchema = z.object({
  type: z.enum(["image", "video", "gif"]),
  url: z.string(),
  alt: z.string().optional(),
  r2Url: z.string().optional(),
});

export const PaginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  returned: z.number().int().min(0),
  totalItems: z.number().int().min(0).optional(),
  totalPages: z.number().int().min(0).optional(),
  hasMore: z.boolean(),
});

export const ListResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    pagination: PaginationSchema,
  });

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export const StatsSchema = z.object({
  orgs: z.number().int().min(0),
  sources: z.number().int().min(0),
  releases: z.number().int().min(0),
  products: z.number().int().min(0),
});

export const ReleaseTypeSchema = z.enum(RELEASE_TYPES);

export const ReleaseItemSchema = z.object({
  id: z.string().optional(),
  version: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  content: z.string().optional(),
  publishedAt: z.string().nullable(),
  url: z.string().nullable(),
  media: z.array(MediaItemSchema).optional(),
  // `.optional()` — older API responses (mid-deploy or pinned old workers)
  // may omit `type`; consumers should treat `undefined` as `"feature"`.
  type: ReleaseTypeSchema.optional(),
  // Pre-release flag (alpha/beta/rc/preview/nightly). Computed at ingest —
  // GitHub uses the API's authoritative `prerelease` field; other adapters
  // fall back to a SemVer-prerelease regex. `.optional()` for the same
  // older-response degrade-gracefully reason as `type`.
  prerelease: z.boolean().optional(),
  // AI-generated headline forms paired with `summary` (#852, renamed in #860).
  // Both nullable — most rows in the DB have neither populated, and we don't
  // plan to backfill, so consumers must fall back to `title` for display.
  // `.optional()` for the same mid-deploy / pinned-worker reason as `type`.
  titleGenerated: z.string().nullable().optional(),
  titleShort: z.string().nullable().optional(),
  /** @deprecated Use `titleGenerated`. Kept as an alias populated with the same value. */
  contentTitle: z.string().nullable().optional(),
  /** @deprecated Use `titleShort`. Kept as an alias populated with the same value. */
  contentTitleShort: z.string().nullable().optional(),
});

export const ReleaseSummaryItemSchema = z.object({
  year: z.number().int().nullable().optional(),
  month: z.number().int().nullable().optional(),
  windowDays: z.number().int().nullable().optional(),
  summary: z.string(),
  releaseCount: z.number().int().min(0),
  generatedAt: z.string(),
});

/**
 * Inline citation attached to an overview page (#846). Each row maps a
 * character span in `OverviewPageItem.content` back to a release URL the
 * model cited via Anthropic's search_result blocks. Optional everywhere it
 * appears — pages generated before #846 lands have none, and consumers
 * should degrade gracefully.
 */
export const OverviewCitationSchema = z.object({
  startIndex: z.number().int().min(0),
  endIndex: z.number().int().min(0),
  sourceUrl: z.string(),
  title: z.string().nullable().optional(),
  citedText: z.string(),
  releaseId: z.string().nullable().optional(),
});

export const OverviewPageItemSchema = z.object({
  scope: z.enum(["org", "product"]),
  orgSlug: z.string().nullable().optional(),
  productSlug: z.string().nullable().optional(),
  content: z.string(),
  releaseCount: z.number().int().min(0),
  lastContributingReleaseAt: z.string().nullable(),
  generatedAt: z.string(),
  updatedAt: z.string(),
  citations: z.array(OverviewCitationSchema).optional(),
});
