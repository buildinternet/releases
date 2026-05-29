import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hydrateMediaUrls } from "@releases/rendering/media-url.js";
import type { D1Db } from "./db.js";
import { getCatalogEntry, getOrganization, type ToolResult } from "./tools.js";
import { completeCatalogSlug, completeOrgSlug, completeSourceSlug } from "./slug-completion.js";
import { releaseFeedHtml } from "./ui-bundles.js";

/**
 * MIME type the MCP Apps spec uses for bundled HTML UI resources. Matches
 * `RESOURCE_MIME_TYPE` exported by `@modelcontextprotocol/ext-apps`; inlined
 * here so the worker doesn't carry the wrapper package as a runtime dep.
 * The `profile` parameter (not a `+suffix`) is what hosts pattern-match on.
 */
export const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** Stable URIs paired with tool `_meta.ui.resourceUri` values. */
export const RELEASE_FEED_UI_URI = "ui://releases/release-feed.html";

/**
 * External origins the release-feed UI iframe needs to load images from.
 * MCP App hosts (claude.ai is the first web host) sandbox the UI iframe under
 * a CSP that blocks ALL external resources unless the resource declares them
 * via `_meta.ui.csp`. `resourceDomains` maps to `img-src` (plus script/style/
 * font/media-src) per the MCP Apps spec. Without this, org avatars served from
 * media.releases.sh — and the `github.com/{handle}.png` fallback in
 * `OrgAvatar`, which redirects to avatars.githubusercontent.com — render as
 * broken images. The bundled JS/CSS are inlined into the HTML shell, so the
 * iframe needs no script/style origins beyond inline.
 */
export const RELEASE_FEED_RESOURCE_DOMAINS = [
  "https://media.releases.sh",
  "https://github.com",
  "https://*.githubusercontent.com",
];

/** Completion-only: `resources/list` is intentionally empty. See docs/architecture/mcp.md. */

type ReadResult = {
  contents: [{ uri: string; mimeType: string; text: string }];
};

function toMarkdownContents(uri: URL, result: ToolResult, mediaOrigin: string): ReadResult {
  const text = mediaOrigin
    ? hydrateMediaUrls(result.content[0].text, mediaOrigin)
    : result.content[0].text;
  return {
    contents: [{ uri: uri.toString(), mimeType: "text/markdown", text }],
  };
}

export function registerResources(server: McpServer, db: D1Db, mediaOrigin: string) {
  const orgTemplate = new ResourceTemplate("releases://org/{orgSlug}", {
    list: undefined,
    complete: {
      orgSlug: (value) => completeOrgSlug(db, value),
    },
  });

  server.registerResource(
    "organization",
    orgTemplate,
    {
      description:
        "Organization profile — accounts, tags, sources, products, aliases, and overview preview. URI: releases://org/{orgSlug}. The `{orgSlug}` segment also accepts an org_ id, domain, or account handle. Not enumerable; completion offers slugs.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const identifier = String(variables.orgSlug);
      return toMarkdownContents(uri, await getOrganization(db, { identifier }), mediaOrigin);
    },
  );

  const catalogTemplate = new ResourceTemplate("releases://catalog/{slug}", {
    list: undefined,
    complete: {
      slug: (value) => completeCatalogSlug(db, value),
    },
  });

  server.registerResource(
    "catalog",
    catalogTemplate,
    {
      description:
        "Catalog entry — a product or standalone source, folded into one addressable surface. URI: releases://catalog/{slug}. The `{slug}` segment also accepts a prod_ id, src_ id, or org-scoped coordinate (e.g. 'vercel/nextjs'). Completion spans both product and source slugs.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const identifier = String(variables.slug);
      return toMarkdownContents(uri, await getCatalogEntry(db, { identifier }), mediaOrigin);
    },
  );

  const sourceTemplate = new ResourceTemplate("releases://source/{sourceSlug}", {
    list: undefined,
    complete: {
      sourceSlug: (value) => completeSourceSlug(db, value),
    },
  });

  server.registerResource(
    "source",
    sourceTemplate,
    {
      description:
        "(deprecated) Source detail. Prefer releases://catalog/{slug} — it resolves products and standalone sources via one URI. Kept for one release cycle.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const slug = String(variables.sourceSlug);
      return toMarkdownContents(uri, await getCatalogEntry(db, { identifier: slug }), mediaOrigin);
    },
  );

  // ── MCP App UI resources ───────────────────────────────────────────────
  // Tools advertise these via `_meta.ui.resourceUri`. Hosts that support
  // MCP Apps fetch the HTML; everyone else falls back to the text content.
  // See docs/architecture/mcp.md for the full pattern.
  server.registerResource(
    "release-feed-ui",
    RELEASE_FEED_UI_URI,
    {
      description:
        "Interactive feed UI for `get_latest_releases` and `get_collection_releases`. Renders the structured release list as cards with cursor-based 'load more'.",
      mimeType: UI_RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: RELEASE_FEED_UI_URI,
          mimeType: UI_RESOURCE_MIME_TYPE,
          text: releaseFeedHtml,
          // Host iframes sandbox under a deny-by-default CSP; declare the
          // origins our avatars load from so they aren't blocked as img-src.
          _meta: {
            ui: {
              csp: {
                resourceDomains: RELEASE_FEED_RESOURCE_DOMAINS,
              },
            },
          },
        },
      ],
    }),
  );
}
