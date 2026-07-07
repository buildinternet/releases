import { cache } from "react";
import { ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { SourceDetailDocument } from "@/lib/graphql/__generated__/graphql";
import { mapSourceDetail, type MappedSourceDetail } from "@/lib/graphql/map-source";

const DEFAULT_RELEASE_LIMIT = 20;

/**
 * `/sources/:id` detail, GraphQL-backed (#1978 slice 3) — `Query.source(id)`
 * directly, no slug resolution needed (the id is already known). Overfetches
 * `releases` by one to derive `pagination.nextCursor` without a second query;
 * see `mapSourceDetail`.
 */
export const getSourceById = cache(async (id: string): Promise<MappedSourceDetail> => {
  const data = await graphqlRequest(SourceDetailDocument, {
    id,
    releaseLimit: DEFAULT_RELEASE_LIMIT + 1,
  });
  if (!data.source) {
    throw new ApiNotFoundError(`No source ${id}`);
  }
  return mapSourceDetail(data.source, DEFAULT_RELEASE_LIMIT);
});
