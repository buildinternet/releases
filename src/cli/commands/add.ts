import { Command } from "commander";
import chalk from "chalk";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, organizations, orgAccounts } from "../../db/schema.js";
import { findOrg, findIgnoredUrl } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";
import { discoverFeed } from "../../adapters/feed.js";
import { readFileSync } from "fs";

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

interface AddSourceInput {
  name: string;
  url: string;
  type?: string;
  slug?: string;
  org?: string;
  feedUrl?: string;
}

interface AddSourceResult {
  name: string;
  slug: string;
  type: string;
  url: string;
  org?: string;
  status: "added" | "error" | "ignored";
  error?: string;
  reason?: string;
}

async function addSingleSource(input: AddSourceInput): Promise<AddSourceResult> {
  const { name, url } = input;

  if (input.type && !isValidType(input.type)) {
    return { name, slug: input.slug ?? toSlug(name), type: input.type, url, status: "error", error: `Invalid type "${input.type}". Must be one of: ${VALID_TYPES.join(", ")}` };
  }

  // Auto-detect type from URL when not specified
  let sourceType: SourceType;
  let discoveredFeedUrl: string | undefined;
  let discoveredFeedType: string | undefined;

  if (input.feedUrl) {
    // Explicit feed URL provided — skip discovery
    sourceType = (input.type as SourceType) ?? "scrape";
    discoveredFeedUrl = input.feedUrl;
    discoveredFeedType = "unknown";
    logger.info(`Using provided feed URL — ${sourceType} adapter`);
  } else if (input.type) {
    sourceType = input.type as SourceType;
  } else if (isGitHubUrl(url)) {
    sourceType = "github";
    logger.info(`Detected GitHub URL — using github adapter`);
  } else {
    // Probe for a feed to decide between scrape and feed
    logger.info(`Detecting source type for ${url}...`);
    try {
      const feed = await discoverFeed(url);
      if (feed) {
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

  const slug = input.slug ?? toSlug(name);
  const db = getDb();
  let orgId: string | null = null;
  let orgName: string | null = null;

  // Resolve or create org if provided
  if (input.org) {
    let org = await findOrg(input.org);
    if (!org) {
      const orgSlug = toSlug(input.org);
      const now = new Date().toISOString();
      const [created] = await db.insert(organizations).values({
        name: input.org,
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

  // Auto-association for GitHub sources (only if no org specified)
  if (!input.org && sourceType === "github") {
    const owner = parseGitHubOwner(url);
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
    const crawlPattern = await detectCrawlPattern(url);
    if (crawlPattern) {
      if (sourceType === "scrape") {
        sourceType = "agent";
        logger.info(`Detected blog-index pattern — using agent adapter for better extraction`);
      }
      metadata.crawlPattern = crawlPattern;
    }
  }

  // Check if URL is on the ignore list before inserting
  const ignoredEntry = await findIgnoredUrl(url);
  if (ignoredEntry) {
    logger.warn(`Skipping ignored URL: ${url}${ignoredEntry.reason ? ` (${ignoredEntry.reason})` : ""}`);
    return { name, slug, type: sourceType, url, org: orgName ?? undefined, status: "ignored", reason: ignoredEntry.reason ?? undefined };
  }

  try {
    await db.insert(sources).values({
      name,
      slug,
      type: sourceType,
      url,
      orgId,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, slug, type: sourceType, url, org: orgName ?? undefined, status: "error", error: message };
  }

  return { name, slug, type: sourceType, url, org: orgName ?? undefined, status: "added" };
}

export function registerAddCommand(program: Command) {
  program
    .command("add")
    .description("Add a new changelog source")
    .argument("[name]", "Display name for the source")
    .option("--type <type>", "Source type: github, scrape, feed, or agent (auto-detected from URL if omitted)")
    .option("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--org <org>", "Organization name or slug (creates if not found)")
    .option("--feed-url <feedUrl>", "Explicit feed URL (skips auto-discovery)")
    .option("--batch <file>", "JSON file with sources to add (use - for stdin)")
    .option("--json", "Output as JSON")
    .action(async (name: string | undefined, opts: { type?: string; url?: string; slug?: string; org?: string; feedUrl?: string; batch?: string; json?: boolean }) => {
      // --- Batch mode ---
      if (opts.batch) {
        let raw: string;
        if (opts.batch === "-") {
          raw = await Bun.stdin.text();
        } else {
          raw = readFileSync(opts.batch, "utf-8");
        }

        let entries: AddSourceInput[];
        try {
          entries = JSON.parse(raw);
        } catch {
          logger.error("Failed to parse batch JSON input");
          process.exit(1);
        }

        if (!Array.isArray(entries)) {
          logger.error("Batch input must be a JSON array");
          process.exit(1);
        }

        // Validate each entry has required fields
        for (const [i, entry] of entries.entries()) {
          if (!entry.name || !entry.url) {
            logger.error(`Entry ${i} is missing required "name" or "url" field`);
            process.exit(1);
          }
        }

        const results: AddSourceResult[] = [];
        let hasError = false;

        for (const entry of entries) {
          const result = await addSingleSource(entry);
          results.push(result);

          if (result.status === "error") {
            hasError = true;
            if (!opts.json) {
              logger.error(chalk.red(`Failed to add ${result.name}: ${result.error}`));
            }
          } else if (result.status === "ignored") {
            if (!opts.json) {
              logger.info(chalk.yellow(`Skipped (ignored): ${result.name} (${result.url})${result.reason ? ` — ${result.reason}` : ""}`));
            }
          } else if (!opts.json) {
            const orgLabel = result.org ? ` [org: ${result.org}]` : "";
            logger.info(chalk.green(`Source added: ${result.name} (${result.slug}) [${result.type}]${orgLabel}`));
          }
        }

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
        }

        if (hasError) {
          process.exit(1);
        }
        return;
      }

      // --- Single-add mode ---
      if (!name) {
        logger.error("Missing required argument: name (or use --batch for batch mode)");
        process.exit(1);
      }
      if (!opts.url) {
        logger.error("Missing required option: --url");
        process.exit(1);
      }

      const result = await addSingleSource({
        name,
        url: opts.url,
        type: opts.type,
        slug: opts.slug,
        org: opts.org,
        feedUrl: opts.feedUrl,
      });

      if (result.status === "error") {
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          logger.error(chalk.red(result.error!));
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const orgLabel = result.org ? ` [org: ${result.org}]` : "";
        const typeLabel = !opts.type ? ` (auto-detected: ${result.type})` : "";
        console.log(chalk.green(`Source added: ${result.name} (${result.slug})${typeLabel}${orgLabel}`));
      }
    });
}
