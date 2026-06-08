import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const revalidate = false;

// The brand root (`releases.sh`) advertises itself as an OAuth 2.0 protected
// resource (RFC 9728) fronted by the "Sign in with Releases" authorization
// server. RFC 9728 §3.3 requires `resource` to equal the origin the metadata
// was fetched from, so this document MUST be served locally with
// `resource: https://releases.sh` — redirecting to the api-host document
// (whose `resource` is https://api.releases.sh) trips an origin mismatch.
//
// The REST API worker publishes its own, distinct protected-resource document
// at https://api.releases.sh/.well-known/oauth-protected-resource with
// `resource: https://api.releases.sh`. Two origins, two self-consistent docs,
// one shared authorization server — see `workers/api/src/oauth-discovery.ts`.
const BASE_URL = "https://releases.sh";
const OAUTH_AS_URL = "https://api.releases.sh/api/auth";

const body = {
  resource: BASE_URL,
  authorization_servers: [OAUTH_AS_URL],
  scopes_supported: ["read", "write", "admin"],
  bearer_methods_supported: ["header"],
};

const SERIALIZED_BODY = JSON.stringify(body, null, 2);

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
};

/** Serves the RFC 9728 protected-resource metadata for the releases.sh origin. */
export function GET() {
  return new NextResponse(SERIALIZED_BODY, { headers: COMMON_HEADERS });
}
