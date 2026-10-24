import { apiFetch } from "./core.js";
import { call, find } from "./sdk.js";
import type {
  CollectionListItem,
  CollectionDetail,
  CollectionReleasesResponse,
  CollectionRow,
  CreateCollectionRequest,
  UpdateCollectionRequest,
  ReplaceCollectionMembersRequest,
  AddCollectionMemberRequest,
} from "@buildinternet/releases-api-types";

export async function listCollections(): Promise<CollectionListItem[]> {
  return call((c) => c.collections.list());
}

export async function getCollection(slug: string): Promise<CollectionDetail | null> {
  return find((c) => c.collections.get(slug));
}

/**
 * Cross-org release feed for a collection. Cursor-paginated; the API's cursor
 * format is opaque to the CLI — we just round-trip whatever the server returns.
 */
export async function getCollectionReleases(
  slug: string,
  opts: { limit?: number; cursor?: string | null; includePrereleases?: boolean } = {},
): Promise<CollectionReleasesResponse | null> {
  return find((c) =>
    c.collections.releases(slug, {
      limit: opts.limit,
      cursor: opts.cursor || undefined,
      include_prereleases: opts.includePrereleases || undefined,
    }),
  );
}

/** Collections an org is a member of. Used to indicate membership on `releases get <orgslug>`. */
export async function getOrgCollections(orgRef: string): Promise<CollectionListItem[]> {
  return call((c) =>
    c.request<CollectionListItem[]>("GET /orgs/:slug/collections", { params: { slug: orgRef } }),
  );
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
