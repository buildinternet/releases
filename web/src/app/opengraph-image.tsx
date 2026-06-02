import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "releases.sh — The latest product releases, indexed for agents";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    title: "releases.sh",
    subtitle: "The latest product releases, indexed for agents",
    description:
      "Releases is a registry of release notes from across the web, queryable from your terminal, code, or MCP client.",
  });
}
