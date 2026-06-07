/** Minimal shape this helper needs from a Better Auth instance. */
interface AuthHandler {
  handler: (req: Request) => Promise<Response>;
}

/**
 * Forward an apex OAuth/OIDC discovery request to the Better Auth handler, which
 * serves the metadata under `/api/auth/.well-known/...`. OAuth clients (Claude,
 * ChatGPT, MCP Inspector, …) fetch the ORIGIN path; this rewrites to the Better
 * Auth path and stamps a wildcard origin so a cross-origin fetch (no credentials)
 * can read the response. No `Allow-Methods` here — that header only matters on the
 * OPTIONS preflight, which the global CORS layer answers, never on this GET.
 */
export async function forwardWellKnown(
  auth: AuthHandler,
  wellKnown: "oauth-authorization-server" | "openid-configuration",
  reqUrl: string,
  headers: Headers,
): Promise<Response> {
  const url = new URL(reqUrl);
  url.pathname = `/api/auth/.well-known/${wellKnown}`;
  const upstream = await auth.handler(new Request(url, { headers }));
  const res = new Response(upstream.body, upstream);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
}
