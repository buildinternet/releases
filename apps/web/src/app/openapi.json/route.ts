import { NextResponse } from "next/server";

export const revalidate = 3600;

const UPSTREAM = "https://api.releases.sh/v1/openapi.json";

// Proxy the REST API worker's generated OpenAPI 3.1 spec onto the web origin so
// it resolves at https://releases.sh/openapi.json — the canonical path agent
// tooling (and integrations.sh) probes. The spec is generated per-request by the
// API worker, so we fetch it (revalidated hourly) rather than ship a static copy
// that drifts from the live API. The routing middleware (`proxy.ts`) explicitly
// bypasses `/openapi.json` so its `.json` suffix matcher doesn't hijack this.
export async function GET() {
  try {
    const upstream = await fetch(UPSTREAM, { next: { revalidate: 3600 } });
    if (!upstream.ok) {
      return NextResponse.json(
        { error: "openapi spec upstream unavailable", status: upstream.status },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const spec = await upstream.text();
    return new NextResponse(spec, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "openapi spec upstream unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
