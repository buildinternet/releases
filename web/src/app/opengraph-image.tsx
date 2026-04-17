import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "releases.sh — An agent-friendly API for product changelogs";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    title: "releases.sh",
    subtitle: "An agent-friendly API for product changelogs",
    description:
      "A unified registry of product releases, available via CLI, API, or MCP.",
  });
}
