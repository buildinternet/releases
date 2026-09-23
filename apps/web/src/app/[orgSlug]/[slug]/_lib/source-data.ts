import { cache } from "react";
import { ApiNotFoundError } from "@/lib/api";
import { fetchSourceDetail, type MappedSourceDetail } from "@/lib/graphql/map-source";
import { getResolved } from "./resolve";

/**
 * Org-scoped source detail, GraphQL-backed (#1978 slice 3). Slug resolution
 * stays on REST via `getResolved` (org+slug → { kind, id }, product-vs-source
 * disambiguation already lives there and isn't worth re-implementing in
 * GraphQL for this slice — see PR description); the entity fetch itself runs
 * as `Query.source(id)`. `getResolved` is itself `cache()`-wrapped, so a
 * layout/page pair that both call `getResolved(orgSlug, slug)` and
 * `getSource(orgSlug, slug)` in the same request only pays for the REST
 * round-trip once.
 */
export const getSource = cache(
  async (orgSlug: string, sourceSlug: string): Promise<MappedSourceDetail> => {
    const resolved = await getResolved(orgSlug, sourceSlug);
    if (resolved.kind !== "source") {
      throw new ApiNotFoundError(`No source at ${orgSlug}/${sourceSlug}`);
    }
    return fetchSourceDetail(resolved.source.id, `No source at ${orgSlug}/${sourceSlug}`);
  },
);
