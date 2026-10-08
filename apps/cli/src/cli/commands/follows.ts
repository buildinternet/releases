import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import type { Follow } from "@buildinternet/releases-api-types";
import { isAuthenticated } from "../../lib/mode.js";
import {
  resolveFollowTarget,
  listMyFollows,
  addFollow,
  removeFollow,
  getMyFeed,
} from "../../api/follows.js";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { renderTable } from "../render/table.js";
import { renderReleaseRows } from "../render/releases-table.js";

/**
 * Personalized follows + feed verbs (releases-cli#1520). These act on the
 * signed-in user's own account, so they require an authenticated CLI — the
 * stored `relu_` key from `releases login` (or `RELEASES_API_KEY`) rides along
 * via `apiFetch`, and the API's `/v1/me/*` gate accepts that Bearer user
 * principal. `follow`/`unfollow` resolve a human identifier (slug, `org/slug`
 * coordinate, or `org_`/`prod_` id) to a target; `following` lists them; `feed`
 * renders the personalized timeline using the same path as `releases tail`.
 */

/** Bail with a sign-in hint when no credential is configured. */
function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error(
      chalk.red("Not signed in. Run `releases login` first (or set RELEASES_API_KEY)."),
    );
    process.exit(1);
  }
}

/** Strict 1-based positive-integer parser for `--page` / `--limit`. */
function parsePositiveInt(label: string, max: number) {
  return (raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      throw new InvalidArgumentError(`${label} must be an integer between 1 and ${max}.`);
    }
    return n;
  };
}

function targetNotFound(entity: string): never {
  console.error(
    chalk.red(
      `Couldn't resolve '${entity}' to an organization or product.\n` +
        "Pass an org slug, an `org/product` coordinate, or an `org_…` / `prod_…` id " +
        "(find them with `releases search` or `releases list`).",
    ),
  );
  process.exit(1);
}

export function registerFollowsCommands(program: Command): void {
  program
    .command("follow <entity>")
    .description("Follow an organization or product (shows up in `releases feed`)")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Resolve the target and show what would be followed, without writing")
    .action(async (entity: string, opts: { json?: boolean; dryRun?: boolean }) => {
      requireAuth();
      const target = await resolveFollowTarget(entity);
      if (!target) targetNotFound(entity);
      if (opts.dryRun) {
        if (opts.json) await writeJson(markDryRun({ wouldFollow: target }));
        else logger.warn(`[dry-run] Would follow ${target.label} (${target.targetType}).`);
        return;
      }
      const res = await addFollow(target.targetType, target.targetId);
      if (opts.json) {
        await writeJson({ ...res, target });
        return;
      }
      console.log(chalk.green(`Following ${target.label} (${target.targetType}).`));
    });

  program
    .command("unfollow <entity>")
    .description("Stop following an organization or product")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Resolve the target and show what would be unfollowed, without writing")
    .action(async (entity: string, opts: { json?: boolean; dryRun?: boolean }) => {
      requireAuth();
      const target = await resolveFollowTarget(entity);
      if (!target) targetNotFound(entity);
      if (opts.dryRun) {
        if (opts.json) await writeJson(markDryRun({ wouldUnfollow: target }));
        else logger.warn(`[dry-run] Would unfollow ${target.label} (${target.targetType}).`);
        return;
      }
      const res = await removeFollow(target.targetType, target.targetId);
      if (opts.json) {
        await writeJson({ ...res, target });
        return;
      }
      console.log(chalk.green(`Unfollowed ${target.label} (${target.targetType}).`));
    });

  program
    .command("following")
    .description("List the organizations and products you follow")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      requireAuth();
      const follows = await listMyFollows();
      if (opts.json) {
        await writeJson({ follows });
        return;
      }
      if (follows.length === 0) {
        console.log(
          chalk.yellow("You're not following anything yet. Use `releases follow <org|product>`."),
        );
        return;
      }
      console.log(
        renderTable({
          head: [
            { label: "Name" },
            { label: "Type", noTruncate: true },
            { label: "Coordinate", noTruncate: true },
            { label: "ID", noTruncate: true },
          ],
          rows: follows.map((f: Follow) => [
            f.name,
            f.targetType,
            f.targetType === "product" && f.orgSlug ? `${f.orgSlug}/${f.slug}` : f.slug,
            f.targetId,
          ]),
        }),
      );
    });

  program
    .command("feed")
    .description("Your personalized release feed (from the orgs + products you follow)")
    .option("--page <n>", "1-based page number (default 1)", parsePositiveInt("--page", 100_000))
    .option(
      "--limit <n>",
      "Releases per page, 1–100 (default 30)",
      parsePositiveInt("--limit", 100),
    )
    .option("--json", "Output as JSON")
    .action(async (opts: { page?: number; limit?: number; json?: boolean }) => {
      requireAuth();
      const { releases, hasMore } = await getMyFeed({ page: opts.page, limit: opts.limit });
      if (opts.json) {
        await writeJson({ releases, pagination: { hasMore } });
        return;
      }
      if (releases.length === 0) {
        console.log(
          chalk.yellow(
            "No releases yet from the organizations and products you follow. " +
              "Follow more with `releases follow <org|product>`.",
          ),
        );
        return;
      }
      console.log(renderReleaseRows(releases, { mode: "feed" }));
      if (hasMore) {
        console.log(
          chalk.dim(
            `\nMore available — pass \`--page ${(opts.page ?? 1) + 1}\` for the next page.`,
          ),
        );
      }
    });
}
