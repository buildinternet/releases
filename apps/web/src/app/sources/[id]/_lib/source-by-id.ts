import { cache } from "react";
import { fetchSourceDetail } from "@/lib/graphql/map-source";

/**
 * `/sources/:id` detail, GraphQL-backed (#1978 slice 3) — `Query.source(id)`
 * directly, no slug resolution needed (the id is already known).
 */
export const getSourceById = cache((id: string) => fetchSourceDetail(id, `No source ${id}`));

/**
 * Where a source lives. Product and source slugs never collide within an org,
 * so every source with an org is at its bare `/{org}/{slug}` and `/sources/:id`
 * is a 308 alias to it. Only a source with no org keeps `/sources/:id`.
 */
export function sourceHomePath(
  source: { org?: { slug: string } | null; slug: string },
  id: string,
): string {
  return source.org ? `/${source.org.slug}/${source.slug}` : `/sources/${id}`;
}
