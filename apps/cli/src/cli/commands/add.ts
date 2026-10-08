import { Command } from "commander";
import { warnDeprecatedAlias } from "../../lib/deprecated-alias.js";
import { isGitHubUrl, createSourceAction, type CreateSourceOpts } from "./create.js";

// Re-export for consumers that import isGitHubUrl from add.ts.
export { isGitHubUrl };

/**
 * Registers the deprecated `add` alias alongside the canonical `create`
 * command. Both are attached to the same parent `program` and share the same
 * action — the alias path emits a deprecation warning first.
 *
 * @deprecated Use `registerCreateCommand` instead.
 */
export function registerAddCommand(program: Command) {
  program
    .command("add")
    .description("(deprecated — use create) Add a new changelog source")
    .argument("[name]", "Display name for the source")
    .option(
      "--type <type>",
      "Source type: github, scrape, feed, or agent (auto-detected from URL if omitted). App Store apps use `source create-appstore`; YouTube channels/playlists use `source create-video`.",
    )
    .option("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--org <org>", "Organization (org_…, slug, domain, or name — creates if not found)")
    .option("--product <product>", "Product (prod_… or slug) to assign this source to")
    .option("--name <name>", "Display name for the source (alternative to positional argument)")
    .option("--feed-url <feedUrl>", "Explicit feed URL")
    .option("--batch <file>", "JSON file with sources to add (use - for stdin)")
    .option("--json", "Output as JSON")
    .option("--strict", "Exit 1 if the source URL already exists (default: return existing)")
    .option("--dry-run", "Show what would be created without writing")
    .action(
      warnDeprecatedAlias<[string | undefined, CreateSourceOpts]>(
        "add",
        "create",
        createSourceAction,
      ),
    );
}
