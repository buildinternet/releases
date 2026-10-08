import { Command } from "commander";
import { warnDeprecatedAlias } from "../../lib/deprecated-alias.js";
import { getEntityAction, type GetEntityOpts } from "./get.js";

/**
 * Registers the deprecated `show` alias alongside the canonical `get`
 * command. Both share the same action — the alias path emits a deprecation
 * warning first.
 *
 * @deprecated Use `registerGetCommand` instead.
 */
export function registerShowCommand(program: Command) {
  program
    .command("show")
    .description("(deprecated — use get) Show details for any entity by ID or slug")
    .argument("<identifier>", "ID (rel_/src_/org_/prod_) or slug")
    .option("--json", "Output as JSON")
    .action(warnDeprecatedAlias<[string, GetEntityOpts]>("show", "get", getEntityAction));
}
