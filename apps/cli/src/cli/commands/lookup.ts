import { Command } from "commander";
import chalk from "chalk";
import { lookupDomain } from "../../api/sources.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";

export function registerLookupCommand(program: Command): void {
  const lookup = program
    .command("lookup")
    .description("Resolve a domain (or other coordinate) to its registry entry")
    .showSuggestionAfterError(true)
    .action(() => {
      // Bare `releases lookup` — print sub-help.
      lookup.help();
    });

  lookup
    .command("domain")
    .description("Find the org or product that owns a given domain")
    .argument("<domain>", "Domain to resolve (URL-shaped forms are normalized)")
    .option("--json", "Output as JSON")
    .action(async (domain: string, opts: { json?: boolean }) => {
      let result;
      try {
        result = await lookupDomain(domain);
      } catch (err) {
        if (err instanceof Error && err.message.includes("(400)")) {
          // The API returns 400 when the domain doesn't normalize. Surface
          // it as a clear validation failure rather than a stack trace.
          logger.error(
            `"${domain}" doesn't look like a valid hostname (need at least \`example.com\`).`,
          );
          process.exit(1);
        }
        throw err;
      }

      if (!result) {
        if (opts.json) {
          await writeJson(null);
          return;
        }
        console.log(chalk.dim(`No org or product owns the domain ${chalk.bold(domain)}.`));
        process.exit(1);
      }

      if (opts.json) {
        await writeJson(result);
        return;
      }

      console.log(chalk.bold(`Domain: ${chalk.cyan(result.domain)}`));
      console.log("");

      if (result.org) {
        const matchLabel =
          result.org.matchedVia === "primary" ? chalk.green("primary") : chalk.yellow("alias");
        console.log(chalk.bold.underline("Organization"));
        console.log(
          `  ${chalk.cyan.bold(stripAnsi(result.org.name))} ${chalk.dim(`(${result.org.slug})`)} — matched via ${matchLabel}`,
        );
        if (result.org.matchedVia === "alias" && result.org.domain) {
          console.log(chalk.dim(`  Primary domain: ${result.org.domain}`));
        }
        if (result.org.category) {
          console.log(chalk.dim(`  Category: ${result.org.category}`));
        }
        if (result.org.description) {
          console.log(chalk.dim(`  ${stripAnsi(result.org.description)}`));
        }
        console.log("");
      }

      if (result.products.length > 0) {
        console.log(chalk.bold.underline("Products"));
        for (const p of result.products) {
          const cat = p.category ? chalk.dim(` | ${p.category}`) : "";
          console.log(
            `  ${chalk.cyan.bold(stripAnsi(p.name))} ${chalk.dim(`(${p.orgSlug}/${p.slug})`)} — by ${stripAnsi(p.orgName)}${cat}`,
          );
        }
      }
    });
}
