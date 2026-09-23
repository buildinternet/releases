import "server-only";

import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  apiSetupSteps,
  ApiSetupError,
  API_URL,
  applyCacheInit,
  type FetchCacheInit,
  webApiHeaders,
} from "@/lib/api";

const GRAPHQL_PATH = "/v1/graphql";

interface GraphQLError {
  message: string;
  path?: ReadonlyArray<string | number>;
  extensions?: { code?: string; [key: string]: unknown };
}

interface GraphQLResponse<TData> {
  data?: TData;
  errors?: GraphQLError[];
}

export class GraphQLRequestError extends Error {
  errors: GraphQLError[];
  constructor(errors: GraphQLError[]) {
    super(errors.map((e) => e.message).join("; "));
    this.name = "GraphQLRequestError";
    this.errors = errors;
  }
}

/** Yoga / Apollo APQ codes for an unknown persisted-operation hash. */
function isPersistedQueryNotFound(errors: GraphQLError[]): boolean {
  return errors.some((e) => {
    const code = e.extensions?.code;
    return (
      e.message === "PersistedQueryNotFound" ||
      code === "PERSISTED_QUERY_NOT_IN_LIST" ||
      code === "PERSISTED_QUERY_NOT_FOUND"
    );
  });
}

// Codegen embeds `__meta__.hash` on every TypedDocumentNode when the
// `persistedDocuments` preset option is on (see web/codegen.ts). The API
// rejects requests without a known hash from non-admin callers, so we
// pull it off the document and send it in Apollo APQ wire format.
interface PersistedDocument {
  __meta__?: { hash?: string };
}

// Apollo APQ wire format expects the bare sha256 (no `sha256:` prefix). The
// API mirrors this strip in workers/api/src/graphql/persisted.ts — keep the
// two in sync if the algorithm ever changes.
const HASH_PREFIX = "sha256:";
function persistedHashOf(document: PersistedDocument): string {
  const hash = document.__meta__?.hash;
  if (!hash) {
    // Should never happen — codegen embeds the hash on every operation. If
    // it does, the server would reject the request anyway, so fail fast
    // here with a clearer message.
    throw new Error("graphql document is missing a persisted-query hash");
  }
  return hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : hash;
}

/**
 * Server-side GraphQL fetch. Reuses `webApiHeaders` + `applyCacheInit` from
 * `lib/api.ts` so a GraphQL call inside a server component behaves the same
 * as REST equivalents — proxy key, web user-agent, ISR default revalidate.
 *
 * Sends the persisted-query hash, never the document itself, so the API's
 * persisted-operations gate accepts the request.
 *
 * On `PersistedQueryNotFound`, retries once with `cache: "no-store"`. Yoga
 * returns HTTP 200 with that error, so Next's Data Cache can pin a poison
 * entry for the full revalidate window when web ships a new op before the
 * API worker — a common monorepo deploy race (#2047). The uncached retry
 * heals as soon as the API knows the hash, without waiting for ISR expiry.
 */
export async function graphqlRequest<TData, TVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  init?: FetchCacheInit,
): Promise<TData> {
  return graphqlRequestInner(document, variables, init, false);
}

async function graphqlRequestInner<TData, TVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  init: FetchCacheInit | undefined,
  retriedUncached: boolean,
): Promise<TData> {
  const sha256Hash = persistedHashOf(document as PersistedDocument);
  const fetchInit: RequestInit = {
    method: "POST",
    headers: { ...webApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      extensions: { persistedQuery: { version: 1, sha256Hash } },
      variables,
    }),
  };
  applyCacheInit(fetchInit, init);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${GRAPHQL_PATH}`, fetchInit);
  } catch {
    throw new ApiSetupError(
      `Cannot connect to the API at ${API_URL}. Is the server running?`,
      apiSetupSteps,
    );
  }

  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status} ${res.statusText}`);

  // Yoga responds 200 with an `errors` array when resolvers fail; surface as
  // a typed throw so callers can branch on `extensions.code`.
  const body = (await res.json()) as GraphQLResponse<TData>;
  if (body.errors && body.errors.length > 0) {
    if (!retriedUncached && init?.cache !== "no-store" && isPersistedQueryNotFound(body.errors)) {
      return graphqlRequestInner(document, variables, { ...init, cache: "no-store" }, true);
    }
    throw new GraphQLRequestError(body.errors);
  }
  if (!body.data) throw new Error("GraphQL response missing both data and errors");
  return body.data;
}
