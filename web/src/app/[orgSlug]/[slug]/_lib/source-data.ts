import { cache } from "react";
import { ApiNotFoundError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { SourceDetailDocument } from "@/lib/graphql/__generated__/graphql";
import { mapSourceDetail, type MappedSourceDetail } from "@/lib/graphql/map-source";
import { getResolved } from "./resolve";

const DEFAULT_RELEASE_LIMIT = 20;

/**
 * Org-scoped source detail, GraphQL-backed (#1978 slice 3). Slug resolution
 * stays on REST via `getResolved` (org+slug → { kind, id }, product-vs-source
 * disambiguation already lives there and isn't worth re-implementing in
 * GraphQL for this slice — see PR description); the entity fetch itself runs
 * as `Query.source(id)`. `getResolved` is itself `cache()`-wrapped, so a
 * layout/page pair that both call `getResolved(orgSlug, slug)` and
 * `getSource(orgSlug, slug)` in the same request only pays for the REST
 * round-trip once.
 *
 * Overfetches `releases` by one (limit+1) so `pagination.nextCursor` can be
 * derived without a second query — mirrors the REST handler's limit+1 trick.
 */
export const getSource = cache(
  async (orgSlug: string, sourceSlug: string): Promise<MappedSourceDetail> => {
    const resolved = await getResolved(orgSlug, sourceSlug);
    if (resolved.kind !== "source") {
      throw new ApiNotFoundError(`No source at ${orgSlug}/${sourceSlug}`);
    }
    const data = await graphqlRequest(SourceDetailDocument, {
      id: resolved.source.id,
      releaseLimit: DEFAULT_RELEASE_LIMIT + 1,
    });
    if (!data.source) {
      throw new ApiNotFoundError(`No source at ${orgSlug}/${sourceSlug}`);
    }
    return mapSourceDetail(data.source, DEFAULT_RELEASE_LIMIT);
  },
);
