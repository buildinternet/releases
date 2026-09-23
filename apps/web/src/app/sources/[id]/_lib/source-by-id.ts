import { cache } from "react";
import { fetchSourceDetail } from "@/lib/graphql/map-source";

/**
 * `/sources/:id` detail, GraphQL-backed (#1978 slice 3) — `Query.source(id)`
 * directly, no slug resolution needed (the id is already known).
 */
export const getSourceById = cache((id: string) => fetchSourceDetail(id, `No source ${id}`));
