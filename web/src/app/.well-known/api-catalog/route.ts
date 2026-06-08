import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const revalidate = false;

const BASE_URL = "https://releases.sh";
const REST_API_URL = "https://api.releases.sh";
const OPENAPI_URL = `${REST_API_URL}/v1/openapi.json`;
const SCALAR_DOCS_URL = `${REST_API_URL}/v1/docs`;
const MCP_URL = "https://mcp.releases.sh/mcp";
// "Sign in with Releases" OAuth 2.0 / OIDC authorization server. The issuer is
// the api host plus the `/api/auth` basePath; the discovery documents are served
// at the api-host origin (and aliased from the root domain via next.config
// redirects). Advertise them here so an agent that finds the catalog can locate
// the auth server without a prior 401 challenge.
const OAUTH_AS_URL = `${REST_API_URL}/api/auth`;
const OIDC_DISCOVERY_URL = `${REST_API_URL}/.well-known/openid-configuration`;
const OAUTH_AS_METADATA_URL = `${REST_API_URL}/.well-known/oauth-authorization-server`;

// RFC 9727 §3: every response from the catalog endpoint advertises itself as
// the catalog via a Link header. HEAD relies on it; GET ships it as a courtesy
// so consumers that only ever GET still see the relation in the headers.
const SELF_LINK_HEADER =
  '</.well-known/api-catalog>; rel="self"; type="application/linkset+json", ' +
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"';

const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

const body = {
  linkset: [
    {
      anchor: `${BASE_URL}/`,
      "service-doc": [
        {
          href: `${BASE_URL}/docs/api`,
          type: "text/html",
          title: "Releases API documentation",
        },
      ],
    },
    {
      anchor: REST_API_URL,
      // service-desc: machine-readable OpenAPI 3.1 description.
      // service-doc: human-readable references — the in-product Scalar UI plus
      // the marketing-site landing page.
      "service-desc": [
        {
          href: OPENAPI_URL,
          type: "application/openapi+json",
          title: "Releases REST API — OpenAPI 3.1 description",
        },
      ],
      "service-doc": [
        {
          href: `${BASE_URL}/docs/api/rest`,
          type: "text/html",
          title: "Releases REST API — interactive reference",
        },
        {
          href: SCALAR_DOCS_URL,
          type: "text/html",
          title: "Releases REST API — interactive reference (direct, no marketing chrome)",
        },
      ],
    },
    {
      anchor: MCP_URL,
      "service-doc": [
        {
          href: `${BASE_URL}/docs/api/mcp`,
          type: "text/html",
          title: "Releases MCP server",
        },
      ],
    },
    {
      anchor: OAUTH_AS_URL,
      // service-desc: machine-readable OAuth/OIDC discovery documents. OIDC
      // discovery (RFC: OpenID Connect Discovery 1.0) and the RFC 8414 OAuth 2.0
      // authorization-server metadata both describe the same authorization
      // server; agents pick whichever they support.
      "service-desc": [
        {
          href: OIDC_DISCOVERY_URL,
          type: "application/json",
          title: "Releases authorization server — OpenID Connect discovery",
        },
        {
          href: OAUTH_AS_METADATA_URL,
          type: "application/json",
          title: "Releases authorization server — OAuth 2.0 metadata (RFC 8414)",
        },
      ],
    },
  ],
};

const SERIALIZED_BODY = JSON.stringify(body, null, 2);

const COMMON_HEADERS = {
  "Content-Type": "application/linkset+json",
  "Cache-Control": CACHE_CONTROL,
  Link: SELF_LINK_HEADER,
};

/** Serves the RFC 9727 api-catalog linkset describing Releases' published APIs. */
export function GET() {
  return new NextResponse(SERIALIZED_BODY, { headers: COMMON_HEADERS });
}

/**
 * Returns only the catalog response headers (including the `api-catalog`
 * Link relation). RFC 9727 §2 SHALL clause — Next.js does not synthesize
 * HEAD from a GET export, so it's defined here.
 */
export function HEAD() {
  return new NextResponse(null, { headers: COMMON_HEADERS });
}
