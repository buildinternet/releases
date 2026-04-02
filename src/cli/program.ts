import { Command } from "commander";
import { registerAddCommand } from "./commands/add.js";
import { registerEditCommand } from "./commands/edit.js";
import { registerRemoveCommand } from "./commands/remove.js";
import { registerListCommand } from "./commands/list.js";
import { registerFetchCommand } from "./commands/fetch.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerLatestCommand } from "./commands/latest.js";
import { registerSummaryCommand } from "./commands/summary.js";
import { registerCompareCommand } from "./commands/compare.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerUsageCommand } from "./commands/usage.js";
import { registerOrgCommand } from "./commands/org.js";
import { registerProductCommand } from "./commands/product.js";
import { registerDiscoverCommand } from "./commands/discover.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerApiCommand } from "./commands/api.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerFetchLogCommand } from "./commands/fetch-log.js";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerIgnoreCommand } from "./commands/ignore.js";
import { registerBlockCommand } from "./commands/block.js";
import { registerImportCommand } from "./commands/import.js";
import { registerEvaluateCommand } from "./commands/evaluate.js";
import { registerSummarizeCommand } from "./commands/summarize.js";
import { registerEnrichCommand } from "./commands/enrich.js";
import { registerMediaCommand } from "./commands/media.js";
import { registerTaskCommand } from "./commands/task.js";
import { CATEGORIES } from "../lib/categories.js";

export const program = new Command()
  .name("released")
  .description("Context7-style changelog indexer for AI agents and developers")
  .version("0.1.0")
  .addHelpText("after", `
Command Groups:
  Sources:       add, edit, remove, list, import, discover, evaluate
  Fetching:      fetch, fetch-log, check
  Enrichment:    enrich
  Querying:      search, latest, summary, compare, stats
  Organizations: org (add, list, show, remove, link, unlink)
  Products:      product (list, add, edit, remove, adopt)
  Categories:    categories
  Releases:      release (show, edit, delete, suppress, unsuppress)
  Blocking:      block (list, add, remove), ignore (list, add, remove)
  Agents:        onboard, serve, api, task
  Media:         media (backfill)
  Utilities:     usage

Run "released <command> --help" for details on any command.`);

registerAddCommand(program);
registerEditCommand(program);
registerRemoveCommand(program);
registerListCommand(program);
registerFetchCommand(program);
registerSearchCommand(program);
registerLatestCommand(program);
registerSummaryCommand(program);
registerCompareCommand(program);
registerServeCommand(program);
registerUsageCommand(program);
registerOrgCommand(program);
registerProductCommand(program);
registerDiscoverCommand(program);
registerStatsCommand(program);
registerApiCommand(program);
registerReleaseCommand(program);
registerCheckCommand(program);
registerFetchLogCommand(program);
registerOnboardCommand(program);
registerIgnoreCommand(program);
registerBlockCommand(program);
registerImportCommand(program);
registerEvaluateCommand(program);
registerSummarizeCommand(program);
registerEnrichCommand(program);
registerMediaCommand(program);
registerTaskCommand(program);

program
  .command("categories")
  .description("List valid category values")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => {
    if (opts.json) {
      console.log(JSON.stringify(CATEGORIES, null, 2));
    } else {
      for (const cat of CATEGORIES) {
        console.log(cat);
      }
    }
  });
