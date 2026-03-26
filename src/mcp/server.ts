import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { eq, desc, inArray } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { sources, releases } from "../db/schema.js";
import { searchReleases } from "../db/fts.js";
import { findSourceBySlug, getRecentReleases } from "../db/queries.js";
import { summarizeReleases, compareProducts, toReleaseInput } from "../ai/query.js";
import { daysAgoIso } from "../lib/dates.js";
import { logger } from "../lib/logger.js";

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
    limit: z.number().optional().describe("Max results to return (default 20)"),
  },
}, async ({ query, product, limit }) => {
  const db = getDb();
  const maxResults = limit ?? 20;

  // Fetch more than needed when filtering by product, since FTS limit applies globally
  let results = searchReleases(query, product ? maxResults * 5 : maxResults);

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
    results = results.filter((r) => sourceReleaseIds.has(r.id)).slice(0, maxResults);
  }

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
  description: "Get the most recent releases, optionally filtered by product",
  inputSchema: {
    product: z.string().optional().describe("Filter to a specific product slug"),
    count: z.number().optional().describe("Number of releases to return (default 10)"),
  },
}, async ({ product, count }) => {
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

  const filtered = sourceFilter !== undefined
    ? query.where(eq(releases.sourceId, sourceFilter))
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
  },
}, async ({ product, days }) => {
  const lookback = days ?? 30;
  const source = await findSourceBySlug(product);
  if (!source) {
    return textResult(`No product found with slug "${product}"`);
  }

  const recentReleases = await getRecentReleases(source.id, daysAgoIso(lookback));

  if (recentReleases.length === 0) {
    return textResult(`No releases found for "${product}" in the last ${lookback} days.`);
  }

  const summary = await summarizeReleases(recentReleases.map(toReleaseInput));
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
}, async () => {
  const db = getDb();
  const allSources = await db.select().from(sources);

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

// ── Start function ───────────────────────────────────────────────────
export async function startMcpServer() {
  runMigrations();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started on stdio");
}
