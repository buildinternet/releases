import { NextResponse } from "next/server";

export const dynamic = "force-static";
export const revalidate = false;

const BASE_URL = "https://releases.sh";
const REST_API_URL = "https://api.releases.sh";
const MCP_URL = "https://mcp.releases.sh/mcp";

export function GET() {
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
        "service-doc": [
          {
            href: `${BASE_URL}/docs/api/rest`,
            type: "text/html",
            title: "Releases REST API",
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

  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
