import { cache } from "react";
import { api, type CollectionListItem } from "@/lib/api";

export const getOrg = cache((slug: string) => api.orgDetail(slug));

export const getOrgCollections = cache(async (slug: string): Promise<CollectionListItem[]> => {
  return api.orgCollections(slug).catch(() => [] as CollectionListItem[]);
});
