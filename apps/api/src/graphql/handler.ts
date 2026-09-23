import { Hono } from "hono";
import type { Env } from "../index.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import {
  CACHEABLE_HASHES,
  GRAPHQL_ADMIN_HEADER,
  lookupCached,
  storeIfCacheable,
} from "./persisted.js";

// The Yoga server (graphql-yoga, the Pothos schema build, the hardening and
// persisted-operations plugins) is imported on the first /v1/graphql request
// and memoized for the isolate. Building it at module scope ran on every
// isolate start and counted against the worker's script-startup CPU limit.
let yogaModule: Promise<typeof import("./yoga.js")> | undefined;
function loadYoga(): Promise<typeof import("./yoga.js")> {
  yogaModule ??= import("./yoga.js");
  return yogaModule;
}

export const graphqlRoutes = new Hono<Env>();

graphqlRoutes.all("/graphql", async (c) => {
  const isAdmin = await isValidBearerAuth(c);

  // Strip any client-supplied bypass sentinel and re-stamp only when
  // we trust the request: real admin Bearer auth, OR a non-production
  // deployment (where GraphiQL is already exposed and the persisted-ops
  // gate would otherwise lock it out for non-admin developers). The
  // sentinel is what persistedOperationsPlugin reads to decide whether
  // to allow arbitrary documents — we MUST control it.
  const headers = new Headers(c.req.raw.headers);
  headers.delete(GRAPHQL_ADMIN_HEADER);
  const bypassPersistedGate = isAdmin || c.env.ENVIRONMENT !== "production";
  if (bypassPersistedGate) headers.set(GRAPHQL_ADMIN_HEADER, "1");

  // GraphiQL pings (GET, no body) skip cache + body parsing entirely.
  if (c.req.method !== "POST") {
    const passthrough = new Request(c.req.raw, { headers });
    const { yoga } = await loadYoga();
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

  const { yoga } = await loadYoga();
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
