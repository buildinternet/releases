import { generateSpecs } from "hono-openapi";
import type { Hono } from "hono";
import type { Env } from "./index.js";

// Hides the route from /v1/openapi.json on production. Staging and local
// `wrangler dev` still expose it so our internal tooling can introspect the
// full surface. The endpoint itself is unaffected — this only changes what
// the spec advertises.
//
// hono-openapi's `hide` callback signature passes `c?: Context | undefined`,
// so we type the env read defensively and treat any non-"production" value
// (staging, undefined under `wrangler dev`) as "show".
export const hideInProduction = (opts: { c?: { env?: unknown } }) => {
  const env = (opts.c?.env ?? {}) as { ENVIRONMENT?: string };
  return env.ENVIRONMENT === "production";
};

// Scalar pinned to a major version; jsdelivr resolves to the latest 1.x patch.
// A breaking 2.x release won't silently swap in.
//
// Config choices:
// - `agent.disabled` removes the "Ask AI" chat affordance; we don't host an
//   inference endpoint, so it would error or send queries to Scalar's hosted
//   service we don't control.
// - `mcp.disabled` removes the "Generate MCP" button; we ship our own remote
//   MCP server at mcp.releases.sh and don't want a competing auto-generated
//   wrapper offered here.
// - `hideClientButton` hides the in-sidebar global client switcher (the
//   per-endpoint client tabs still render).
// - `customCss` hides the "Powered by Scalar" footer — no built-in toggle in
//   Scalar 1.x. The "Back to docs" link lives in the OpenAPI `info.description`
//   markdown instead, which Scalar renders as the intro panel.
const SCALAR_CONFIG = {
  theme: "default",
  hideClientButton: true,
  agent: { disabled: true },
  mcp: { disabled: true },
  metaData: {
    title: "Releases API Reference",
    ogTitle: "Releases API Reference",
    description: "Interactive reference for the Releases changelog registry REST API.",
  },
  // The "Powered by Scalar" link sits in the bottom row of the sidebar's
  // `.darklight-reference` footer, in a flex-1 wrapper that's a sibling of the
  // dark-mode toggle. Hiding the wrapper keeps the toggle visible. Selector
  // verified against the rendered DOM in 1.x; revisit if Scalar restructures.
  customCss:
    "aside.t-doc__sidebar .darklight-reference .flex-1.text-sidebar-c-2 { display: none !important; }",
};
const SCALAR_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Releases API Reference</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script
      id="api-reference"
      data-url="/v1/openapi.json"
      data-configuration='${JSON.stringify(SCALAR_CONFIG).replace(/'/g, "&#39;")}'
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script>
  </body>
</html>`;

const TAGS = [
  { name: "Orgs", description: "Organizations — top-level publisher of releases." },
  { name: "Sources", description: "Changelog sources owned by an org." },
  { name: "Products", description: "Optional grouping layer between orgs and sources." },
  { name: "Releases", description: "Individual release entries." },
  { name: "Search", description: "Lexical, semantic, and hybrid search." },
  { name: "Lookups", description: "On-demand resolution helpers." },
  { name: "Stats", description: "Public registry statistics." },
  { name: "Sitemap", description: "Bulk URL emission for crawlers." },
  {
    name: "Related",
    description: "Vectorize-backed similarity rails for releases and sources.",
  },
  { name: "Taxonomy", description: "Categories and tags." },
  {
    name: "Collections",
    description: "Curated, named org playlists independent of category.",
  },
  { name: "Overviews", description: "AI-generated org and product summaries." },
  { name: "Admin", description: "Admin-only telemetry. Bearer required." },
  { name: "Workflows", description: "Job triggers. Bearer required." },
  { name: "Webhooks", description: "Webhook subscription management." },
  { name: "Sessions", description: "Managed-agent discovery sessions." },
];

export function mountOpenApi(v1: Hono<Env>) {
  // Servers + securitySchemes are computed per-request so production's
  // public spec advertises only api.releases.sh, while staging's spec keeps
  // its own host and the `X-Releases-Staging-Key` scheme visible.
  // `ENVIRONMENT` is set in workers/api/wrangler.jsonc (production | staging).
  v1.get("/openapi.json", async (c) => {
    const isStaging = c.env.ENVIRONMENT === "staging";
    const spec = await generateSpecs(
      v1,
      {
        documentation: {
          info: {
            title: "Releases API",
            version: "1.0.0",
            // Markdown rendered by Scalar as the intro panel. Includes a
            // back-link to the narrative docs since the sidebar doesn't have
            // one (we hide Scalar's footer branding, which is where their
            // tooling normally puts cross-links).
            description: [
              "REST API for the Releases changelog registry — orgs, products, sources, releases, and search.",
              "",
              "**Links:** [releases.sh](https://releases.sh) · [Narrative docs](https://releases.sh/docs/api/rest) · [MCP server](https://releases.sh/docs/api/mcp)",
            ].join("\n"),
          },
          servers: isStaging
            ? [
                {
                  url: "https://api-staging.releases.sh",
                  description: "Staging (access-key gated)",
                },
              ]
            : [{ url: "https://api.releases.sh", description: "Production" }],
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "rls_…",
                description:
                  "Admin and write endpoints require a Bearer token. Issue and rotate via the operator CLI.",
              },
              ...(isStaging && {
                stagingKey: {
                  type: "apiKey",
                  in: "header",
                  name: "X-Releases-Staging-Key",
                  description:
                    "Staging hosts gate every request behind this header. Bearer alternative also accepted on mcp-staging.",
                },
              }),
            },
          },
          tags: TAGS,
        },
      },
      c,
    );

    // Drop tag definitions that no visible operation references. Without this,
    // Scalar renders empty sidebar sections for any tag declared in `TAGS`
    // that has no operations under it — common in production where whole tag
    // families (Webhooks, Sessions, Workflows, Admin, Sitemap) collapse to
    // zero operations after `hide: hideInProduction` does its work.
    const usedTags = new Set<string>();
    for (const methods of Object.values(spec.paths ?? {})) {
      for (const op of Object.values(methods as Record<string, { tags?: string[] }>)) {
        for (const t of op?.tags ?? []) usedTags.add(t);
      }
    }
    if (spec.tags) spec.tags = spec.tags.filter((t) => usedTags.has(t.name));

    return c.json(spec);
  });

  v1.get("/docs", (c) => {
    c.header("Cache-Control", "public, max-age=86400");
    return c.html(SCALAR_HTML);
  });
}
