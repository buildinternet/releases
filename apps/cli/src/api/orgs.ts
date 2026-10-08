import type {
  Organization,
  OrgAccount,
  IgnoredUrl,
  BlockedUrl,
  Tag,
} from "@buildinternet/releases-core/schema";
import type { OrgCatalogResponse, OrgDependentsResponse } from "./types.js";
import type { CreateStubOrgBody, SetOrgAvatarResponse } from "@buildinternet/releases-api-types";
import { apiFetch, suggestEntities } from "./core.js";
import { assertCleanIdentifier } from "../lib/validate-input.js";
import { type ListResponse } from "@buildinternet/releases-core/cli-contracts";

// ── Org queries ──

export async function findOrg(identifier: string): Promise<Organization | null> {
  assertCleanIdentifier(identifier, "org");
  return apiFetch<Organization | null>(`/v1/orgs/${encodeURIComponent(identifier)}`);
}

export const suggestOrgs = (term: string, limit: number) =>
  suggestEntities("/v1/orgs", term, limit);
export const suggestSources = (term: string, limit: number) =>
  suggestEntities("/v1/sources", term, limit);

export async function getSourcesByOrg(
  orgId: string,
): Promise<import("@buildinternet/releases-core/schema").Source[]> {
  return apiFetch<import("@buildinternet/releases-core/schema").Source[]>(
    `/v1/sources?orgId=${orgId}`,
  );
}

export async function listOrgs(opts?: {
  query?: string;
  platform?: string;
  limit?: number;
  page?: number;
  includeEmpty?: boolean;
}): Promise<ListResponse<Organization>> {
  const params = new URLSearchParams();
  if (opts?.query) params.set("q", opts.query);
  if (opts?.platform) params.set("platform", opts.platform);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.page != null) params.set("page", String(opts.page));
  if (opts?.includeEmpty) params.set("includeEmpty", "true");
  const qs = params.toString();
  return apiFetch<ListResponse<Organization>>(`/v1/orgs${qs ? `?${qs}` : ""}`);
}

// ── Ignored URLs (org-scoped) ──

export async function findIgnoredUrl(url: string, orgId: string): Promise<IgnoredUrl | null> {
  const encoded = encodeURIComponent(url);
  return apiFetch<IgnoredUrl | null>(`/v1/orgs/${orgId}/ignored-urls?url=${encoded}&single=true`);
}

export async function addIgnoredUrl(url: string, orgId: string, reason?: string): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/ignored-urls`, {
    method: "POST",
    body: JSON.stringify({ url, reason }),
  });
}

export async function listIgnoredUrls(
  orgId: string,
  opts?: { limit?: number; page?: number },
): Promise<ListResponse<IgnoredUrl>> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.page != null) params.set("page", String(opts.page));
  const qs = params.toString();
  return apiFetch<ListResponse<IgnoredUrl>>(`/v1/orgs/${orgId}/ignored-urls${qs ? `?${qs}` : ""}`);
}

export async function removeIgnoredUrl(url: string, orgId: string): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/ignored-urls/${encodeURIComponent(url)}`, { method: "DELETE" });
}

// ── Blocked URLs (global) ──

export async function findBlockedUrl(url: string): Promise<BlockedUrl | null> {
  const encoded = encodeURIComponent(url);
  return apiFetch<BlockedUrl | null>(`/v1/admin/blocklist?url=${encoded}&single=true`);
}

export async function addBlockedUrl(
  pattern: string,
  type: "exact" | "domain",
  reason?: string,
): Promise<void> {
  await apiFetch("/v1/admin/blocklist", {
    method: "POST",
    body: JSON.stringify({ pattern, type, reason }),
  });
}

export async function listBlockedUrls(opts?: {
  limit?: number;
  page?: number;
}): Promise<ListResponse<BlockedUrl>> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.page != null) params.set("page", String(opts.page));
  const qs = params.toString();
  return apiFetch<ListResponse<BlockedUrl>>(`/v1/admin/blocklist${qs ? `?${qs}` : ""}`);
}

export async function removeBlockedUrl(pattern: string): Promise<void> {
  await apiFetch(`/v1/admin/blocklist/${encodeURIComponent(pattern)}`, { method: "DELETE" });
}

// ── Catalog (products + standalone sources, folded) ──

/**
 * Combined product + source catalog for one org, folded into a single list
 * with an `entryType: "product" | "source"` discriminator. Backs the MCP
 * `list_catalog` tool's org-scoped path (`GET /v1/orgs/:slug/catalog`).
 */
export async function getOrgCatalog(orgSlug: string): Promise<OrgCatalogResponse | null> {
  return apiFetch<OrgCatalogResponse | null>(`/v1/orgs/${encodeURIComponent(orgSlug)}/catalog`);
}

// ── Org CRUD ──

export async function createOrg(
  name: string,
  opts?: {
    slug?: string;
    domain?: string;
    description?: string;
    category?: string;
    avatarUrl?: string;
  },
): Promise<Organization> {
  return apiFetch<Organization>("/v1/orgs", {
    method: "POST",
    body: JSON.stringify({
      name,
      slug: opts?.slug,
      domain: opts?.domain,
      description: opts?.description,
      category: opts?.category,
      avatarUrl: opts?.avatarUrl,
    }),
  });
}

/**
 * Delete an org. Soft delete (default) accepts a slug or `org_…` ID; **hard
 * delete requires the typed `org_…` ID** — the server rejects a slug on the
 * destructive path as a guardrail (#690). Callers passing `{ hard: true }` must
 * resolve the identifier to its ID first (see `orgDeleteAction`).
 */
export async function removeOrg(identifier: string, opts?: { hard?: boolean }): Promise<void> {
  const qs = opts?.hard ? "?hard=true" : "";
  await apiFetch(`/v1/orgs/${encodeURIComponent(identifier)}${qs}`, { method: "DELETE" });
}

export async function getOrgDependents(identifier: string): Promise<OrgDependentsResponse> {
  // apiFetch returns null on GET 404; surface a typed error instead so the
  // delete flow doesn't dereference `dependents.counts` on a missing org.
  const result = await apiFetch<OrgDependentsResponse | null>(
    `/v1/admin/orgs/${encodeURIComponent(identifier)}/dependents`,
  );
  if (!result) {
    throw new Error(`Org dependents preview not available for "${identifier}" (org not found).`);
  }
  return result;
}

// ── Stub-tier orgs (#1947) ──

/** POST /v1/orgs/stub — create a curator-authored stub org (identity +
 *  declared release locations, no sources). Admin scope required. */
export async function createStubOrg(
  body: CreateStubOrgBody,
): Promise<Organization & { productCount: number; locationCount: number }> {
  return apiFetch<Organization & { productCount: number; locationCount: number }>("/v1/orgs/stub", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface StubFromDomainResult {
  created: boolean;
  orgId?: string;
  skippedReason?: string;
  productCount?: number;
  locationCount?: number;
  /** Populated on dryRun: the stub input that WOULD be written. */
  plan?: Record<string, unknown>;
}

/** POST /v1/orgs/stub-from-domain — create a stub org from a domain's
 *  /.well-known/releases.json manifest. `dryRun` rides as a query param. */
export async function createStubOrgFromDomain(
  domain: string,
  opts?: { dryRun?: boolean },
): Promise<StubFromDomainResult> {
  const qs = opts?.dryRun ? "?dryRun=1" : "";
  return apiFetch<StubFromDomainResult>(`/v1/orgs/stub-from-domain${qs}`, {
    method: "POST",
    body: JSON.stringify({ domain }),
  });
}

export interface PromoteOrgResult {
  promoted: boolean;
  /** True when the org was already `tracked` — a no-op success (idempotent). */
  alreadyTracked?: boolean;
  sourcesCreated: number;
  sourcesMatched: number;
  locatorsStamped: number;
  /** The materialization plan (the whole payload under dryRun). */
  plan?: Record<string, unknown>;
}

/** POST /v1/orgs/:slug/promote — materialize a stub's locations into sources
 *  and flip the org to `tier: "tracked"`. `dryRun` rides as a query param. */
export async function promoteOrg(
  identifier: string,
  opts?: { dryRun?: boolean },
): Promise<PromoteOrgResult> {
  assertCleanIdentifier(identifier, "org");
  const qs = opts?.dryRun ? "?dryRun=1" : "";
  return apiFetch<PromoteOrgResult>(`/v1/orgs/${encodeURIComponent(identifier)}/promote${qs}`, {
    method: "POST",
  });
}

export async function updateOrg(
  identifier: string,
  data: Record<string, unknown>,
): Promise<Organization> {
  return apiFetch<Organization>(`/v1/orgs/${encodeURIComponent(identifier)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

/**
 * Mirror a remote image to R2 and set it as the org avatar (#1406). The server
 * fetches + validates (square raster) + stores at `orgs/{slug}.{ext}`, keeping CF
 * credentials server-side; the CLI only resolves a concrete image URL.
 */
export async function setOrgAvatar(
  identifier: string,
  sourceUrl: string,
): Promise<SetOrgAvatarResponse> {
  return apiFetch<SetOrgAvatarResponse>(`/v1/orgs/${encodeURIComponent(identifier)}/avatar`, {
    method: "POST",
    body: JSON.stringify({ sourceUrl }),
  });
}

export async function getOrgAccountsBySlug(
  orgSlug: string,
): Promise<Array<{ platform: string; handle: string }>> {
  const data = await apiFetch<{
    accounts: Array<{ platform: string; handle: string }>;
  }>(`/v1/orgs/${orgSlug}`);
  return data?.accounts ?? [];
}

export async function linkOrgAccount(
  orgSlug: string,
  platform: string,
  handle: string,
): Promise<OrgAccount> {
  return apiFetch<OrgAccount>(`/v1/orgs/${orgSlug}/accounts`, {
    method: "POST",
    body: JSON.stringify({ platform, handle }),
  });
}

export async function unlinkOrgAccount(
  orgSlug: string,
  platform: string,
  handle: string,
): Promise<void> {
  // The API doesn't have a dedicated unlink endpoint — use PATCH to update org or
  // we need to add one. For now, this is a placeholder that will need a matching API endpoint.
  // The simplest approach: DELETE /v1/orgs/:slug/accounts/:platform/:handle
  await apiFetch(`/v1/orgs/${orgSlug}/accounts/${platform}/${encodeURIComponent(handle)}`, {
    method: "DELETE",
  });
}

// ── Tags for orgs ──

export async function getOrCreateTag(name: string): Promise<Tag> {
  return apiFetch<Tag>("/v1/tags", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function getTagsForOrg(orgId: string): Promise<string[]> {
  return apiFetch<string[]>(`/v1/orgs/${orgId}/tags`);
}

export async function addTagsToOrg(orgId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function removeTagsFromOrg(orgId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/tags`, {
    method: "DELETE",
    body: JSON.stringify({ tags: tagNames }),
  });
}

// ── Status events ──

export async function postStatusEvent(event: {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}): Promise<{ cancelRequested: boolean }> {
  try {
    const result = await apiFetch<{ cancelRequested?: boolean }>("/v1/status/event", {
      method: "POST",
      body: JSON.stringify(event),
    });
    return { cancelRequested: result?.cancelRequested === true };
  } catch {
    // Graceful fallback if the response isn't JSON or the request fails
    return { cancelRequested: false };
  }
}
