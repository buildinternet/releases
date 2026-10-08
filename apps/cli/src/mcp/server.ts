import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  getSourcesByOrg,
  findOrg,
  listOrgs,
  getTagsForOrg,
  getOrgAccountsBySlug,
  getOrgCatalog,
} from "../api/orgs.js";
import { getProductsByOrg, findProduct, listProducts } from "../api/products.js";
import {
  getLatestReleases,
  getProductReleases,
  resolveProductFeedTarget,
} from "../api/releases.js";
import {
  findSource,
  unifiedSearch,
  sourceChangelog,
  getAliases,
  listSourcesWithOrg,
  AmbiguousSourceError,
} from "../api/sources.js";
import type { LatestRelease, UnifiedSearchResponse } from "../api/types.js";
import { searchToMarkdown } from "../lib/formatters.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { recordEvent } from "../lib/telemetry.js";
import { describeAmbiguousSource } from "../cli/suggest.js";
import { VERSION } from "../cli/version.js";
import {
  DEFAULT_CHANGELOG_LIMIT,
  MAX_CHANGELOG_LIMIT,
  fetchProductChangelog,
} from "../lib/product-changelog.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Exported (in addition to `startMcpServer`) so tests can reach into
// `server._registeredTools[name].handler` and exercise a tool handler
// directly without spinning up a stdio transport.
export const server = new McpServer({
  name: "releases",
  version: VERSION,
});

// Wrap every tool handler with fire-and-forget telemetry.
{
  const original = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (
    name: string,
    config: unknown,
    handler: (...args: unknown[]) => unknown,
  ) => {
    const wrapped = async (...args: unknown[]) => {
      const start = Date.now();
      let exitCode = 0;
      try {
        return await handler(...args);
      } catch (err) {
        exitCode = 1;
        throw err;
      } finally {
        void recordEvent({
          surface: "mcp",
          command: `tool ${name}`,
          exitCode,
          durationMs: Date.now() - start,
        });
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return original(name as any, config as any, wrapped as any);
  };
}

// ── search ───────────────────────────────────────────────────────────
server.registerTool(
  "search",
  {
    description:
      "Unified search across orgs, the catalog (products + standalone sources), and release content. Proxies to api.releases.sh — release retrieval supports hybrid lexical + semantic search. Pass `type` to restrict which result sections are returned.",
    inputSchema: {
      query: z.string().describe("Search query"),
      type: z
        .array(z.enum(["orgs", "catalog", "releases"]))
        .optional()
        .describe("Restrict results to these sections. Omit to include all three."),
      organization: z.string().optional().describe("Scope results to this organization"),
      mode: z
        .enum(["lexical", "semantic", "hybrid"])
        .optional()
        .describe("Release retrieval strategy (default: hybrid)."),
      limit: z.number().optional().describe("Max results per section (default 20)"),
    },
  },
  async ({ query, type, organization, mode, limit }) => {
    const maxResults = limit ?? 20;

    const result = await unifiedSearch(query, maxResults, {
      org: organization,
      mode: mode ?? "hybrid",
    });

    // Section filtering happens client-side: the unified /v1/search endpoint
    // always returns every section, so honor `type` by zeroing the others.
    const want = type && type.length > 0 ? new Set(type) : null;
    const filtered: UnifiedSearchResponse = want
      ? {
          ...result,
          orgs: want.has("orgs") ? result.orgs : [],
          catalog: want.has("catalog") ? result.catalog : [],
          releases: want.has("releases") ? result.releases : [],
        }
      : result;

    return textResult(searchToMarkdown(filtered));
  },
);

// ── get_latest_releases ──────────────────────────────────────────────
server.registerTool(
  "get_latest_releases",
  {
    description: "Get the most recent releases, optionally filtered by product or organization",
    inputSchema: {
      product: z
        .string()
        .optional()
        .describe(
          "Show one product's cross-source feed. Accepts an org/slug coordinate, a prod_… id, or a product slug.",
        ),
      organization: z
        .string()
        .optional()
        .describe("Filter to sources belonging to this organization"),
      type: z
        .enum(["feature", "rollup"])
        .optional()
        .describe(
          "Filter by release type: 'feature' for individual releases, 'rollup' for seasonal/quarterly catch-all posts. Omit to include both.",
        ),
      count: z.number().optional().describe("Number of releases to return (default 10)"),
    },
  },
  async ({ product, organization, count }) => {
    const maxCount = count ?? 10;

    // product takes precedence — it routes to the product's cross-source feed
    // (GET /v1/orgs/:org/releases?product=…) rather than the global latest feed.
    let releases: LatestRelease[];
    if (product) {
      const target = await resolveProductFeedTarget(product);
      const res = target
        ? await getProductReleases({
            orgRef: target.orgRef,
            product: target.product,
            count: maxCount,
          })
        : null;
      // A null target (unresolvable id/slug) or null feed (unknown org/product
      // 404) is a bad identifier — distinct from a valid product with zero
      // releases — so say so rather than returning a misleading empty result.
      if (!target || !res) {
        return textResult(`No product found matching "${product}".`);
      }
      releases = res.releases;
    } else {
      releases = await getLatestReleases({ org: organization, count: maxCount });
    }

    // type filter: LatestRelease doesn't carry a type field — the remote MCP worker
    // handles this natively. Silently ignored when proxying.

    releases = releases.slice(0, maxCount);

    if (releases.length === 0) {
      return textResult("No releases found.");
    }

    const text = releases
      .map((r) => {
        const preview = (r.summary || "").slice(0, 500);
        return [
          `**${r.title}**`,
          `Source: ${r.sourceName} | Version: ${r.version ?? "N/A"} | Date: ${r.publishedAt ?? "N/A"}`,
          preview,
        ].join("\n");
      })
      .join("\n\n---\n\n");

    return textResult(text);
  },
);

// ── list_catalog ─────────────────────────────────────────────────────
server.registerTool(
  "list_catalog",
  {
    description:
      'List catalog entries — products and standalone sources folded into one list, each row tagged with an `entryType: "product" | "source"` discriminator. Pass `organization` for one org\'s full folded catalog; omit it for the global catalog.',
    inputSchema: {
      organization: z.string().optional().describe("Filter to one organization (slug or org_ id)"),
    },
  },
  async ({ organization }) => {
    type CatalogRow = {
      entryType: "product" | "source";
      name: string;
      slug: string;
      extra: string;
    };
    let rows: CatalogRow[];

    if (organization) {
      const org = await findOrg(organization);
      if (!org) {
        return textResult(`No organization found matching "${organization}"`);
      }
      const catalog = await getOrgCatalog(org.slug);
      if (!catalog || catalog.items.length === 0) {
        return textResult(`No catalog entries found for ${org.name}.`);
      }
      rows = catalog.items.map((item) =>
        item.entryType === "product"
          ? {
              entryType: "product",
              name: item.name,
              slug: item.slug,
              extra: `Category: ${item.category ?? "N/A"}`,
            }
          : {
              entryType: "source",
              name: item.name,
              slug: item.slug,
              extra: `Type: ${item.type} | URL: ${item.url}`,
            },
      );
    } else {
      // No global catalog endpoint exists, so fold the two global lists here:
      // every product, plus the standalone sources (those not bound to a
      // product — product-bound sources fold under their product row).
      const [products, sources] = await Promise.all([
        listProducts({ limit: 200 }),
        listSourcesWithOrg(),
      ]);
      const productRows: CatalogRow[] = products.items.map((p) => ({
        entryType: "product",
        name: p.name,
        slug: p.slug,
        extra: `Category: ${p.category ?? "N/A"} | Sources: ${p.sourceCount ?? 0}`,
      }));
      const sourceRows: CatalogRow[] = sources
        .filter((s) => !s.productSlug)
        .map((s) => ({
          entryType: "source",
          name: s.name,
          slug: s.slug,
          extra: `Type: ${s.type} | URL: ${s.url}`,
        }));
      rows = [...productRows, ...sourceRows];
    }

    if (rows.length === 0) {
      return textResult("No catalog entries indexed yet.");
    }

    const text = rows
      .map((r) => [`**${r.name}** (${r.slug}) — _${r.entryType}_`, `  ${r.extra}`].join("\n"))
      .join("\n\n");

    return textResult(text);
  },
);

// ── get_source ───────────────────────────────────────────────────────
server.registerTool(
  "get_source",
  {
    description: "Get detailed information about a single changelog source",
    inputSchema: {
      identifier: z.string().describe("Source slug or ID"),
    },
  },
  async ({ identifier }) => {
    let source;
    try {
      source = await findSource(identifier);
    } catch (err) {
      // A bare slug under more than one org: surface the candidates as tool
      // text so the agent can re-call with an org/slug coordinate or src_ id,
      // rather than silently reading the wrong org's source (#264).
      if (err instanceof AmbiguousSourceError) return textResult(describeAmbiguousSource(err));
      throw err;
    }
    if (!source) {
      return textResult(`No source found matching "${identifier}"`);
    }

    const lines: string[] = [
      `**Source: ${source.name}**`,
      `Slug: ${source.slug} | Type: ${source.type}`,
      `URL: ${source.url}`,
      `Last fetched: ${source.lastFetchedAt ?? "Never"}`,
    ];

    return textResult(lines.join("\n"));
  },
);

// ── list_organizations ───────────────────────────────────────────────
server.registerTool(
  "list_organizations",
  {
    description:
      "List all indexed organizations, optionally filtered. Orgs with zero indexed releases are hidden by default (curator-stub noise); set `include_empty: true` to see them.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Search across org name, slug, domain, and account handles"),
      platform: z.string().optional().describe("Filter to orgs with an account on this platform"),
      include_empty: z
        .boolean()
        .optional()
        .describe(
          "Include orgs with zero indexed releases (curator stubs). Omit or set false to hide them.",
        ),
    },
  },
  async ({ query, platform, include_empty }) => {
    // /v1/orgs is paginated server-side post-#723; page through every result so
    // the tool truly lists all indexed organizations, not just the first page.
    const allOrgs: Awaited<ReturnType<typeof listOrgs>>["items"] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      // eslint-disable-next-line no-await-in-loop
      const result = await listOrgs({
        query,
        platform,
        page,
        limit: 200,
        includeEmpty: include_empty,
      });
      allOrgs.push(...result.items);
      hasMore = result.pagination.hasMore;
      page += 1;
    }

    if (allOrgs.length === 0) {
      return textResult("No organizations found.");
    }

    const text = allOrgs
      .map((o) =>
        [`**${o.name}**`, `  Slug: ${o.slug}`, `  Domain: ${o.domain ?? "N/A"}`].join("\n"),
      )
      .join("\n\n");

    return textResult(text);
  },
);

// ── get_organization ─────────────────────────────────────────────────
server.registerTool(
  "get_organization",
  {
    description:
      "Get detailed information about a single organization including accounts, tags, sources, products, and aliases",
    inputSchema: {
      identifier: z.string().describe("Organization slug, domain, name, or account handle"),
    },
  },
  async ({ identifier }) => {
    const org = await findOrg(identifier);
    if (!org) {
      return textResult(`No organization found matching "${identifier}"`);
    }

    const [accounts, tagRows, orgSources, orgProducts, aliases] = await Promise.all([
      getOrgAccountsBySlug(org.slug),
      getTagsForOrg(org.id),
      getSourcesByOrg(org.id),
      getProductsByOrg(org.id),
      getAliases("org", org.slug),
    ]);

    const lines: string[] = [];
    lines.push(`**Organization: ${org.name}**`);
    lines.push(
      `Slug: ${org.slug} | Domain: ${org.domain ?? "N/A"} | Category: ${org.category ?? "N/A"}`,
    );
    if (org.description) lines.push(`Description: ${org.description}`);
    lines.push("");
    lines.push(
      accounts.length > 0
        ? `Accounts: ${accounts.map((a) => `${a.platform}/${a.handle}`).join(", ")}`
        : "Accounts: none",
    );
    lines.push(tagRows.length > 0 ? `Tags: ${tagRows.join(", ")}` : "Tags: none");
    lines.push(aliases.length > 0 ? `Aliases: ${aliases.join(", ")}` : "Aliases: none");

    if (orgProducts.length > 0) {
      lines.push("");
      lines.push("Products:");
      for (const p of orgProducts) {
        const urlPart = p.url ? ` — ${p.url}` : "";
        const descPart = p.description ? ` — ${p.description}` : "";
        lines.push(`- ${p.name} (${p.slug})${urlPart}${descPart}`);
      }
    }

    if (orgSources.length > 0) {
      lines.push("");
      lines.push("Sources:");
      for (const s of orgSources) {
        lines.push(`- **${s.name}** (${s.slug})`);
        lines.push(`  Type: ${s.type} | URL: ${s.url}`);
        lines.push(`  Last fetched: ${s.lastFetchedAt ?? "Never"}`);
      }
    } else {
      lines.push("");
      lines.push("Sources: none");
    }

    return textResult(lines.join("\n"));
  },
);

// ── get_catalog_entry ─────────────────────────────────────────────────
server.registerTool(
  "get_catalog_entry",
  {
    description:
      "Get detail for a single catalog entry — a product or a standalone source. Accepts a slug, `prod_` id, or `src_` id and dispatches to the matching entity. Changelog only applies to source entries (products have none): pass `include_changelog: true` to inline the root tracked CHANGELOG, or `changelog_path` / `changelog_offset` / `changelog_limit` / `changelog_tokens` to embed a specific file or slice — heading-aligned, supports per-package files in monorepos (e.g. `packages/next/CHANGELOG.md`). `changelog_tokens` takes precedence over `changelog_limit`; any `changelog_*` param implies `include_changelog`.",
    inputSchema: {
      identifier: z
        .string()
        .describe("Product or source identifier — slug, `prod_` id, or `src_` id"),
      include_changelog: z
        .boolean()
        .optional()
        .describe(
          "When true, inline the root tracked CHANGELOG for a source-kind entry. Ignored for products.",
        ),
      changelog_path: z
        .string()
        .optional()
        .describe(
          "Specific CHANGELOG path for a source-kind entry (e.g. 'packages/next/CHANGELOG.md'). Passing this implies include_changelog.",
        ),
      changelog_offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Character offset into the selected CHANGELOG. Snapped forward to the next heading unless 0. Passing this implies include_changelog.",
        ),
      changelog_limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Target slice size in characters. Slice ends at a heading boundary. Defaults to 40000 when slicing without a token budget. Passing this implies include_changelog.",
        ),
      changelog_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Target slice size in tokens (cl100k_base). Takes precedence over changelog_limit. Recommended brackets: 2000, 5000, 10000, 20000. Passing this implies include_changelog.",
        ),
    },
  },
  async ({
    identifier,
    include_changelog,
    changelog_path,
    changelog_offset,
    changelog_limit,
    changelog_tokens,
  }) => {
    // Any changelog_* param — or the bare boolean — implies the caller wants
    // the slice inlined (mirrors the hosted tool's ChangelogRenderOptions).
    const changelogRequested =
      include_changelog === true ||
      changelog_path !== undefined ||
      changelog_offset !== undefined ||
      changelog_limit !== undefined ||
      changelog_tokens !== undefined;

    const renderProduct = async () => {
      const product = await findProduct(identifier);
      if (!product) return null;
      const lines: string[] = [
        `**Product: ${product.name}** _(product)_`,
        `Slug: ${product.slug} | Category: ${product.category ?? "N/A"}`,
      ];
      if (product.description) lines.push(`Description: ${product.description}`);
      if (product.url) lines.push(`URL: ${product.url}`);
      if (changelogRequested) {
        lines.push("");
        lines.push("Changelog does not apply to products — pass a source identifier instead.");
      }
      return textResult(lines.join("\n"));
    };

    const renderSource = async () => {
      let source;
      try {
        source = await findSource(identifier);
      } catch (err) {
        // A bare slug under more than one org: surface the candidates so the
        // agent can re-call with an org/slug coordinate or src_ id (#264).
        if (err instanceof AmbiguousSourceError) return textResult(describeAmbiguousSource(err));
        throw err;
      }
      if (!source) return null;
      const lines: string[] = [
        `**Source: ${source.name}** _(source)_`,
        `Slug: ${source.slug} | Type: ${source.type}`,
        `URL: ${source.url}`,
        `Last fetched: ${source.lastFetchedAt ?? "Never"}`,
      ];

      if (!changelogRequested) return textResult(lines.join("\n"));

      // Fetch the slice through the /changelog REST route and inline it —
      // matching how the hosted tool merges the two (#373).
      let changelog;
      try {
        changelog = await sourceChangelog(source.id, {
          path: changelog_path,
          offset: changelog_offset,
          limit: changelog_limit,
          tokens: changelog_tokens,
        });
      } catch (err) {
        if (err instanceof AmbiguousSourceError) return textResult(describeAmbiguousSource(err));
        throw err;
      }

      if (!changelog) {
        lines.push("");
        lines.push(
          `No CHANGELOG file is tracked for "${identifier}". Only GitHub sources expose this.`,
        );
        return textResult(lines.join("\n"));
      }

      lines.push("");
      lines.push(`**${changelog.path}**`);
      lines.push(`Source: ${changelog.url ?? ""}`);
      lines.push(
        `Offset: ${changelog.offset} | Total chars: ${changelog.totalChars} | Total tokens: ${changelog.totalTokens ?? "N/A"}`,
      );
      if (changelog.truncated) {
        lines.push(`WARNING: File truncated at 1MB cap.`);
      }
      if (changelog.nextOffset != null && changelog.nextOffset < changelog.totalChars) {
        lines.push(`Next offset: ${changelog.nextOffset} (pass as changelog_offset to continue)`);
      }
      lines.push("");
      lines.push(changelog.content);

      return textResult(lines.join("\n"));
    };

    // Dispatch on the identifier prefix; bare slugs try product then source
    // — unless a changelog param was passed, which only a source can satisfy,
    // so try source first (mirrors the hosted tool's tie-break, #373).
    const notFound = textResult(`No catalog entry found matching "${identifier}"`);
    if (identifier.startsWith("src_")) {
      return (await renderSource()) ?? notFound;
    }
    if (identifier.startsWith("prod_")) {
      return (await renderProduct()) ?? notFound;
    }
    if (changelogRequested) {
      return (await renderSource()) ?? (await renderProduct()) ?? notFound;
    }
    return (await renderProduct()) ?? (await renderSource()) ?? notFound;
  },
);

// ── changelog ────────────────────────────────────────────────────────
server.registerTool(
  "changelog",
  {
    description:
      "Read recent releases.sh product updates (platform rollups and CLI cuts). Returns the latest entries with titles, dates, summaries, and a link to the full changelog at https://releases.sh/updates. Same as `releases changelog`. Use this to discover new features before recommending releases.sh workflows.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_CHANGELOG_LIMIT)
        .optional()
        .describe(
          `How many entries to return (default ${DEFAULT_CHANGELOG_LIMIT}, max ${MAX_CHANGELOG_LIMIT}).`,
        ),
    },
  },
  async ({ limit }) => {
    const doc = await fetchProductChangelog({ limit });
    return textResult(JSON.stringify(doc, null, 2));
  },
);

// ── Start function ───────────────────────────────────────────────────
export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started on stdio");
}
