import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { eq, desc, inArray, and } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { sources, releases, organizations, orgAccounts, fetchLog, type Source } from "../db/schema.js";
import { searchReleases } from "../db/fts.js";
import {
  findSourceBySlug, getRecentReleases, findOrg, getSourcesByOrg, listOrgs,
  isUrlExcluded, listIgnoredUrls, addIgnoredUrl, removeIgnoredUrl,
  listBlockedUrls, addBlockedUrl, removeBlockedUrl,
  suppressRelease, unsuppressRelease, createOrg,
} from "../db/queries.js";
import { summarizeReleases, compareProducts, toReleaseInput } from "../ai/query.js";
import { daysAgoIso } from "../lib/dates.js";
import { toSlug } from "../lib/slug.js";
import { logger } from "../lib/logger.js";
import { getAdapter, contentHash } from "../adapters/resolve.js";
import { isGitHubUrl } from "../cli/commands/add.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({
  name: "releases",
  version: "0.9.1",
});

// ── search_releases ──────────────────────────────────────────────────
server.registerTool("search_releases", {
  description: "Full-text search across all indexed release notes",
  inputSchema: {
    query: z.string().describe("Search query"),
    product: z.string().optional().describe("Filter to a specific product slug"),
    organization: z.string().optional().describe("Filter to sources belonging to this organization"),
    limit: z.number().optional().describe("Max results to return (default 20)"),
  },
}, async ({ query, product, organization, limit }) => {
  const db = getDb();
  const maxResults = limit ?? 20;

  // Build a set of allowed source IDs when filtering by org
  let orgSourceIds: Set<string> | undefined;
  if (organization) {
    const org = await findOrg(organization);
    if (!org) {
      return textResult(`No organization found matching "${organization}"`);
    }
    const orgSources = await getSourcesByOrg(org.id);
    orgSourceIds = new Set(orgSources.map((s) => s.id));
  }

  // Fetch more than needed when filtering, since FTS limit applies globally
  const needsPostFilter = product || orgSourceIds;
  let results = searchReleases(query, needsPostFilter ? maxResults * 5 : maxResults);

  if (product) {
    const source = await findSourceBySlug(product);
    if (!source) {
      return textResult(`No product found with slug "${product}"`);
    }
    const sourceReleases = await db
      .select({ id: releases.id })
      .from(releases)
      .where(eq(releases.sourceId, source.id));
    const sourceReleaseIds = new Set(sourceReleases.map((r) => r.id));
    results = results.filter((r) => sourceReleaseIds.has(r.id));
  }

  if (orgSourceIds) {
    // FTS results have release IDs; look up their sourceId to filter
    const releaseRows = await db
      .select({ id: releases.id, sourceId: releases.sourceId })
      .from(releases)
      .where(inArray(releases.id, results.map((r) => r.id)));
    const releaseSourceMap = new Map(releaseRows.map((r) => [r.id, r.sourceId]));
    results = results.filter((r) => {
      const sid = releaseSourceMap.get(r.id);
      return sid !== undefined && orgSourceIds!.has(sid);
    });
  }

  results = results.slice(0, maxResults);

  if (results.length === 0) {
    return textResult("No releases found matching the query.");
  }

  const text = results
    .map((r) => {
      const preview = (r.contentSummary || r.content).slice(0, 300);
      return `**${r.title}**\n${preview}`;
    })
    .join("\n\n---\n\n");

  return textResult(text);
});

// ── get_latest_releases ──────────────────────────────────────────────
server.registerTool("get_latest_releases", {
  description: "Get the most recent releases, optionally filtered by product or organization",
  inputSchema: {
    product: z.string().optional().describe("Filter to a specific product slug"),
    organization: z.string().optional().describe("Filter to sources belonging to this organization"),
    count: z.number().optional().describe("Number of releases to return (default 10)"),
  },
}, async ({ product, organization, count }) => {
  const db = getDb();
  const maxCount = count ?? 10;

  let sourceFilter: string | undefined;
  if (product) {
    const source = await findSourceBySlug(product);
    if (!source) {
      return textResult(`No product found with slug "${product}"`);
    }
    sourceFilter = source.id;
  }

  // Resolve org filter to a set of source IDs
  let orgSourceIds: Set<string> | undefined;
  if (organization) {
    const org = await findOrg(organization);
    if (!org) {
      return textResult(`No organization found matching "${organization}"`);
    }
    const orgSources = await getSourcesByOrg(org.id);
    orgSourceIds = new Set(orgSources.map((s) => s.id));
  }

  const query = db
    .select({
      id: releases.id,
      title: releases.title,
      version: releases.version,
      content: releases.content,
      contentSummary: releases.contentSummary,
      publishedAt: releases.publishedAt,
      sourceId: releases.sourceId,
    })
    .from(releases);

  // Apply source-level filters
  const conditions: ReturnType<typeof eq>[] = [];
  if (sourceFilter !== undefined) {
    conditions.push(eq(releases.sourceId, sourceFilter));
  }
  if (orgSourceIds) {
    const ids = [...orgSourceIds];
    if (ids.length === 0) {
      return textResult("No sources found for this organization.");
    }
    conditions.push(inArray(releases.sourceId, ids));
  }

  const filtered = conditions.length > 0
    ? query.where(and(...conditions))
    : query;

  const rows = await filtered
    .orderBy(desc(releases.publishedAt))
    .limit(maxCount);

  if (rows.length === 0) {
    return textResult("No releases found.");
  }

  // Fetch only the sources referenced in results
  const uniqueSourceIds = [...new Set(rows.map((r) => r.sourceId))];
  const sourceRows = await db.select().from(sources).where(inArray(sources.id, uniqueSourceIds));
  const sourceMap = new Map(sourceRows.map((s) => [s.id, s.name]));

  const text = rows
    .map((r) => {
      const sourceName = sourceMap.get(r.sourceId) ?? "Unknown";
      const preview = (r.contentSummary || r.content).slice(0, 500);
      return [
        `**${r.title}**`,
        `Source: ${sourceName} | Version: ${r.version ?? "N/A"} | Date: ${r.publishedAt ?? "N/A"}`,
        preview,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return textResult(text);
});

// ── AI tools (gated by ENABLE_AI_TOOLS env var) ─────────────────────
if (process.env.ENABLE_AI_TOOLS === "true") {
  server.registerTool("summarize_changes", {
    description: "Get an AI-generated summary of recent changes for a product",
    inputSchema: {
      product: z.string().describe("Product slug"),
      days: z.number().optional().describe("Look back this many days (default 30)"),
      instructions: z.string().optional().describe("Additional guidance for the summary (e.g. what to focus on, audience, format)"),
    },
  }, async ({ product, days, instructions }) => {
    const lookback = days ?? 30;
    const source = await findSourceBySlug(product);
    if (!source) {
      return textResult(`No product found with slug "${product}"`);
    }

    const recentReleases = await getRecentReleases(source.id, daysAgoIso(lookback));

    if (recentReleases.length === 0) {
      return textResult(`No releases found for "${product}" in the last ${lookback} days.`);
    }

    const summary = await summarizeReleases(recentReleases.map(toReleaseInput), { instructions });
    return textResult(summary);
  });

  server.registerTool("compare_products", {
    description: "Compare recent changes between two products",
    inputSchema: {
      products: z.array(z.string()).describe("Array of two product slugs to compare"),
      days: z.number().optional().describe("Look back this many days (default 30)"),
    },
  }, async ({ products, days }) => {
    const lookback = days ?? 30;

    if (products.length < 2) {
      return textResult("Please provide at least two product slugs.");
    }

    const cutoff = daysAgoIso(lookback);

    const [sourceA, sourceB] = await Promise.all([
      findSourceBySlug(products[0]),
      findSourceBySlug(products[1]),
    ]);

    if (!sourceA) return textResult(`No product found with slug "${products[0]}"`);
    if (!sourceB) return textResult(`No product found with slug "${products[1]}"`);

    const [releasesA, releasesB] = await Promise.all([
      getRecentReleases(sourceA.id, cutoff),
      getRecentReleases(sourceB.id, cutoff),
    ]);

    const comparison = await compareProducts(
      { name: sourceA.name, releases: releasesA.map(toReleaseInput) },
      { name: sourceB.name, releases: releasesB.map(toReleaseInput) },
    );

    return textResult(comparison);
  });
}

// ── list_products ────────────────────────────────────────────────────
server.registerTool("list_products", {
  description: "List all indexed products/sources",
  inputSchema: {
    organization: z.string().optional().describe("Filter to sources belonging to this organization"),
  },
}, async ({ organization }) => {
  const db = getDb();
  let allSources;

  if (organization) {
    const org = await findOrg(organization);
    if (!org) {
      return textResult(`No organization found matching "${organization}"`);
    }
    allSources = await getSourcesByOrg(org.id);
  } else {
    allSources = await db.select().from(sources);
  }

  if (allSources.length === 0) {
    return textResult("No products indexed yet. Use `releases add` to add sources.");
  }

  const text = allSources
    .map((s) =>
      [
        `**${s.name}**`,
        `  Slug: ${s.slug}`,
        `  Type: ${s.type}`,
        `  URL: ${s.url}`,
        `  Last fetched: ${s.lastFetchedAt ?? "Never"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return textResult(text);
});

// ── list_organizations ───────────────────────────────────────────────
server.registerTool("list_organizations", {
  description: "List all indexed organizations, optionally filtered",
  inputSchema: {
    query: z.string().optional().describe("Search across org name, slug, domain, and account handles"),
    platform: z.string().optional().describe("Filter to orgs with an account on this platform"),
  },
}, async ({ query, platform }) => {
  const allOrgs = await listOrgs({ query, platform });

  if (allOrgs.length === 0) {
    return textResult("No organizations found.");
  }

  const text = allOrgs
    .map((o) => [
      `**${o.name}**`,
      `  Slug: ${o.slug}`,
      `  Domain: ${o.domain ?? "N/A"}`,
    ].join("\n"))
    .join("\n\n");

  return textResult(text);
});

// ── add_source ───────────────────────────────────────────────────────
server.registerTool("add_source", {
  description: "Add a new changelog source to the index",
  inputSchema: {
    name: z.string().describe("Display name for the source"),
    url: z.string().describe("URL of the changelog source"),
    type: z.string().optional().describe("Source type: github, scrape, feed, or agent (auto-detected from URL if omitted)"),
    slug: z.string().optional().describe("Custom slug (auto-derived from name if omitted)"),
    organization: z.string().optional().describe("Organization slug, name, or domain to associate"),
  },
}, async ({ name, url, type, slug, organization }) => {
  const db = getDb();
  const validTypes = ["github", "scrape", "feed", "agent"];

  if (type && !validTypes.includes(type)) {
    return textResult(`Invalid type "${type}". Must be one of: ${validTypes.join(", ")}`);
  }

  let sourceType = type ?? (isGitHubUrl(url) ? "github" : "scrape");
  const sourceSlug = slug ?? toSlug(name);

  const existing = await findSourceBySlug(sourceSlug);
  if (existing) {
    return textResult(`Source with slug "${sourceSlug}" already exists.`);
  }

  let orgId: string | null = null;
  if (organization) {
    const org = await findOrg(organization);
    if (!org) {
      return textResult(`Organization not found: "${organization}"`);
    }
    orgId = org.id;
  }

  // Check if URL is blocked or ignored for this org
  const exclusion = await isUrlExcluded(url, orgId ?? undefined);
  if (exclusion.excluded) {
    const label = exclusion.scope === "blocked" ? "globally blocked" : "ignored for this organization";
    return textResult(`URL is ${label}: ${url}${exclusion.reason ? ` (${exclusion.reason})` : ""}`);
  }

  await db.insert(sources).values({
    name,
    slug: sourceSlug,
    type: sourceType as "github" | "scrape" | "feed" | "agent",
    url,
    orgId,
  });

  return textResult(`Source added: ${name} (${sourceSlug}), type: ${sourceType}`);
});

// ── remove_source ────────────────────────────────────────────────────
server.registerTool("remove_source", {
  description: "Remove a changelog source and all its releases",
  inputSchema: {
    slug: z.string().describe("Slug of the source to remove"),
  },
}, async ({ slug }) => {
  const db = getDb();
  const source = await findSourceBySlug(slug);
  if (!source) {
    return textResult(`Source not found: "${slug}"`);
  }

  await db.delete(sources).where(eq(sources.slug, slug));
  return textResult(`Removed source: ${source.name} (${slug})`);
});

// ── fetch_source ─────────────────────────────────────────────────────
server.registerTool("fetch_source", {
  description: "Trigger a fetch for a specific source by slug",
  inputSchema: {
    slug: z.string().describe("Source slug to fetch (required)"),
    force: z.boolean().optional().describe("Delete existing releases before fetching (clean re-fetch)"),
  },
}, async ({ slug, force }) => {
  const db = getDb();

  const foundSource = await findSourceBySlug(slug);
  if (!foundSource) {
    return textResult(`Source not found: "${slug}"`);
  }
  let source: Source = foundSource;

  const adapter = getAdapter(source.type);
  if (!adapter) {
    return textResult(`Unknown adapter type: ${source.type}`);
  }

  const startTime = performance.now();

  try {
    if (force) {
      await db.delete(releases).where(eq(releases.sourceId, source.id));
      await db.update(sources).set({ lastContentHash: null }).where(eq(sources.id, source.id));
      source = { ...source, lastContentHash: null };
    }

    const result = await adapter.fetch(source);
    const rawReleases = result.releases;

    if (rawReleases.length === 0) {
      await db.insert(fetchLog).values({
        sourceId: source.id,
        releasesFound: 0,
        releasesInserted: 0,
        durationMs: Math.round(performance.now() - startTime),
        status: "no_change",
        rawContent: result.rawContent ?? null,
      });
      return textResult(`${source.name}: no changes`);
    }

    const rows = rawReleases.map((raw) => ({
      sourceId: source.id,
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: raw.url ?? null,
      contentHash: contentHash(raw),
      publishedAt: raw.publishedAt?.toISOString() ?? null,
    }));

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = await db.insert(releases).values(rows.slice(i, i + 500)).onConflictDoNothing().returning({ id: releases.id });
      inserted += batch.length;
    }

    await db.update(sources).set({ lastFetchedAt: new Date().toISOString() }).where(eq(sources.id, source.id));

    await db.insert(fetchLog).values({
      sourceId: source.id,
      releasesFound: rawReleases.length,
      releasesInserted: inserted,
      durationMs: Math.round(performance.now() - startTime),
      status: inserted > 0 ? "success" : "no_change",
      rawContent: result.rawContent ?? null,
    });

    const summary = `${source.name}: ${rawReleases.length} found, ${inserted} new`;
    return textResult(summary);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.insert(fetchLog).values({
      sourceId: source.id,
      releasesFound: 0,
      releasesInserted: 0,
      durationMs: Math.round(performance.now() - startTime),
      status: "error",
      error: errMsg,
      rawContent: null,
    }).catch(() => {});
    return textResult(`${source.name}: error — ${errMsg}`);
  }
});

// ── add_organization ─────────────────────────────────────────────────
server.registerTool("add_organization", {
  description: "Create a new organization",
  inputSchema: {
    name: z.string().describe("Organization name"),
    domain: z.string().optional().describe("Primary domain (e.g. vercel.com)"),
    slug: z.string().optional().describe("Custom slug (auto-derived from name if omitted)"),
    description: z.string().optional().describe("Brief product description, one sentence (e.g. 'Event-driven durable workflow engine for TypeScript')"),
  },
}, async ({ name, domain, slug, description }) => {
  const orgSlug = slug ?? toSlug(name);

  const existing = await findOrg(orgSlug);
  if (existing) {
    return textResult(`Organization with slug "${orgSlug}" already exists.`);
  }

  const created = await createOrg(name, { slug: orgSlug, domain, description });
  return textResult(`Organization added: ${created.name} (${created.slug})`);
});

// ── link_account ─────────────────────────────────────────────────────
server.registerTool("link_account", {
  description: "Link a platform account to an organization",
  inputSchema: {
    organization: z.string().describe("Organization slug, name, or domain"),
    platform: z.string().describe("Platform name (github, x, linkedin, etc.)"),
    handle: z.string().describe("Account handle on the platform"),
  },
}, async ({ organization, platform, handle }) => {
  const db = getDb();
  const org = await findOrg(organization);
  if (!org) {
    return textResult(`Organization not found: "${organization}"`);
  }

  await db.insert(orgAccounts).values({
    orgId: org.id,
    platform,
    handle,
  });

  await db
    .update(organizations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(organizations.id, org.id));

  return textResult(`Linked ${platform}/${handle} to ${org.name}`);
});

// ── list_ignored_urls ─────────────────────────────────────────────────
server.registerTool("list_ignored_urls", {
  description: "List URLs ignored for a specific organization (excluded from discovery)",
  inputSchema: {
    organization: z.string().describe("Organization slug, name, or domain"),
  },
}, async ({ organization }) => {
  const org = await findOrg(organization);
  if (!org) return textResult(`Organization not found: "${organization}"`);

  const rows = await listIgnoredUrls(org.id);
  if (rows.length === 0) return textResult(`No ignored URLs for ${org.name}.`);

  const text = rows.map((r) => `- ${r.url}${r.reason ? ` — ${r.reason}` : ""}`).join("\n");
  return textResult(`Ignored URLs for ${org.name}:\n${text}`);
});

// ── ignore_url ───────────────────────────────────────────────────────
server.registerTool("ignore_url", {
  description: "Ignore a URL for a specific organization to prevent re-discovery",
  inputSchema: {
    url: z.string().describe("URL to ignore"),
    organization: z.string().describe("Organization slug, name, or domain"),
    reason: z.string().optional().describe("Why this URL is being ignored"),
  },
}, async ({ url, organization, reason }) => {
  const org = await findOrg(organization);
  if (!org) return textResult(`Organization not found: "${organization}"`);

  await addIgnoredUrl(url, org.id, reason);
  return textResult(`Ignored for ${org.name}: ${url}`);
});

// ── unignore_url ─────────────────────────────────────────────────────
server.registerTool("unignore_url", {
  description: "Remove a URL from an organization's ignore list",
  inputSchema: {
    url: z.string().describe("URL to un-ignore"),
    organization: z.string().describe("Organization slug, name, or domain"),
  },
}, async ({ url, organization }) => {
  const org = await findOrg(organization);
  if (!org) return textResult(`Organization not found: "${organization}"`);

  await removeIgnoredUrl(url, org.id);
  return textResult(`Un-ignored for ${org.name}: ${url}`);
});

// ── list_blocked_urls ────────────────────────────────────────────────
server.registerTool("list_blocked_urls", {
  description: "List globally blocked URL patterns (spam, aggregators, etc.)",
  inputSchema: {},
}, async () => {
  const rows = await listBlockedUrls();
  if (rows.length === 0) return textResult("No blocked patterns.");

  const text = rows.map((r) => {
    const typeLabel = r.type === "domain" ? "[domain]" : "[exact]";
    return `- ${typeLabel} ${r.pattern}${r.reason ? ` — ${r.reason}` : ""}`;
  }).join("\n");
  return textResult(`Blocked patterns:\n${text}`);
});

// ── block_url ────────────────────────────────────────────────────────
server.registerTool("block_url", {
  description: "Globally block a URL or domain from being added as a source",
  inputSchema: {
    pattern: z.string().describe("URL or domain to block"),
    type: z.enum(["exact", "domain"]).optional().describe("Block type: exact URL or entire domain (default: exact)"),
    reason: z.string().optional().describe("Why this is being blocked"),
  },
}, async ({ pattern, type, reason }) => {
  const resolvedType = type ?? "exact";
  await addBlockedUrl(pattern, resolvedType, reason);
  const label = resolvedType === "domain" ? "domain" : "URL";
  return textResult(`Blocked ${label}: ${pattern}`);
});

// ── unblock_url ──────────────────────────────────────────────────────
server.registerTool("unblock_url", {
  description: "Remove a URL or domain from the global block list",
  inputSchema: {
    pattern: z.string().describe("URL or domain pattern to unblock"),
  },
}, async ({ pattern }) => {
  await removeBlockedUrl(pattern);
  return textResult(`Unblocked: ${pattern}`);
});

// ── suppress_release ─────────────────────────────────────────────────
server.registerTool("suppress_release", {
  description: "Suppress a release so it no longer appears in queries or search results. Useful for filtering out promotional content or non-changelog entries from an otherwise good source.",
  inputSchema: {
    id: z.string().describe("Release ID to suppress"),
    reason: z.string().optional().describe("Why this release is being suppressed (e.g. 'promotional content')"),
  },
}, async ({ id, reason }) => {
  const found = await suppressRelease(id, reason);
  if (!found) return textResult(`Release not found: "${id}"`);
  return textResult(`Suppressed release ${id}${reason ? ` (${reason})` : ""}`);
});

// ── unsuppress_release ───────────────────────────────────────────────
server.registerTool("unsuppress_release", {
  description: "Restore a suppressed release so it appears in queries again",
  inputSchema: {
    id: z.string().describe("Release ID to unsuppress"),
  },
}, async ({ id }) => {
  const found = await unsuppressRelease(id);
  if (!found) return textResult(`Release not found: "${id}"`);
  return textResult(`Unsuppressed release ${id}`);
});

// ── Start function ───────────────────────────────────────────────────
export async function startMcpServer() {
  runMigrations();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started on stdio");
}
