import { Command } from "commander";
import chalk from "chalk";
import { unifiedSearch } from "../../db/queries.js";
import { stripAnsi } from "../../lib/sanitize.js";
import type { UnifiedSearchResponse } from "../../api/types.js";

export function registerSearchCommand(program: Command) {
  program
    .command("search")
    .description("Search across organizations, products, and releases")
    .argument("<query>", "Search query")
    .option("-l, --limit <n>", "Max results per type", "10")
    .option("--type <type>", "Limit to a result type: orgs, products, releases")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases search "vercel"
  releases search "breaking change" --type releases
  releases search "authentication" --limit 5 --json`)
    .action(async (query: string, opts: { limit: string; type?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10);

      const response = await unifiedSearch(query, limit);

      // Filter to specific type if requested
      const types = opts.type
        ? [opts.type as keyof Omit<UnifiedSearchResponse, "query">]
        : (["orgs", "products", "releases"] as const);

      if (opts.json) {
        const filtered: Record<string, unknown> = { query: response.query };
        for (const t of types) filtered[t] = response[t];
        console.log(JSON.stringify(filtered, null, 2));
        return;
      }

      let totalResults = 0;

      // ── Orgs ──
      if (types.includes("orgs") && response.orgs.length > 0) {
        console.log(chalk.bold.underline("Organizations"));
        for (const org of response.orgs) {
          const meta = [org.category, org.domain].filter(Boolean).join(" | ");
          console.log(`  ${chalk.cyan.bold(stripAnsi(org.name))} ${chalk.dim(`(${org.slug})`)}`);
          if (meta) console.log(`  ${chalk.dim(meta)}`);
        }
        console.log();
        totalResults += response.orgs.length;
      }

      // ── Products ──
      if (types.includes("products") && response.products.length > 0) {
        console.log(chalk.bold.underline("Products"));
        for (const p of response.products) {
          const org = p.orgName ? ` ${chalk.dim(`by ${stripAnsi(p.orgName)}`)}` : "";
          console.log(`  ${chalk.cyan.bold(stripAnsi(p.name))} ${chalk.dim(`(${p.slug})`)}${org}`);
        }
        console.log();
        totalResults += response.products.length;
      }

      // ── Releases ──
      if (types.includes("releases") && response.releases.length > 0) {
        console.log(chalk.bold.underline("Releases"));
        for (const r of response.releases) {
          const idLabel = r.id ? ` ${chalk.dim(r.id.slice(0, 12))}` : "";
          console.log(`  ${chalk.cyan.bold(stripAnsi(r.title))}${idLabel}`);
          console.log(chalk.dim(`  Source: ${stripAnsi(r.sourceName)} (${r.sourceSlug})  |  Published: ${r.publishedAt ?? "No date"}`));
          const summary = stripAnsi(r.summary);
          console.log(`  ${summary}${summary.length >= 150 ? "..." : ""}`);
          console.log();
        }
        totalResults += response.releases.length;
      }

      if (totalResults === 0) {
        console.log(chalk.yellow("No results found."));
      } else {
        console.log(chalk.dim(`${totalResults} result(s) found.`));
        console.log(chalk.dim(`  More: "releases show <id|slug>" to drill into any result · "releases latest --org <slug>" for an org's releases`));
      }
    });
}
