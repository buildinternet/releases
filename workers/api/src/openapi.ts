import { generateSpecs } from "hono-openapi";
import type { Hono } from "hono";
import type { Env } from "./index.js";

// Scalar pinned to a major version; jsdelivr resolves to the latest 1.x patch.
// A breaking 2.x release won't silently swap in.
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
      data-configuration='{"theme":"default"}'
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
            description:
              "REST API for the Releases changelog registry — orgs, products, sources, releases, and search. See https://releases.sh.",
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
    return c.json(spec);
  });

  v1.get("/docs", (c) => {
    c.header("Cache-Control", "public, max-age=86400");
    return c.html(SCALAR_HTML);
  });
}
