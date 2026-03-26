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
import { registerDiscoverCommand } from "./commands/discover.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerApiCommand } from "./commands/api.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerCheckCommand } from "./commands/check.js";
import { registerFetchLogCommand } from "./commands/fetch-log.js";

export const program = new Command()
  .name("released")
  .description("Context7-style changelog indexer for AI agents and developers")
  .version("0.1.0");

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
registerDiscoverCommand(program);
registerStatsCommand(program);
registerApiCommand(program);
registerReleaseCommand(program);
registerCheckCommand(program);
registerFetchLogCommand(program);
