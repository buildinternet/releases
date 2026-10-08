import { apiFetch } from "./core.js";
import type { ReleaseType } from "@buildinternet/releases-core/schema";
import type {
  CollectionListItem,
  CollectionDetail,
  CollectionRow,
  CreateCollectionRequest,
  UpdateCollectionRequest,
  ReplaceCollectionMembersRequest,
  AddCollectionMemberRequest,
} from "@buildinternet/releases-api-types";

export interface CollectionReleaseItemCli {
  id: string;
  version: string | null;
  type: ReleaseType;
  title: string;
  summary: string;
  content: string;
  publishedAt: string | null;
  url: string | null;
  prerelease: boolean;
  source: { slug: string; name: string; type: string };
  org: { slug: string; name: string };
  product: { slug: string; name: string } | null;
}

interface CollectionReleasesResponseCli {
  releases: CollectionReleaseItemCli[];
  pagination: { nextCursor: string | null; limit: number };
}

export async function listCollections(): Promise<CollectionListItem[]> {
  return apiFetch<CollectionListItem[]>("/v1/collections");
}

export async function getCollection(slug: string): Promise<CollectionDetail | null> {
  return apiFetch<CollectionDetail | null>(`/v1/collections/${encodeURIComponent(slug)}`);
}

/**
 * Cross-org release feed for a collection. Cursor-paginated; the API's cursor
 * format is opaque to the CLI — we just round-trip whatever the server returns.
 *
 * `CollectionReleaseItem` isn't published in api-types yet, so the wire shape
 * is declared inline. When the next api-types release lands, this can switch
 * to importing the canonical type.
 */
export async function getCollectionReleases(
  slug: string,
  opts: { limit?: number; cursor?: string | null; includePrereleases?: boolean } = {},
): Promise<CollectionReleasesResponseCli | null> {
  const qs = new URLSearchParams();
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.includePrereleases) qs.set("include_prereleases", "1");
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  return apiFetch<CollectionReleasesResponseCli | null>(
    `/v1/collections/${encodeURIComponent(slug)}/releases${suffix}`,
  );
}

/** Collections an org is a member of. Used to indicate membership on `releases get <orgslug>`. */
export async function getOrgCollections(orgRef: string): Promise<CollectionListItem[]> {
  return apiFetch<CollectionListItem[]>(`/v1/orgs/${encodeURIComponent(orgRef)}/collections`);
}

export async function createCollection(input: CreateCollectionRequest): Promise<CollectionRow> {
  return apiFetch<CollectionRow>("/v1/collections", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCollection(
  slug: string,
  input: UpdateCollectionRequest,
): Promise<CollectionRow> {
  return apiFetch<CollectionRow>(`/v1/collections/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteCollection(slug: string): Promise<void> {
  await apiFetch(`/v1/collections/${encodeURIComponent(slug)}`, { method: "DELETE" });
}

export async function replaceCollectionMembers(
  slug: string,
  orgs: ReplaceCollectionMembersRequest["orgs"],
): Promise<{ collectionSlug: string; members: { orgId: string; position: number }[] }> {
  const payload: ReplaceCollectionMembersRequest = { orgs };
  return apiFetch(`/v1/collections/${encodeURIComponent(slug)}/members`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function addCollectionMember(
  slug: string,
  member: AddCollectionMemberRequest,
): Promise<{ collectionSlug: string; orgId: string; position: number }> {
  return apiFetch(`/v1/collections/${encodeURIComponent(slug)}/members`, {
    method: "POST",
    body: JSON.stringify(member),
  });
}

export async function removeCollectionMember(slug: string, org: string): Promise<void> {
  await apiFetch(`/v1/collections/${encodeURIComponent(slug)}/members/${encodeURIComponent(org)}`, {
    method: "DELETE",
  });
}
