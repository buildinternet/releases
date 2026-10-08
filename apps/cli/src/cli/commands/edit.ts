import { Command } from "commander";
import { warnDeprecatedAlias } from "../../lib/deprecated-alias.js";
import { attachUpdateOptions, updateSourceAction, type UpdateSourceOpts } from "./update.js";

/**
 * Registers the deprecated `edit` alias alongside the canonical `update`
 * command. Both share the same action — the alias path emits a deprecation
 * warning first. Options are sourced from `attachUpdateOptions` so the alias
 * stays in lockstep with `update` automatically.
 *
 * @deprecated Use `registerUpdateCommand` instead.
 */
export function registerEditCommand(program: Command) {
  attachUpdateOptions(
    program
      .command("edit")
      .description("(deprecated — use update) Edit an existing changelog source"),
  ).action(warnDeprecatedAlias<[string, UpdateSourceOpts]>("edit", "update", updateSourceAction));
}
