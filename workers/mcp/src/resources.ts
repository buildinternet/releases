import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hydrateMediaUrls } from "@releases/rendering/media-url.js";
import type { D1Db } from "./db.js";
import { getCatalogEntry, getOrganization, getProduct, type ToolResult } from "./tools.js";
import {
  completeCatalogSlug,
  completeOrgSlug,
  completeProductSlug,
  completeSourceSlug,
} from "./slug-completion.js";

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
        "Organization profile — accounts, tags, sources, products, aliases, and overview preview. URI: releases://org/{orgSlug}. Not enumerable; discover slugs via completion.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const slug = String(variables.orgSlug);
      return toMarkdownContents(uri, await getOrganization(db, { identifier: slug }), mediaOrigin);
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
        "Catalog entry — a product or standalone source, folded into one addressable surface. URI: releases://catalog/{slug}. Completion spans both product and source slugs. Not enumerable; discover slugs via completion.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const slug = String(variables.slug);
      return toMarkdownContents(uri, await getCatalogEntry(db, { identifier: slug }), mediaOrigin);
    },
  );

  const productTemplate = new ResourceTemplate("releases://product/{productSlug}", {
    list: undefined,
    complete: {
      productSlug: (value) => completeProductSlug(db, value),
    },
  });

  server.registerResource(
    "product",
    productTemplate,
    {
      description:
        "(deprecated) Product detail. Prefer releases://catalog/{slug} — it resolves products and standalone sources via one URI. Kept for one release cycle.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const slug = String(variables.productSlug);
      return toMarkdownContents(uri, await getProduct(db, { identifier: slug }), mediaOrigin);
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
}
