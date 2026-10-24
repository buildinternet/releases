import type {
  BatchReleasesBody,
  BatchReleasesResponse,
  CollectionDetail,
  CollectionListResponse,
  CollectionReleasesResponse,
  CreateUserApiKeyBody,
  CreateUserWebhookBody,
  CreateUserWebhookResponse,
  CreateWorkspaceWebhookBody,
  CreateWorkspaceWebhookResponse,
  CreatedUserApiKey,
  DomainLookupResponse,
  FollowMutationResponse,
  FollowTarget,
  FollowsListResponse,
  ListUserApiKeysResponse,
  OrgDetail,
  OrgListResponse,
  OrgOverviewResponse,
  OrgReleasesFeedResponse,
  PersonalizedFeedResponse,
  ProductDetail,
  ProductListResponse,
  ReleaseCoverageResponse,
  ReleaseDetailResponse,
  ReleaseLatestResponse,
  RevokeUserApiKeyResponse,
  RotateUserWebhookSecretResponse,
  SourceChangelogResponse,
  SourceDetail,
  SourceListResult,
  SourceReleasesResponse,
  StatsResponse,
  TestUserWebhookResponse,
  UnifiedSearchResponse,
  UpdateWebhookBody,
  UserWebhook,
  UserWebhookListResponse,
  WebhookDeliveriesResponse,
  WhatsChangedResponse,
  WorkspaceWebhook,
  WorkspaceWebhookListResponse,
} from "@buildinternet/releases-api-types";
import { Transport, type ClientOptions, type RequestOptions } from "./transport.js";

/** Entity kinds used by the `kind` filters. */
export type Kind = "platform" | "sdk" | "mobile" | "desktop" | "docs" | "integration" | "tool";

/** A source by slug or `src_…` ID, or by its org-scoped slug pair. */
export type SourceRef = string | { org: string; source: string };

/** A product by slug or `prod_…` ID, or by its org-scoped slug pair. */
export type ProductRef = string | { org: string; product: string };

export interface LatestReleasesQuery {
  /** Number of releases to return. */
  count?: number;
  /** Source slug or ID. */
  source?: string;
  /** Org slug or ID. */
  org?: string;
  /** Comma-separated org slugs to leave out. */
  exclude?: string;
  /** ISO 8601 lower bound on `publishedAt`. */
  since?: string;
  /** ISO 8601 upper bound on `publishedAt`. */
  until?: string;
  /** Only releases with an AI-scored importance of at least this (1–5). */
  minImportance?: number;
  include_coverage?: boolean;
  include_prereleases?: boolean;
}

export interface CursorQuery {
  /** `pagination.nextCursor` from the previous page. */
  cursor?: string;
  limit?: number;
}

export interface OrgReleasesQuery extends CursorQuery {
  source_type?: string;
  kind?: Kind;
  /** Product slug. */
  product?: string;
  q?: string;
  since?: string;
  until?: string;
  include_coverage?: boolean;
  include_prereleases?: boolean;
}

export interface OrgListQuery {
  q?: string;
  category?: string;
  page?: number;
  limit?: number;
  featured?: boolean;
  includeEmpty?: boolean;
}

export interface SearchQuery {
  q: string;
  limit?: number;
  offset?: number;
  mode?: "lexical" | "semantic" | "hybrid";
  domain?: string;
  product?: string;
  category?: string;
  collection?: string;
  kind?: Kind;
  since?: string;
  until?: string;
  include_coverage?: boolean;
  include_content?: boolean;
  include_empty?: boolean;
}

export interface ChangelogQuery {
  /** Repo path of the file, from `files[].path`. Defaults to the root CHANGELOG. */
  path?: string;
  offset?: number;
  /** Slice length in characters. */
  limit?: number;
  /** Slice to this many cl100k_base tokens instead of `limit` characters. */
  tokens?: number;
}

export interface CollectionReleasesQuery extends CursorQuery {
  /** Comma-separated org slugs. */
  orgs?: string;
  /** Comma-separated product slugs. */
  products?: string;
  source_type?: string;
  include_prereleases?: boolean;
}

export interface WhatsChangedQuery {
  package: string;
  from: string;
  to: string;
  ecosystem?: "npm" | "pypi" | "github";
}

export interface DeliveriesQuery {
  /** Only failed attempts. */
  failed?: boolean;
  /** 1–100, default 20. */
  limit?: number;
}

/**
 * Client for the Releases API.
 *
 * ```ts
 * const releases = new Releases({ apiKey: process.env.RELEASES_API_KEY });
 * const { releases: latest } = await releases.releases.latest({ org: "vercel", count: 10 });
 * ```
 */
export class Releases {
  readonly #t: Transport;

  constructor(options: ClientOptions = {}) {
    this.#t = new Transport(options);
  }

  /** A bare-path operation for a slug/ID ref, its org-scoped twin for a slug pair. */
  #source<T>(
    ref: SourceRef,
    bare: string,
    scoped: string,
    call: { query?: object; body?: unknown } & RequestOptions = {},
  ): Promise<T> {
    return typeof ref === "string"
      ? this.#t.request<T>(bare, { params: { slug: ref }, ...call })
      : this.#t.request<T>(scoped, {
          params: { orgSlug: ref.org, sourceSlug: ref.source },
          ...call,
        });
  }

  /** Send any public operation by its surface key, e.g. `"GET /orgs/:slug"`. */
  request<T = unknown>(
    operation: string,
    call?: { params?: Record<string, string>; query?: object; body?: unknown } & RequestOptions,
  ): Promise<T> {
    return this.#t.request<T>(operation, call);
  }

  /** Lexical, semantic, or hybrid search across orgs, sources, and releases. */
  search(query: SearchQuery, opts?: RequestOptions): Promise<UnifiedSearchResponse> {
    return this.#t.request("GET /search", { query, ...opts });
  }

  /** Registry totals; `days` sets the recent-activity window. */
  stats(query?: { days?: number }, opts?: RequestOptions): Promise<StatsResponse> {
    return this.#t.request("GET /stats", { query, ...opts });
  }

  /** Release notes between two versions of a package. */
  whatsChanged(query: WhatsChangedQuery, opts?: RequestOptions): Promise<WhatsChangedResponse> {
    return this.#t.request("GET /whats-changed", { query, ...opts });
  }

  readonly releases = {
    latest: (query?: LatestReleasesQuery, opts?: RequestOptions): Promise<ReleaseLatestResponse> =>
      this.#t.request("GET /releases/latest", { query, ...opts }),
    get: (id: string, opts?: RequestOptions): Promise<ReleaseDetailResponse> =>
      this.#t.request("GET /releases/:id", { params: { id }, ...opts }),
    coverage: (id: string, opts?: RequestOptions): Promise<ReleaseCoverageResponse> =>
      this.#t.request("GET /releases/:id/coverage", { params: { id }, ...opts }),
  };

  readonly orgs = {
    list: (query?: OrgListQuery, opts?: RequestOptions): Promise<OrgListResponse> =>
      this.#t.request("GET /orgs", { query, ...opts }),
    get: (slug: string, opts?: RequestOptions): Promise<OrgDetail> =>
      this.#t.request("GET /orgs/:slug", { params: { slug }, ...opts }),
    releases: (
      slug: string,
      query?: OrgReleasesQuery,
      opts?: RequestOptions,
    ): Promise<OrgReleasesFeedResponse> =>
      this.#t.request("GET /orgs/:slug/releases", { params: { slug }, query, ...opts }),
    products: (
      slug: string,
      query?: { kind?: Kind },
      opts?: RequestOptions,
    ): Promise<ProductListResponse> =>
      this.#t.request("GET /orgs/:slug/products", { params: { slug }, query, ...opts }),
    overview: (slug: string, opts?: RequestOptions): Promise<OrgOverviewResponse> =>
      this.#t.request("GET /orgs/:slug/overview", { params: { slug }, ...opts }),
  };

  readonly products = {
    list: (
      query?: { orgId?: string; kind?: Kind },
      opts?: RequestOptions,
    ): Promise<ProductListResponse> => this.#t.request("GET /products", { query, ...opts }),
    get: (ref: ProductRef, opts?: RequestOptions): Promise<ProductDetail> =>
      typeof ref === "string"
        ? this.#t.request("GET /products/:identifier", { params: { identifier: ref }, ...opts })
        : this.#t.request("GET /orgs/:orgSlug/products/:productSlug", {
            params: { orgSlug: ref.org, productSlug: ref.product },
            ...opts,
          }),
  };

  readonly sources = {
    list: (query?: { kind?: Kind }, opts?: RequestOptions): Promise<SourceListResult> =>
      this.#t.request("GET /sources", { query, ...opts }),
    get: (ref: SourceRef, opts?: RequestOptions): Promise<SourceDetail> =>
      this.#source(ref, "GET /sources/:slug", "GET /orgs/:orgSlug/sources/:sourceSlug", opts),
    releases: (ref: SourceRef, opts?: RequestOptions): Promise<SourceReleasesResponse> =>
      this.#source(
        ref,
        "GET /sources/:slug/releases",
        "GET /orgs/:orgSlug/sources/:sourceSlug/releases",
        opts,
      ),
    /** The source's tracked CHANGELOG file, sliced; page with `nextOffset`. */
    changelog: (
      ref: SourceRef,
      query?: ChangelogQuery,
      opts?: RequestOptions,
    ): Promise<SourceChangelogResponse> =>
      this.#source(
        ref,
        "GET /sources/:slug/changelog",
        "GET /orgs/:orgSlug/sources/:sourceSlug/changelog",
        { query, ...opts },
      ),
    /**
     * Publish releases to a source. Needs a `write` token or a publish token
     * bound to the source. Releases match on `url`; pass
     * `mode: "upsert-content"` to overwrite content on a match.
     */
    publish: (
      ref: SourceRef,
      body: BatchReleasesBody,
      opts?: RequestOptions,
    ): Promise<BatchReleasesResponse> =>
      this.#source(
        ref,
        "POST /sources/:slug/releases/batch",
        "POST /orgs/:orgSlug/sources/:sourceSlug/releases/batch",
        { body, ...opts },
      ),
  };

  readonly collections = {
    list: (
      query?: { featured?: boolean },
      opts?: RequestOptions,
    ): Promise<CollectionListResponse> => this.#t.request("GET /collections", { query, ...opts }),
    get: (slug: string, opts?: RequestOptions): Promise<CollectionDetail> =>
      this.#t.request("GET /collections/:slug", { params: { slug }, ...opts }),
    releases: (
      slug: string,
      query?: CollectionReleasesQuery,
      opts?: RequestOptions,
    ): Promise<CollectionReleasesResponse> =>
      this.#t.request("GET /collections/:slug/releases", { params: { slug }, query, ...opts }),
  };

  readonly lookups = {
    /** The org, products, and sources registered for a domain. */
    byDomain: (domain: string, opts?: RequestOptions): Promise<DomainLookupResponse> =>
      this.#t.request("GET /lookups/by-domain", { query: { domain }, ...opts }),
  };

  /** The signed-in caller's account. Needs a user key (`relu_`) or OAuth token. */
  readonly me = {
    follows: {
      list: (opts?: RequestOptions): Promise<FollowsListResponse> =>
        this.#t.request("GET /me/follows", opts),
      /** Following an org includes its products in the feed. Idempotent. */
      add: (
        targetType: FollowTarget,
        targetId: string,
        opts?: RequestOptions,
      ): Promise<FollowMutationResponse> =>
        this.#t.request("POST /me/follows", { body: { targetType, targetId }, ...opts }),
      remove: (
        targetType: FollowTarget,
        targetId: string,
        opts?: RequestOptions,
      ): Promise<FollowMutationResponse> =>
        this.#t.request("DELETE /me/follows/:targetType/:targetId", {
          params: { targetType, targetId },
          ...opts,
        }),
    },
    /** Releases from everything the caller follows, newest first. */
    feed: (query?: CursorQuery, opts?: RequestOptions): Promise<PersonalizedFeedResponse> =>
      this.#t.request("GET /me/feed", { query, ...opts }),
    webhooks: {
      list: (
        query?: { enabled?: boolean },
        opts?: RequestOptions,
      ): Promise<UserWebhookListResponse> =>
        this.#t.request("GET /me/webhooks", { query, ...opts }),
      /** The response carries the signing key; it is shown only once. */
      create: (
        body: CreateUserWebhookBody,
        opts?: RequestOptions,
      ): Promise<CreateUserWebhookResponse> =>
        this.#t.request("POST /me/webhooks", { body, ...opts }),
      get: (id: string, opts?: RequestOptions): Promise<UserWebhook> =>
        this.#t.request("GET /me/webhooks/:id", { params: { id }, ...opts }),
      update: (id: string, body: UpdateWebhookBody, opts?: RequestOptions): Promise<UserWebhook> =>
        this.#t.request("PATCH /me/webhooks/:id", { params: { id }, body, ...opts }),
      delete: (id: string, opts?: RequestOptions): Promise<void> =>
        this.#t.request("DELETE /me/webhooks/:id", { params: { id }, ...opts }),
      deliveries: (
        id: string,
        query?: DeliveriesQuery,
        opts?: RequestOptions,
      ): Promise<WebhookDeliveriesResponse> =>
        this.#t.request("GET /me/webhooks/:id/deliveries", { params: { id }, query, ...opts }),
      rotateSecret: (id: string, opts?: RequestOptions): Promise<RotateUserWebhookSecretResponse> =>
        this.#t.request("POST /me/webhooks/:id/rotate-secret", { params: { id }, ...opts }),
      test: (id: string, opts?: RequestOptions): Promise<TestUserWebhookResponse> =>
        this.#t.request("POST /me/webhooks/:id/test", { params: { id }, ...opts }),
    },
  };

  /** Self-serve `relu_` keys. Keys minted here are capped at `read` scope. */
  readonly apiKeys = {
    list: (opts?: RequestOptions): Promise<ListUserApiKeysResponse> =>
      this.#t.request("GET /api-keys", opts),
    /** The response carries the full key; it is shown only once. */
    create: (body: CreateUserApiKeyBody, opts?: RequestOptions): Promise<CreatedUserApiKey> =>
      this.#t.request("POST /api-keys", { body, ...opts }),
    revoke: (id: string, opts?: RequestOptions): Promise<RevokeUserApiKeyResponse> =>
      this.#t.request("DELETE /api-keys/:id", { params: { id }, ...opts }),
  };

  /** Webhooks owned by a workspace. Members can read and test; owners and admins manage. */
  workspaceWebhooks(workspaceId: string) {
    const t = this.#t;
    const at = (id?: string): Record<string, string> =>
      id === undefined ? { workspaceId } : { workspaceId, id };
    return {
      list: (
        query?: { enabled?: boolean },
        opts?: RequestOptions,
      ): Promise<WorkspaceWebhookListResponse> =>
        t.request("GET /workspaces/:workspaceId/webhooks", { params: at(), query, ...opts }),
      create: (
        body: CreateWorkspaceWebhookBody,
        opts?: RequestOptions,
      ): Promise<CreateWorkspaceWebhookResponse> =>
        t.request("POST /workspaces/:workspaceId/webhooks", { params: at(), body, ...opts }),
      get: (id: string, opts?: RequestOptions): Promise<WorkspaceWebhook> =>
        t.request("GET /workspaces/:workspaceId/webhooks/:id", { params: at(id), ...opts }),
      update: (
        id: string,
        body: UpdateWebhookBody,
        opts?: RequestOptions,
      ): Promise<WorkspaceWebhook> =>
        t.request("PATCH /workspaces/:workspaceId/webhooks/:id", {
          params: at(id),
          body,
          ...opts,
        }),
      delete: (id: string, opts?: RequestOptions): Promise<void> =>
        t.request("DELETE /workspaces/:workspaceId/webhooks/:id", { params: at(id), ...opts }),
      deliveries: (
        id: string,
        query?: DeliveriesQuery,
        opts?: RequestOptions,
      ): Promise<WebhookDeliveriesResponse> =>
        t.request("GET /workspaces/:workspaceId/webhooks/:id/deliveries", {
          params: at(id),
          query,
          ...opts,
        }),
      rotateSecret: (id: string, opts?: RequestOptions): Promise<RotateUserWebhookSecretResponse> =>
        t.request("POST /workspaces/:workspaceId/webhooks/:id/rotate-secret", {
          params: at(id),
          ...opts,
        }),
      test: (id: string, opts?: RequestOptions): Promise<TestUserWebhookResponse> =>
        t.request("POST /workspaces/:workspaceId/webhooks/:id/test", { params: at(id), ...opts }),
    };
  }
}
