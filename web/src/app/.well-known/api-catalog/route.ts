import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const revalidate = false;

const BASE_URL = "https://releases.sh";
const REST_API_URL = "https://api.releases.sh";
const OPENAPI_URL = `${REST_API_URL}/v1/openapi.json`;
const SCALAR_DOCS_URL = `${REST_API_URL}/v1/docs`;
const MCP_URL = "https://mcp.releases.sh/mcp";

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
          href: SCALAR_DOCS_URL,
          type: "text/html",
          title: "Releases REST API — interactive reference (Scalar)",
        },
        {
          href: `${BASE_URL}/docs/api/rest`,
          type: "text/html",
          title: "Releases REST API — overview",
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
