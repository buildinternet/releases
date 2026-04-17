import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "releases.sh documentation";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    eyebrow: "Documentation",
    title: "releases.sh docs",
    subtitle: "CLI, API, and MCP for product changelogs",
    description:
      "Install the CLI, query the REST API, or connect the MCP server to agents like Claude.",
  });
}
