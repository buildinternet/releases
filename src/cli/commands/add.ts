import { Command } from "commander";
import chalk from "chalk";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, organizations, orgAccounts } from "../../db/schema.js";
import { findOrg } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";
import { discoverFeed } from "../../adapters/feed.js";

const VALID_TYPES = ["github", "scrape", "feed", "agent"] as const;
type SourceType = (typeof VALID_TYPES)[number];

function isValidType(t: string): t is SourceType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

export function isGitHubUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/.test(url);
}

function parseGitHubOwner(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * Detect if a changelog page is a blog-index (links to individual entry pages)
 * by fetching the HTML and counting child-path links.
 * Returns the crawl pattern if detected, null otherwise.
 */
async function detectCrawlPattern(sourceUrl: string): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl, {
      headers: { "User-Agent": "released/0.1 (+https://releases.sh)" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const baseUrl = sourceUrl.replace(/\/$/, "");
    const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");

    // Find all href values that are child paths of the source URL
    const hrefPattern = /href=["']([^"']+)["']/g;
    const childPaths = new Set<string>();

    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
      const href = match[1];
      try {
        // Resolve relative URLs
        const resolved = new URL(href, sourceUrl);
        // Must be same origin and a child path (deeper than the base)
        if (resolved.origin === new URL(sourceUrl).origin) {
          const path = resolved.pathname.replace(/\/$/, "");
          if (
            path.startsWith(basePath + "/") &&
            path !== basePath &&
            path.split("/").length > basePath.split("/").length
          ) {
            childPaths.add(path);
          }
        }
      } catch {
        // Skip malformed URLs
      }
    }

    // If 3+ unique child paths found, this looks like a blog-index
    if (childPaths.size >= 3) {
      return `${baseUrl}/**`;
    }

    return null;
  } catch {
    return null;
  }
}

export function registerAddCommand(program: Command) {
  program
    .command("add")
    .description("Add a new changelog source")
    .argument("<name>", "Display name for the source")
    .option("--type <type>", "Source type: github, scrape, feed, or agent (auto-detected from URL if omitted)")
    .requiredOption("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--org <org>", "Organization name or slug (creates if not found)")
    .option("--feed-url <feedUrl>", "Explicit feed URL (skips auto-discovery)")
    .action(async (name: string, opts: { type?: string; url: string; slug?: string; org?: string; feedUrl?: string }) => {
      if (opts.type && !isValidType(opts.type)) {
        console.error(chalk.red(`Invalid type "${opts.type}". Must be one of: ${VALID_TYPES.join(", ")}`));
        process.exit(1);
      }

      // Auto-detect type from URL when not specified
      let sourceType: SourceType;
      let discoveredFeedUrl: string | undefined;
      let discoveredFeedType: string | undefined;

      if (opts.feedUrl) {
        // Explicit feed URL provided — skip discovery
        sourceType = (opts.type as SourceType) ?? "scrape";
        discoveredFeedUrl = opts.feedUrl;
        discoveredFeedType = "unknown";
        logger.info(`Using provided feed URL — ${sourceType} adapter`);
      } else if (opts.type) {
        sourceType = opts.type as SourceType;
      } else if (isGitHubUrl(opts.url)) {
        sourceType = "github";
        logger.info(`Detected GitHub URL — using github adapter`);
      } else {
        // Probe for a feed to decide between scrape and feed
        logger.info(`Detecting source type for ${opts.url}...`);
        try {
          const feed = await discoverFeed(opts.url);
          if (feed) {
            // Use scrape (which tries feed first, with Cloudflare fallback)
            sourceType = "scrape";
            discoveredFeedUrl = feed.url;
            discoveredFeedType = feed.type;
            logger.info(`Found ${feed.type} feed — using scrape adapter (feed-first with fallback)`);
          } else {
            sourceType = "scrape";
            logger.info(`No feed found — using scrape adapter (Cloudflare + AI)`);
          }
        } catch {
          sourceType = "scrape";
          logger.info(`Feed detection failed — defaulting to scrape adapter`);
        }
      }

      const slug = opts.slug ?? toSlug(name);
      const db = getDb();
      let orgId: string | null = null;
      let orgName: string | null = null;

      // Resolve or create org if --org provided
      if (opts.org) {
        let org = await findOrg(opts.org);
        if (!org) {
          const orgSlug = toSlug(opts.org);
          const now = new Date().toISOString();
          const [created] = await db.insert(organizations).values({
            name: opts.org,
            slug: orgSlug,
            createdAt: now,
            updatedAt: now,
          }).returning();
          org = created;
          logger.info(`Created organization: ${org.name} (${org.slug})`);
        }
        orgId = org.id;
        orgName = org.name;
      }

      // Auto-association for GitHub sources (only if no --org specified)
      if (!opts.org && sourceType === "github") {
        const owner = parseGitHubOwner(opts.url);
        if (owner) {
          const [account] = await db
            .select({ orgId: orgAccounts.orgId, orgName: organizations.name })
            .from(orgAccounts)
            .innerJoin(organizations, eq(orgAccounts.orgId, organizations.id))
            .where(and(eq(orgAccounts.platform, "github"), eq(orgAccounts.handle, owner)));
          if (account) {
            orgId = account.orgId;
            orgName = account.orgName;
            logger.info(`Auto-linked to organization "${orgName}"`);
          }
        }
      }

      // Build initial metadata with discovered feed info
      const metadata: Record<string, unknown> = {};
      if (discoveredFeedUrl) {
        metadata.feedUrl = discoveredFeedUrl;
        metadata.feedType = discoveredFeedType;
        metadata.feedDiscoveredAt = new Date().toISOString();
        metadata.noFeedFound = false;
      }

      // For non-feed sources, detect if entries have individual pages
      if ((sourceType === "scrape" || sourceType === "agent") && !discoveredFeedUrl) {
        logger.info(`Checking for individual entry pages...`);
        const crawlPattern = await detectCrawlPattern(opts.url);
        if (crawlPattern) {
          if (sourceType === "scrape") {
            // Auto-upgrade to agent adapter for blog-index changelogs
            sourceType = "agent";
            logger.info(`Detected blog-index pattern — using agent adapter for better extraction`);
          }
          metadata.crawlPattern = crawlPattern;
        }
      }

      await db.insert(sources).values({
        name,
        slug,
        type: sourceType,
        url: opts.url,
        orgId,
        metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
      });

      const orgLabel = orgName ? ` [org: ${orgName}]` : "";
      const typeLabel = !opts.type ? ` (auto-detected: ${sourceType})` : "";
      console.log(chalk.green(`Source added: ${name} (${slug})${typeLabel}${orgLabel}`));
    });
}
