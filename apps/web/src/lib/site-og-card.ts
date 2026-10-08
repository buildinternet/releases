import type { OgTemplateProps } from "@/lib/og";

/**
 * Site-level OG card content. Shared by the root `opengraph-image.tsx`
 * (build-hashed URL) and the stable `/api/og/site` route that docs and the
 * static legal pages point at.
 */
export const SITE_OG_ALT = "Release Notes Index — The latest product releases, indexed for agents";

export const SITE_OG_PROPS: OgTemplateProps = {
  title: "Release Notes Index",
  subtitle: "The latest product releases, indexed for agents",
  description:
    "A registry of release notes from across the web, queryable from your terminal, code, or MCP client.",
};
