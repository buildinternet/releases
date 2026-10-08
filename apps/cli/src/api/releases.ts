import type {
  Release,
  ReleaseSummary,
  NewReleaseSummary,
  ReleaseType,
} from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import type { ReleaseWithSource, LatestRelease } from "./types.js";
import { apiFetch, toLatestRelease } from "./core.js";
import type { LatestReleaseWire } from "./core.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { findProduct } from "./products.js";
import { assertCleanIdentifier } from "../lib/validate-input.js";

// ── Release CRUD ──

export async function getRelease(id: string): Promise<ReleaseWithSource | null> {
  // `id` is interpolated unencoded below, so harden it: a hallucinated
  // `../../…` would otherwise traverse the API path.
  assertCleanIdentifier(id, "release id");
  return apiFetch<ReleaseWithSource | null>(`/v1/releases/${encodeURIComponent(id)}`);
}

export async function deleteRelease(id: string): Promise<boolean> {
  const result = await apiFetch<{ deleted: boolean } | null>(`/v1/releases/${id}`, {
    method: "DELETE",
  });
  return result?.deleted ?? false;
}

export async function updateRelease(
  id: string,
  data: Record<string, unknown>,
): Promise<ReleaseWithSource> {
  return apiFetch<ReleaseWithSource>(`/v1/releases/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── Release suppression ──

export async function suppressRelease(releaseId: string, reason?: string): Promise<boolean> {
  const result = await apiFetch<{ suppressed: boolean }>(`/v1/releases/${releaseId}/suppress`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  return result?.suppressed ?? false;
}

export async function unsuppressRelease(releaseId: string): Promise<boolean> {
  const result = await apiFetch<{ unsuppressed: boolean }>(`/v1/releases/${releaseId}/unsuppress`, {
    method: "POST",
  });
  return result?.unsuppressed ?? false;
}

// ── Release refetch (operator in-place healing, #2073) ──

export interface RefetchReleaseSnapshot {
  title: string;
  contentChars: number;
  mediaCount: number;
  publishedAt: string | null;
  url: string | null;
}

export interface RefetchReleaseDryRunResult {
  dryRun: true;
  releaseId: string;
  fetchUrl: string;
  via: string;
  current: RefetchReleaseSnapshot;
  proposed: RefetchReleaseSnapshot;
}

export interface RefetchReleaseWriteResult {
  dryRun: false;
  releaseId: string;
  fetchUrl: string;
  via: string;
  updated: RefetchReleaseSnapshot;
}

export type RefetchReleaseResult = RefetchReleaseDryRunResult | RefetchReleaseWriteResult;

/**
 * Re-fetch a single release's live page and update the row in place (same
 * `rel_` id). `dryRun` defaults to true server-side, so callers must pass it
 * explicitly either way. See buildinternet/releases#2073.
 */
export async function refetchRelease(body: {
  releaseId: string;
  url?: string;
  dryRun: boolean;
}): Promise<RefetchReleaseResult> {
  return apiFetch<RefetchReleaseResult>("/v1/workflows/refetch-release", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteReleasesBatch(releaseIds: string[]): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>(`/v1/releases/batch`, {
    method: "DELETE",
    body: JSON.stringify({ releaseIds }),
  });
}

export async function batchSuppressReleases(
  releaseIds: string[],
  suppressed: boolean,
  reason?: string,
): Promise<{ updated: number }> {
  return apiFetch<{ updated: number }>(`/v1/releases/batch-suppress`, {
    method: "POST",
    body: JSON.stringify({ releaseIds, suppressed, ...(reason !== undefined ? { reason } : {}) }),
  });
}

// ── Latest releases ──

export async function getLatestReleases(opts: {
  /** Source identifier (src_… or slug). */
  source?: string;
  /** Organization identifier (org_… or slug). */
  org?: string;
  count: number;
  includeCoverage?: boolean;
  /** ISO date or relative shorthand (90d/4w/6m/2y); resolved server-side. */
  since?: string;
  until?: string;
  /** Only releases scored at or above this AI importance (1–5). Validated
   *  client-side by `parseImportanceFlag`; forwarded as `?minImportance=`. */
  minImportance?: number;
}): Promise<LatestRelease[]> {
  const qs = new URLSearchParams();
  qs.set("count", String(opts.count));
  if (opts.source) qs.set("source", opts.source);
  if (opts.org) qs.set("org", opts.org);
  if (opts.includeCoverage) qs.set("include_coverage", "true");
  if (opts.since) qs.set("since", opts.since);
  if (opts.until) qs.set("until", opts.until);
  if (opts.minImportance !== undefined) qs.set("minImportance", String(opts.minImportance));

  const data = await apiFetch<{ releases: LatestReleaseWire[] }>(
    `/v1/releases/latest?${qs.toString()}`,
  );
  if (!data) return [];
  return data.releases.map(toLatestRelease);
}

/**
 * Resolve a product identifier to the `{ orgRef, product }` pair the org
 * release feed needs (`GET /v1/orgs/:orgRef/releases?product=…`). Mirrors the
 * identifier shapes `resolveProductTarget` accepts:
 *   - `prod_…` ids: fetch the product to recover its org (the feed is
 *     org-scoped; the org path segment accepts `org_…` ids).
 *   - `org/slug` coordinates: split locally, no round-trip. Existence is
 *     validated by the feed call (a bad coord 404s → `getProductReleases`
 *     returns `null`).
 *   - bare slugs: bounce through `/v1/lookups/product-by-slug` for the
 *     canonical org.
 * Returns `null` when a `prod_…`/bare slug doesn't resolve to a product.
 */
export async function resolveProductFeedTarget(
  identifier: string,
): Promise<{ orgRef: string; product: string } | null> {
  if (identifier.startsWith("prod_")) {
    const product = await findProduct(identifier);
    if (!product) return null;
    return { orgRef: product.orgId, product: identifier };
  }
  const slash = identifier.indexOf("/");
  if (slash > 0 && slash < identifier.length - 1) {
    return { orgRef: identifier.slice(0, slash), product: identifier.slice(slash + 1) };
  }
  const resolved = await apiFetch<{
    productId: string;
    productSlug: string;
    orgSlug: string;
  } | null>(`/v1/lookups/product-by-slug?slug=${encodeURIComponent(identifier)}`);
  if (!resolved) return null;
  return { orgRef: resolved.orgSlug, product: resolved.productSlug };
}

/**
 * One product's cross-source release feed via `GET /v1/orgs/:orgRef/releases?
 * product=…`. Cursor-paginated; the server's cursor is opaque to the CLI.
 * Returns `null` when the org or product is unknown (the endpoint 404s), which
 * `apiFetch` maps to `null` for GETs — distinct from a valid-but-empty product
 * (`{ releases: [], … }`).
 */
export async function getProductReleases(opts: {
  orgRef: string;
  product: string;
  count: number;
  cursor?: string | null;
  includeCoverage?: boolean;
  since?: string;
  until?: string;
  /** Only releases scored at or above this AI importance (1–5). See
   *  {@link getLatestReleases}. */
  minImportance?: number;
}): Promise<{ releases: LatestRelease[]; nextCursor: string | null } | null> {
  const qs = new URLSearchParams();
  qs.set("product", opts.product);
  qs.set("limit", String(opts.count));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.includeCoverage) qs.set("include_coverage", "true");
  if (opts.since) qs.set("since", opts.since);
  if (opts.until) qs.set("until", opts.until);
  if (opts.minImportance !== undefined) qs.set("minImportance", String(opts.minImportance));

  const data = await apiFetch<{
    releases: LatestReleaseWire[];
    pagination?: { nextCursor: string | null };
  } | null>(`/v1/orgs/${encodeURIComponent(opts.orgRef)}/releases?${qs.toString()}`);
  if (!data) return null;
  return {
    releases: data.releases.map(toLatestRelease),
    nextCursor: data.pagination?.nextCursor ?? null,
  };
}

// ── Recent releases ──

export async function getRecentReleases(
  sourceIdentifier: string,
  cutoffIso: string,
): Promise<Release[]> {
  return apiFetch<Release[]>(
    `/v1/sources/${encodeURIComponent(sourceIdentifier)}/recent-releases?cutoff=${encodeURIComponent(cutoffIso)}`,
  );
}

// ── Release summaries ──

export async function getSummariesForSource(sourceSlugOrId: string): Promise<ReleaseSummary[]> {
  return apiFetch<ReleaseSummary[]>(`/v1/sources/${encodeURIComponent(sourceSlugOrId)}/summaries`);
}

export async function upsertSummary(
  sourceSlugOrId: string,
  data: Omit<NewReleaseSummary, "sourceId" | "orgId">,
): Promise<void> {
  await apiFetch(`/v1/sources/${encodeURIComponent(sourceSlugOrId)}/summaries`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getMonthlySummary(
  sourceSlugOrId: string,
  year: number,
  month: number,
): Promise<ReleaseSummary | undefined> {
  const rows = await apiFetch<ReleaseSummary[]>(
    `/v1/sources/${encodeURIComponent(sourceSlugOrId)}/summaries?type=monthly&year=${year}&month=${month}`,
  );
  return rows?.[0];
}

// ── Source release batch insert ──

export async function insertReleasesBatch(
  source: Pick<Source, "id">,
  releaseRows: Array<{
    version?: string | null;
    title: string;
    content: string;
    url?: string | null;
    contentHash?: string | null;
    publishedAt?: string | null;
    type?: ReleaseType;
  }>,
): Promise<{ inserted: number; total: number }> {
  const chunks: (typeof releaseRows)[] = [];
  for (let i = 0; i < releaseRows.length; i += 5) {
    chunks.push(releaseRows.slice(i, i + 5));
  }
  const path = `/v1/sources/${encodeURIComponent(source.id)}/releases/batch`;
  const settled = await Promise.allSettled(
    chunks.map((chunk) =>
      apiFetch<{ inserted: number; total: number }>(path, {
        method: "POST",
        body: JSON.stringify({ releases: chunk }),
      }),
    ),
  );

  const succeeded = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failures = settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));

  if (succeeded.length === 0 && failures.length > 0) {
    throw failures[0];
  }

  if (failures.length > 0) {
    logger.warn(
      `insertReleasesBatch(${source.id}): ${failures.length}/${chunks.length} chunk(s) failed — ${failures.map(String).join("; ")}`,
    );
  }

  const inserted = succeeded.reduce((sum, r) => sum + r.inserted, 0);
  const total = succeeded[succeeded.length - 1]?.total ?? 0;
  return { inserted, total };
}

export async function deleteReleasesForSource(
  source: Pick<Source, "id">,
  opts?: { hard?: boolean },
): Promise<{ suppressed: number } | { deleted: number; hard: true }> {
  // Default (soft) suppresses rows with reason "force_refetch" but leaves them
  // occupying UNIQUE(source_id, url) — a re-fetch upserts on top but never
  // un-suppresses, so the rows stay hidden. `?hard=true` removes them so the
  // dedup slot frees up and a corrected re-fetch ingests clean. See #1184.
  const query = opts?.hard ? "?hard=true" : "";
  return apiFetch(`/v1/sources/${encodeURIComponent(source.id)}/releases${query}`, {
    method: "DELETE",
  });
}

// ── Query releases with media ──

export async function queryReleasesWithMedia(): Promise<
  { id: string; sourceId: string; media: string }[]
> {
  return apiFetch("/v1/releases?hasMedia=true&fields=id,sourceId,media");
}
