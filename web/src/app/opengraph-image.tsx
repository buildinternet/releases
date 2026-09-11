import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Releases Index — The latest product releases, indexed for agents";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    title: "Releases Index",
    subtitle: "The latest product releases, indexed for agents",
    description:
      "Releases Index is a registry of release notes from across the web, queryable from your terminal, code, or MCP client.",
  });
}
