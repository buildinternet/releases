import { Command } from "commander";
import { writeJson } from "../../lib/output.js";
import { InvalidInputError } from "../../lib/errors.js";
import {
  DEFAULT_CHANGELOG_LIMIT,
  MAX_CHANGELOG_LIMIT,
  fetchProductChangelog,
  formatChangelogHuman,
} from "../../lib/product-changelog.js";

function parseChangelogLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CHANGELOG_LIMIT;
  if (!/^-?\d+$/.test(raw)) {
    throw new InvalidInputError("limit", `must be a positive integer (got ${raw})`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) {
    throw new InvalidInputError("limit", `must be a positive integer (got ${raw})`);
  }
  if (n > MAX_CHANGELOG_LIMIT) {
    throw new InvalidInputError("limit", `must be ${MAX_CHANGELOG_LIMIT} or less (got ${n})`);
  }
  return n;
}

export function registerProductChangelogCommand(program: Command): void {
  program
    .command("changelog")
    .description("Print recent product updates from releases.sh")
    .option(
      "--limit <n>",
      `Number of entries to show (default: ${DEFAULT_CHANGELOG_LIMIT}, max: ${MAX_CHANGELOG_LIMIT})`,
    )
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases changelog
  releases changelog --limit 10
  releases changelog --json`,
    )
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const limit = parseChangelogLimit(opts.limit);
      const doc = await fetchProductChangelog({ limit });
      if (opts.json) {
        await writeJson(doc);
        return;
      }
      process.stdout.write(formatChangelogHuman(doc));
    });
}
