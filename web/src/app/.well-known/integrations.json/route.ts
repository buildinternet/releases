import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const revalidate = false;

// integrations.sh discovery document (v3). One inline file at
// https://releases.sh/.well-known/integrations.json describing every way an
// agent can integrate with Releases: the public REST API (with its generated
// OpenAPI 3.1 spec), the remote MCP server, and the CLI. Credentials are
// defined once and referenced from each surface's auth by id.
//
// Every `basis.source` points back at this document's canonical URL, as the
// v3 shape requires. Reads on the REST API and MCP server are anonymous/public
// ("search and browse work out of the box"), so those surfaces declare
// `auth.status: "none"`; the CLI is the credentialed integration path (sign in
// or `RELEASES_API_KEY`), so it references the shared `releases-api-key`.
//
// GraphQL (`POST /v1/graphql`) is intentionally omitted: in production it is
// restricted to persisted operations with introspection/GraphiQL disabled, so
// it is not a usable third-party integration surface.
const SELF = "https://releases.sh/.well-known/integrations.json";

const declaredBasis = { via: "declared", source: SELF } as const;

const body = {
  version: 3,
  summary:
    "Releases is an agent-friendly registry of product changelogs and release notes, queryable via a public REST API, a remote MCP server, and a CLI.",
  credentials: {
    "releases-api-key": {
      type: "api_key",
      label: "Releases API key",
      setup:
        "Search and browse need no credential. To follow orgs/products, get a personalized feed, or manage webhooks, sign in with `releases login` — it opens your browser (OAuth device authorization) and mints a personal, read-only key (`relu_…`). Already issued a token (e.g. a write/admin `relk_…` key during the closed beta)? Store it with `releases auth login --token <token>`. The stored key is sent to `https://api.releases.sh` as `Authorization: Bearer <token>`; `RELEASES_API_KEY` in the environment overrides the stored credential (handy for CI).",
    },
  },
  surfaces: [
    {
      type: "http",
      slug: "releases-rest-api",
      name: "Releases REST API",
      docs: "https://releases.sh/docs/api/rest",
      url: "https://api.releases.sh",
      spec: "https://api.releases.sh/v1/openapi.json",
      basis: declaredBasis,
      auth: { status: "none", basis: declaredBasis },
    },
    {
      type: "mcp",
      slug: "releases-mcp",
      name: "Releases MCP server",
      docs: "https://releases.sh/docs/api/mcp",
      url: "https://mcp.releases.sh/mcp",
      transports: ["streamable-http"],
      basis: declaredBasis,
      auth: { status: "none", basis: declaredBasis },
    },
    {
      type: "cli",
      slug: "releases-cli",
      name: "Releases CLI",
      docs: "https://github.com/buildinternet/releases-cli#readme",
      command: "releases",
      packages: [
        {
          registryType: "npm",
          identifier: "@buildinternet/releases",
          runtimeHint: "npx",
        },
      ],
      basis: declaredBasis,
      auth: {
        status: "required",
        entries: [
          {
            use: [
              {
                id: "releases-api-key",
                mechanics: {
                  source: "cli",
                  command: "releases login",
                  env: ["RELEASES_API_KEY"],
                },
              },
            ],
            basis: declaredBasis,
          },
        ],
      },
    },
  ],
};

const SERIALIZED_BODY = JSON.stringify(body, null, 2);

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
};

/** Serves the integrations.sh v3 discovery document for the releases.sh origin. */
export function GET() {
  return new NextResponse(SERIALIZED_BODY, { headers: COMMON_HEADERS });
}
