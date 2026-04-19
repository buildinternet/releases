import { Command } from "commander";
import chalk from "chalk";
import type { DiscoveryState, AgentDiscoveredSource } from "../../agent/released.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { addIgnoredUrl, findOrg, createSource } from "../../db/queries.js";

interface ApplyResult {
  slug: string;
  url: string;
  action: "added" | "ignored" | "skipped" | "error";
  error?: string;
}

async function applySource(source: AgentDiscoveredSource, orgId?: string): Promise<ApplyResult> {
  const { url, type, slug, label } = source;

  if (source.approved === false) {
    if (!orgId) {
      return { slug, url, action: "skipped" };
    }
    const reason = source.validationError ?? "Rejected during discovery";
    try {
      await addIgnoredUrl(url, orgId, reason);
      return { slug, url, action: "ignored" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { slug, url, action: "error", error: `Failed to ignore: ${message}` };
    }
  }

  if (source.approved !== true) {
    return { slug, url, action: "skipped" };
  }

  try {
    const metadata = source.contentDepth
      ? JSON.stringify({ feedContentDepth: source.contentDepth })
      : undefined;

    await createSource({
      name: label,
      slug,
      type,
      url,
      metadata,
    });

    return { slug, url, action: "added" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Conflict (already exists) is treated as skipped, not error
    if (
      message.includes("UNIQUE constraint") ||
      message.includes("409") ||
      message.includes("already exists")
    ) {
      return { slug, url, action: "skipped" };
    }
    return { slug, url, action: "error", error: message };
  }
}

export function registerOnboardApplyCommand(onboardCmd: Command) {
  onboardCmd
    .command("apply")
    .description("Apply discovery results from a state file to the database")
    .argument("<state-file>", "Path to a DiscoveryState JSON file (or - for stdin)")
    .option("--json", "Output results as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin discovery onboard apply discovery-state.json
  releases admin discovery onboard apply discovery-state.json --json
  cat state.json | releases admin discovery onboard apply -`,
    )
    .action(async (stateFile: string, opts: { json?: boolean }) => {
      const raw = stateFile === "-" ? await Bun.stdin.text() : await Bun.file(stateFile).text();

      let state: DiscoveryState;
      try {
        state = JSON.parse(raw);
      } catch {
        logger.error("Failed to parse state file as JSON");
        process.exit(1);
      }

      if (!state.sources || !Array.isArray(state.sources)) {
        logger.error("State file missing 'sources' array");
        process.exit(1);
      }

      const org = await findOrg(state.product);
      const orgId = org?.id;

      const results: ApplyResult[] = [];

      for (const source of state.sources) {
        const result = await applySource(source, orgId);
        results.push(result);

        if (!opts.json) {
          switch (result.action) {
            case "added":
              logger.info(chalk.green(`Added: ${result.slug} (${result.url})`));
              break;
            case "ignored":
              logger.info(chalk.yellow(`Ignored: ${result.slug} (${result.url})`));
              break;
            case "skipped":
              logger.info(chalk.gray(`Skipped (no approval): ${result.slug}`));
              break;
            case "error":
              logger.error(chalk.red(`Error: ${result.slug} -- ${result.error}`));
              break;
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        let added = 0,
          ignored = 0,
          errors = 0;
        for (const r of results) {
          if (r.action === "added") added++;
          else if (r.action === "ignored") ignored++;
          else if (r.action === "error") errors++;
        }
        logger.info(chalk.bold(`\nApplied: ${added} added, ${ignored} ignored, ${errors} errors`));
      }

      if (results.some((r) => r.action === "error")) {
        process.exit(1);
      }
    });
}
