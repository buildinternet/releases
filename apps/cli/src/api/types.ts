/**
 * API response types for the Releases registry.
 *
 * Wire protocol shapes are re-exported from `@buildinternet/releases-api-types`
 * (published from the monorepo `buildinternet/releases`, `packages/api-types/`);
 * bump the pin in `package.json` when adopting new response shapes.
 */
export * from "@buildinternet/releases-api-types";

/**
 * Response from `POST /v1/sources/video` — materializes a YouTube
 * channel/playlist into a curated Org → Source → backfilled Releases.
 *
 * Structurally identical to `AppStoreMaterializeResponse`: a bare inserted (or
 * idempotently looked-up) source row plus a `releaseCount`. Defined locally
 * rather than re-exported because `@buildinternet/releases-api-types` does not
 * yet ship a video schema — the `/v1/sources/video` route is hidden from the
 * production OpenAPI surface. Replace with the published type once api-types
 * exports one.
 *
 * `status: "indexed"` is a brand-new source (HTTP 201); `"existing"` is the
 * idempotent hit on a prior materialize of the same resolved feed URL
 * (HTTP 200). The resolved provider/channel live inside `source.metadata`
 * (a JSON string) under `video: { provider, channel }`.
 */
export interface VideoMaterializeResponse {
  status: "indexed" | "existing";
  source: {
    id: string;
    slug: string;
    name: string;
    type: string;
    url: string;
    orgId: string | null;
    productId: string | null;
    metadata: string | null;
    [key: string]: unknown;
  };
  releaseCount: number;
}
