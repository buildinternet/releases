import chalk from "chalk";
import { suggestOrgs, suggestSources } from "../db/queries.js";

export async function orgNotFound(identifier: string): Promise<never> {
  console.error(chalk.red(`Organization not found: ${identifier}`));
  const suggestions = await suggestOrgs(identifier);
  if (suggestions.length > 0) {
    console.error(chalk.dim("\nDid you mean?"));
    for (const s of suggestions) {
      console.error(`  ${chalk.cyan(s.slug)}  ${chalk.dim(s.name)}`);
    }
  }
  process.exit(1);
}

export async function sourceNotFound(slug: string): Promise<never> {
  console.error(chalk.red(`Source not found: ${slug}`));
  const suggestions = await suggestSources(slug);
  if (suggestions.length > 0) {
    console.error(chalk.dim("\nDid you mean?"));
    for (const s of suggestions) {
      console.error(`  ${chalk.cyan(s.slug)}  ${chalk.dim(s.name)}`);
    }
  }
  process.exit(1);
}
