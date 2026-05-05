import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { type DocumentNode, print } from "graphql";
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

// Memoize SDL serialization per static document. `print` walks the AST every
// call; on a typed-document export this output is identical forever, so paying
// it once per worker isolate is enough.
const printedDocumentCache = new WeakMap<DocumentNode, string>();
function printOnce(document: DocumentNode): string {
  const cached = printedDocumentCache.get(document);
  if (cached) return cached;
  const sdl = print(document);
  printedDocumentCache.set(document, sdl);
  return sdl;
}

/**
 * Server-side GraphQL fetch. Reuses `webApiHeaders` + `applyCacheInit` from
 * `lib/api.ts` so a GraphQL call inside a server component behaves the same
 * as REST equivalents — proxy key, web user-agent, 60s ISR default.
 */
export async function graphqlRequest<TData, TVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  init?: FetchCacheInit,
): Promise<TData> {
  const fetchInit: RequestInit = {
    method: "POST",
    headers: { ...webApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query: printOnce(document), variables }),
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
    throw new GraphQLRequestError(body.errors);
  }
  if (!body.data) throw new Error("GraphQL response missing both data and errors");
  return body.data;
}
