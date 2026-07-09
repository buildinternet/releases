import type { CollectionListItem } from "@buildinternet/releases-api-types";
import type { Collection } from "./builder.js";

/**
 * Sidebar / list Collection parent — identity fields only; `previewMembers`
 * intentionally empty (sidebar chips don't need them).
 */
export function collectionFromListItem(r: CollectionListItem): Collection {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description,
    memberCount: r.memberCount,
    isFeatured: r.isFeatured,
    previewMembers: [],
  };
}
