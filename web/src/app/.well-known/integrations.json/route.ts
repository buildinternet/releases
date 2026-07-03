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
// v3 shape requires.
//
// Auth is OPTIONAL on the REST API and MCP server: reads work anonymously
// ("search and browse work out of the box"), but presenting an API token
// (`Authorization: Bearer <token>`) raises your rate-limit tier and unlocks
// account-scoped actions. v3 AuthStatus has no "optional" value — only
// none / unknown / required — so these surfaces use `required` with the token
// as an OR alternative and document the optionality in the credential setup,
// rather than `none` (which would wrongly imply no auth exists at all). The
// CLI is the primary credentialed path (`releases login` or `RELEASES_API_KEY`).
// All three surfaces reference the one shared `releases-api-key` credential.
//
// GraphQL (`POST /v1/graphql`) is intentionally omitted: in production it is
// restricted to persisted operations with introspection/GraphiQL disabled, so
// it is not a usable third-party integration surface.
const SELF = "https://releases.sh/.well-known/integrations.json";

const declaredBasis = { via: "declared", source: SELF } as const;

// How the shared API token binds to an HTTP request. Same for the REST API and
// the MCP server, which both read the token from the `Authorization` header.
const bearerTokenAuth = {
  status: "required",
  entries: [
    {
      use: [
        {
          id: "releases-api-key",
          mechanics: {
            source: "http",
            in: "header",
            headerName: "Authorization",
            scheme: "Bearer",
          },
        },
      ],
      basis: declaredBasis,
    },
  ],
} as const;

const body = {
  version: 3,
  summary:
    "Releases is an agent-friendly registry of product changelogs and release notes, queryable via a public REST API, a remote MCP server, and a CLI. Reads are public; an optional API token raises your rate-limit tier.",
  credentials: {
    "releases-api-key": {
      type: "api_key",
      label: "Releases API key",
      setup:
        "Optional. Search, browse, and MCP reads work with no credential; presenting a token raises your rate-limit tier (anonymous < signed-in account < machine token) and unlocks account-scoped actions. Sign in with `releases login` — it opens your browser (OAuth device authorization) and mints a personal, read-only key (`relu_…`). Already issued a token (e.g. a write/admin `relk_…` key during the closed beta)? Store it with `releases auth login --token <token>`. The token is sent to `https://api.releases.sh` (and `https://mcp.releases.sh`) as `Authorization: Bearer <token>`; `RELEASES_API_KEY` in the environment overrides the stored credential (handy for CI).",
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
      auth: bearerTokenAuth,
    },
    {
      type: "mcp",
      slug: "releases-mcp",
      name: "Releases MCP server",
      docs: "https://releases.sh/docs/api/mcp",
      url: "https://mcp.releases.sh/mcp",
      transports: ["streamable-http"],
      basis: declaredBasis,
      auth: bearerTokenAuth,
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
