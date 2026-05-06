import { createYoga } from "graphql-yoga";
import { Hono } from "hono";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import { createLoaders } from "./loaders.js";
import {
  CACHEABLE_HASHES,
  GRAPHQL_ADMIN_HEADER,
  lookupCached,
  persistedOperationsPlugin,
  storeIfCacheable,
} from "./persisted.js";
import { hardeningPlugins } from "./plugins.js";
import { schema } from "./schema.js";
import type { GraphQLContext } from "./builder.js";

type GraphQLServerContext = { env: Env["Bindings"]; isAdmin: boolean };

// Single Yoga instance per worker isolate. Context factory runs per request,
// so loaders + db handle are still scoped correctly.
const yoga = createYoga<GraphQLServerContext>({
  schema,
  // Yoga uses this for self-references (GraphiQL fetch URL, error links). The
  // Hono mount path is the source of truth — change both together.
  graphqlEndpoint: "/v1/graphql",
  graphiql: (_req, { env }) => env.ENVIRONMENT !== "production",
  context: ({ env, isAdmin }): GraphQLContext => {
    const db = createDb(env.DB);
    return {
      db,
      loaders: createLoaders(db),
      isAdmin,
      mediaOrigin: env.MEDIA_ORIGIN ?? "",
    };
  },
  landingPage: false,
  plugins: [...hardeningPlugins<GraphQLServerContext>(), persistedOperationsPlugin()],
});

export const graphqlRoutes = new Hono<Env>();

graphqlRoutes.all("/graphql", async (c) => {
  const isAdmin = await isValidBearerAuth(c);

  // Strip any client-supplied admin sentinel and re-stamp only if Bearer
  // auth checked out. The sentinel is what persistedOperationsPlugin reads
  // to decide whether to allow arbitrary documents — we MUST control it.
  const headers = new Headers(c.req.raw.headers);
  headers.delete(GRAPHQL_ADMIN_HEADER);
  if (isAdmin) headers.set(GRAPHQL_ADMIN_HEADER, "1");

  // GraphiQL pings (GET, no body) skip cache + body parsing entirely.
  if (c.req.method !== "POST") {
    const passthrough = new Request(c.req.raw, { headers });
    return yoga.fetch(passthrough, { env: c.env, isAdmin });
  }

  // Read the body once so we can both check the KV cache and pass it to
  // yoga. `Request` body is a stream — once consumed, can't be replayed.
  const bodyText = await c.req.raw.text();
  const parsedBody = parseGraphqlBody(bodyText);
  const augmented = new Request(c.req.raw.url, {
    method: "POST",
    headers,
    body: bodyText,
  });

  const cached = await lookupCached(c.env.LATEST_CACHE, augmented, parsedBody);
  if (cached) return cached;

  const response = await yoga.fetch(augmented, { env: c.env, isAdmin });

  // Skip the response-body read entirely unless the hash is in the cache
  // allowlist — admin-driven hashed requests would otherwise pay a clone +
  // text() cost just to be discarded inside storeIfCacheable.
  if (response.ok && parsedBody.hash && CACHEABLE_HASHES.has(parsedBody.hash)) {
    const responseText = await response.clone().text();
    const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
    await storeIfCacheable(c.env.LATEST_CACHE, augmented, parsedBody, responseText, waitUntil);
  }
  return response;
});

interface ParsedGraphqlBody {
  hash: string | null;
  variables: unknown;
}

function parseGraphqlBody(text: string): ParsedGraphqlBody {
  try {
    const json = JSON.parse(text) as {
      extensions?: { persistedQuery?: { sha256Hash?: unknown } };
      variables?: unknown;
    };
    const rawHash = json.extensions?.persistedQuery?.sha256Hash;
    return {
      hash: typeof rawHash === "string" ? rawHash : null,
      variables: json.variables ?? {},
    };
  } catch {
    return { hash: null, variables: {} };
  }
}
