import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { findOrg, getOrgAccountByPlatform, findSourcesByUrls, createSource } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";
import { discover, type DiscoveredSource } from "../../lib/discover.js";

export function registerDiscoverCommand(program: Command) {
  program
    .command("discover")
    .description("Discover changelog sources for a domain or organization")
    .argument("[domain]", "Domain to scan (e.g. vercel.com)")
    .option("--org <org>", "Use an existing org's domain and GitHub handle")
    .option("--add", "Add all discovered sources (default: dry-run)")
    .option("--verify", "Use AI to verify candidates and suggest additional URLs")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released discover vercel.com
  released discover --org acme
  released discover vercel.com --add
  released discover vercel.com --verify --json`)
    .action(async (domain: string | undefined, opts: { org?: string; add?: boolean; verify?: boolean; json?: boolean }) => {
      let scanDomain: string | undefined = domain;
      let githubHandle: string | undefined;
      let orgId: string | null = null;
      let orgName: string | null = null;

      // Resolve org if --org provided
      if (opts.org) {
        const org = await findOrg(opts.org);
        if (!org) {
          console.error(chalk.red(`Organization not found: ${opts.org}`));
          process.exit(1);
        }
        orgId = org.id;
        orgName = org.name;

        if (!scanDomain && org.domain) {
          scanDomain = org.domain;
        }

        const ghAccount = await getOrgAccountByPlatform(org.id, "github");
        if (ghAccount) {
          githubHandle = ghAccount.handle;
        }
      }

      if (!scanDomain && !githubHandle) {
        console.error("Error: provide a domain or use --org\n");
        console.error("  released discover vercel.com");
        console.error("  released discover --org acme");
        process.exit(1);
      }

      const { sources: results, provider } = await discover({
        domain: scanDomain,
        githubHandle,
        verify: opts.verify,
      });

      if (results.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ sources: [], provider: provider?.name ?? null }, null, 2));
        } else {
          console.log(chalk.yellow("No changelog sources discovered."));
        }
        return;
      }

      // JSON output
      if (opts.json) {
        console.log(JSON.stringify({ sources: results, provider: provider?.name ?? null }, null, 2));
        if (!opts.add) return;
      }

      // Table output (dry-run or before adding)
      if (!opts.json) {
        if (provider) {
          console.log(chalk.dim(`Provider detected: ${chalk.bold(provider.name)}\n`));
        }

        const table = new Table({
          head: [
            chalk.cyan("URL"),
            chalk.cyan("Type"),
            chalk.cyan("Method"),
            chalk.cyan("Confidence"),
            chalk.cyan("Label"),
          ],
        });

        for (const r of results) {
          table.push([
            r.url,
            r.type,
            r.method,
            confidenceColor(r.confidence),
            r.label ?? chalk.dim("—"),
          ]);
        }

        console.log(table.toString());
        console.log(chalk.dim(`\n${results.length} source(s) discovered.`));
      }

      if (!opts.add) {
        if (!opts.json) {
          console.log(chalk.dim("Run with --add to add these as sources."));
        }
        return;
      }

      // Add sources — batch URL check to avoid N+1
      const existingSources = await findSourcesByUrls(results.map((r) => r.url));
      const existingUrls = new Set(existingSources.map((s) => s.url));
      let added = 0;
      let skipped = 0;

      for (const r of results) {
        if (existingUrls.has(r.url)) {
          const existing = existingSources.find((s) => s.url === r.url);
          logger.info(`Skipping ${r.url} — already exists as "${existing?.slug}"`);
          skipped++;
          continue;
        }

        const name = buildSourceName(r);
        const slug = toSlug(name);

        // Build metadata with provider and feed info
        const metadata: Record<string, unknown> = {};
        if (r.type === "feed") {
          metadata.feedUrl = r.url;
          metadata.feedDiscoveredAt = new Date().toISOString();
          metadata.noFeedFound = false;
        }
        if (r.provider) {
          metadata.provider = r.provider;
          metadata.providerDetectedAt = new Date().toISOString();
        }
        if (provider?.hints.crawlPattern) {
          metadata.crawlPattern = provider.hints.crawlPattern;
        }

        try {
          await createSource({
            name,
            slug,
            type: r.type,
            url: r.url,
            orgId,
            metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
          });
          added++;
          logger.info(`Added: ${name} (${slug})`);
        } catch (err) {
          // Likely a slug collision — try with a suffix
          const suffixedSlug = `${slug}-${r.method}`;
          try {
            await createSource({
              name,
              slug: suffixedSlug,
              type: r.type,
              url: r.url,
              orgId,
              metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
            });
            added++;
            logger.info(`Added: ${name} (${suffixedSlug})`);
          } catch {
            logger.warn(`Failed to add ${r.url}: ${err}`);
            skipped++;
          }
        }
      }

      const orgLabel = orgName ? ` for ${orgName}` : "";
      console.log(chalk.green(`Added ${added} source(s)${orgLabel}.`));
      if (skipped > 0) {
        console.log(chalk.dim(`${skipped} skipped (already exist or failed).`));
      }
    });
}

function confidenceColor(confidence: string): string {
  switch (confidence) {
    case "high": return chalk.green(confidence);
    case "medium": return chalk.yellow(confidence);
    case "low": return chalk.red(confidence);
    default: return confidence;
  }
}

function buildSourceName(r: DiscoveredSource): string {
  if (r.type === "github" && r.label) {
    return r.label;
  }
  try {
    const host = new URL(r.url).hostname.replace(/^www\./, "");
    const path = new URL(r.url).pathname.replace(/\/$/, "");
    if (path && path !== "/") {
      return `${host}${path}`;
    }
    return host;
  } catch {
    return r.url;
  }
}
