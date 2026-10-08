import { Command } from "commander";
import { warnDeprecatedAlias } from "../../lib/deprecated-alias.js";
import { deleteSourceAction, type DeleteSourceOpts } from "./delete.js";

/**
 * Registers the deprecated `remove` alias alongside the canonical `delete`
 * command. Both share the same action — the alias path emits a deprecation
 * warning first.
 *
 * @deprecated Use `registerDeleteCommand` instead.
 */
export function registerRemoveCommand(program: Command) {
  program
    .command("remove")
    .description("(deprecated — use delete) Remove one or more changelog sources")
    .argument("<sources...>", "Source IDs (src_…) or slugs to remove")
    .option("--ignore", "Add each source URL to the ignored list before removing")
    .option("--reason <reason>", "Reason for ignoring (used with --ignore)")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--json", "Output as JSON")
    .action(
      warnDeprecatedAlias<[string[], DeleteSourceOpts]>("remove", "delete", deleteSourceAction),
    );
}
