import { Command } from "commander";
import chalk from "chalk";
import { unifiedSearch } from "../../db/queries.js";
import { stripAnsi } from "../../lib/sanitize.js";
import type { UnifiedSearchResponse } from "../../api/types.js";

export function registerSearchCommand(program: Command) {
  program
    .command("search")
    .description("Search across organizations, products, sources, and releases")
    .argument("<query>", "Search query")
    .option("-l, --limit <n>", "Max results per type", "10")
    .option("--type <type>", "Limit to a result type: orgs, products, sources, releases")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released search "vercel"
  released search "breaking change" --type releases
  released search "authentication" --limit 5 --json`)
    .action(async (query: string, opts: { limit: string; type?: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10);

      const response = await unifiedSearch(query, limit);

      // Filter to specific type if requested
      const types = opts.type
        ? [opts.type as keyof Omit<UnifiedSearchResponse, "query">]
        : (["orgs", "products", "sources", "releases"] as const);

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

      // ── Sources ──
      if (types.includes("sources") && response.sources.length > 0) {
        console.log(chalk.bold.underline("Sources"));
        for (const s of response.sources) {
          const org = s.orgName ? ` ${chalk.dim(`— ${stripAnsi(s.orgName)}`)}` : "";
          console.log(`  ${chalk.cyan.bold(stripAnsi(s.name))} ${chalk.dim(`(${s.slug})`)}${org}`);
        }
        console.log();
        totalResults += response.sources.length;
      }

      // ── Releases ──
      if (types.includes("releases") && response.releases.length > 0) {
        console.log(chalk.bold.underline("Releases"));
        for (const r of response.releases) {
          console.log(`  ${chalk.cyan.bold(stripAnsi(r.title))}`);
          console.log(chalk.dim(`  Source: ${stripAnsi(r.sourceName)}  |  Published: ${r.publishedAt ?? "No date"}`));
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
      }
    });
}
