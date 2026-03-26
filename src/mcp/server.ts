import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { eq, desc, inArray, and } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { sources, releases, organizations, orgAccounts, fetchLog, type Source } from "../db/schema.js";
import { searchReleases } from "../db/fts.js";
import { findSourceBySlug, getRecentReleases, findOrg, getSourcesByOrg, listOrgs } from "../db/queries.js";
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
  name: "released",
  version: "0.1.0",
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

// ── summarize_changes ────────────────────────────────────────────────
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

// ── compare_products ─────────────────────────────────────────────────
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
    return textResult("No products indexed yet. Use `released add` to add sources.");
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
  description: "Trigger a fetch for a specific source or all sources",
  inputSchema: {
    slug: z.string().optional().describe("Source slug to fetch (omit to fetch all sources)"),
    force: z.boolean().optional().describe("Delete existing releases before fetching (clean re-fetch)"),
  },
}, async ({ slug, force }) => {
  const db = getDb();
  let targetSources: Source[];

  if (slug) {
    const source = await findSourceBySlug(slug);
    if (!source) {
      return textResult(`Source not found: "${slug}"`);
    }
    targetSources = [source];
  } else {
    targetSources = await db.select().from(sources);
    if (targetSources.length === 0) {
      return textResult("No sources configured. Use add_source to add one.");
    }
  }

  const results: Array<{ source: string; found: number; inserted: number; error?: string }> = [];

  for (let source of targetSources) {
    const adapter = getAdapter(source.type);
    if (!adapter) {
      results.push({ source: source.name, found: 0, inserted: 0, error: `Unknown adapter type: ${source.type}` });
      continue;
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
        results.push({ source: source.name, found: 0, inserted: 0 });
        continue;
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

      results.push({ source: source.name, found: rawReleases.length, inserted });
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
      results.push({ source: source.name, found: 0, inserted: 0, error: errMsg });
    }
  }

  const summary = results.map((r) => {
    if (r.error) return `${r.source}: error — ${r.error}`;
    return `${r.source}: ${r.found} found, ${r.inserted} new`;
  }).join("\n");

  return textResult(summary);
});

// ── add_organization ─────────────────────────────────────────────────
server.registerTool("add_organization", {
  description: "Create a new organization",
  inputSchema: {
    name: z.string().describe("Organization name"),
    domain: z.string().optional().describe("Primary domain (e.g. vercel.com)"),
    slug: z.string().optional().describe("Custom slug (auto-derived from name if omitted)"),
  },
}, async ({ name, domain, slug }) => {
  const db = getDb();
  const orgSlug = slug ?? toSlug(name);

  const existing = await findOrg(orgSlug);
  if (existing) {
    return textResult(`Organization with slug "${orgSlug}" already exists.`);
  }

  const now = new Date().toISOString();
  const [created] = await db.insert(organizations).values({
    name,
    slug: orgSlug,
    domain: domain ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning();

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

// ── Start function ───────────────────────────────────────────────────
export async function startMcpServer() {
  runMigrations();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started on stdio");
}
