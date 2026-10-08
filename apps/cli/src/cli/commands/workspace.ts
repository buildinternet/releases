/**
 * `releases workspace list` — the caller's Better Auth workspaces
 * (releases-cli#406). Self-serve read on the signed-in account, so it lives
 * at the top level next to `follow`/`webhook` rather than under `admin`. The
 * only current consumer is finding a workspace's `id`/`slug` for `releases
 * webhook … --workspace <id-or-slug>` — there's no other workspace-editing
 * surface in this CLI yet.
 */
import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { isAuthenticated } from "../../lib/mode.js";
import { listMyWorkspaces } from "../../api/workspaces.js";
import { writeJson } from "../../lib/output.js";
import { renderTable } from "../render/table.js";

function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error(
      chalk.red("Not signed in. Run `releases login` first (or set RELEASES_API_KEY)."),
    );
    process.exit(1);
  }
}

export function registerWorkspaceCommand(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Inspect the workspaces you belong to")
    .showSuggestionAfterError(true);

  workspace
    .command("list")
    .description("List your workspaces (name, slug, id, role)")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      requireAuth();
      const workspaces = await listMyWorkspaces();
      if (opts.json) return writeJson({ workspaces });
      if (workspaces.length === 0) {
        logger.info("You are not a member of any workspace.");
        return;
      }
      console.log(
        renderTable({
          head: [
            { label: "ID", noTruncate: true },
            { label: "Name" },
            { label: "Slug" },
            { label: "Role" },
            { label: "Active" },
          ],
          rows: workspaces.map((w) => [
            w.id,
            w.name,
            w.slug,
            w.role,
            w.active ? chalk.green("✓") : "",
          ]),
        }),
      );
    });
}
