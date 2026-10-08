import { Command } from "commander";
import chalk from "chalk";
import { apiFetch } from "../../api/core.js";
import { markDryRun } from "../../lib/dry-run.js";
import { CliError } from "../../lib/errors.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import { assertCleanIdentifier, assertSafeReadPath } from "../../lib/validate-input.js";
import {
  collectPublishPlan,
  type BatchRelease,
  type CollectedPlan,
} from "../../lib/changelog-publish/collect.js";

const TOKEN_MISSING =
  "RELEASES_API_TOKEN is required to publish. It must be a write-scoped publish token " +
  "(not the read-only RELEASES_API_KEY). Mint one with `releases publish-token create --source <src_…>`. " +
  "Pass --dry-run to print the batch body without a token.";

export type PublishTarget = {
  source: string;
  org?: string;
  path: string;
};

/**
 * Route a source argument the way the rest of the CLI does: a typed `src_…`
 * id hits the bare batch path, `org/slug` is split locally, and a bare slug
 * needs `--org`.
 */
export function resolvePublishTarget(source: string, org?: string): PublishTarget {
  const raw = source.trim();
  assertCleanIdentifier(raw, "source");
  const orgArg = org?.trim() || undefined;
  if (orgArg) assertCleanIdentifier(orgArg, "org");

  if (raw.startsWith("src_")) {
    return {
      source: raw,
      path: `/v1/sources/${encodeURIComponent(raw)}/releases/batch`,
    };
  }

  let orgSlug = orgArg;
  let slug = raw;
  if (!orgSlug && raw.includes("/")) {
    const slash = raw.indexOf("/");
    orgSlug = raw.slice(0, slash);
    slug = raw.slice(slash + 1);
    if (!orgSlug || !slug || slug.includes("/")) {
      throw new CliError(
        "Pass a src_… id, a slug with --org, or an org/slug coordinate (acme/changelog).",
      );
    }
    assertCleanIdentifier(orgSlug, "org");
    assertCleanIdentifier(slug, "source");
  }

  if (!orgSlug) {
    throw new CliError(
      "A source slug needs --org <slug>, or pass an org/slug coordinate. A typed src_… id can be used on its own.",
    );
  }

  return {
    source: slug,
    org: orgSlug,
    path: `/v1/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(slug)}/releases/batch`,
  };
}

/** Fail closed: publish never falls back to RELEASES_API_KEY or a stored login. */
export function requirePublishToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.RELEASES_API_TOKEN?.trim() ?? "";
  if (!token) throw new CliError(TOKEN_MISSING);
  return token;
}

export type BatchUpsertResponse = {
  inserted: number;
  total: number;
  insertedIds: string[];
};

export async function postReleaseBatch(
  path: string,
  releases: BatchRelease[],
  token: string,
): Promise<BatchUpsertResponse> {
  const raw = await apiFetch<{
    inserted?: number;
    total?: number;
    insertedIds?: string[];
  } | null>(path, {
    method: "POST",
    body: JSON.stringify({ mode: "upsert-content", releases }),
    skipDefaultAuth: true,
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    inserted: Number(raw?.inserted ?? 0),
    total: Number(raw?.total ?? 0),
    insertedIds: Array.isArray(raw?.insertedIds) ? raw.insertedIds : [],
  };
}

type PublishOpts = {
  source: string;
  org?: string;
  changelog?: string;
  glob?: string;
  cwd?: string;
  since?: string;
  urlTemplate?: string;
  dryRun?: boolean;
  json?: boolean;
};

function assertOptionalPath(value: string | undefined): void {
  if (value === undefined || value.trim() === "") return;
  assertSafeReadPath(value);
}

function previewPayload(target: PublishTarget, plan: CollectedPlan) {
  return {
    mode: plan.body.mode,
    path: target.path,
    format: plan.format,
    added: plan.added,
    modified: plan.modified,
    deleted: plan.deleted,
    releases: plan.body.releases,
  };
}

export function registerPublishCommand(program: Command): void {
  program
    .command("publish")
    .description("Publish changelog updates to a source from any CI (GitLab, Buildkite, local)")
    .requiredOption(
      "--source <source>",
      "Target source: src_… id, org/slug coordinate, or slug (with --org)",
    )
    .option("--org <slug>", "Organization slug when --source is a bare slug")
    .option(
      "--changelog <path>",
      "Single changelog file of ## sections, relative to --cwd",
      "CHANGELOG.md",
    )
    .option(
      "--glob <pattern>",
      "Directory mode: one MDX/Markdown file per release (frontmatter metadata)",
    )
    .option("--cwd <dir>", "Directory that contains the changelog (monorepos)")
    .option(
      "--since <sha>",
      "Only publish entries changed since this commit (GitHub Action before-sha)",
    )
    .option(
      "--url-template <template>",
      "URL for each release. Placeholders: {key}, {version}, {date}, {path}, {slug}",
    )
    .option("--dry-run", "Print the planned batch body and do not call the API")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
${chalk.bold("Auth")}
  Non-dry-run reads ${chalk.white("RELEASES_API_TOKEN")} and fails if it is missing.
  That token is write-scoped (mint it with ${chalk.white("releases publish-token create")}).
  ${chalk.white("RELEASES_API_KEY")} is not used.

${chalk.bold("Modes")}
  Single file (default): versioned ${chalk.white("## [1.2.0]")} headings, or date sections
  like ${chalk.white("## June 10, 2026")}. ${chalk.white("--glob")} switches to one file per
  release; ${chalk.white("draft: true")} frontmatter is skipped. ${chalk.white("--glob")} cannot
  be combined with a non-default ${chalk.white("--changelog")}.

  Omit ${chalk.white("--since")} (or pass an all-zero SHA) to publish every parsed entry.
  The request is ${chalk.white("mode: upsert-content")}, so repeating it does not duplicate
  unchanged bodies. Deleted directory files are reported and left in the index.

${chalk.bold("Examples")}
  $ releases publish --source src_… --dry-run
  $ releases publish --source acme/docs --since "$CI_COMMIT_BEFORE_SHA" \\
      --url-template "https://gitlab.com/acme/app/-/blob/main/CHANGELOG.md#{key}"
  $ releases publish --source src_… --glob "changelog/**/*.mdx" --cwd docs

${chalk.dim("Same plan as the publish-changelog GitHub Action.")}
  https://releases.sh/docs/integrations/github-actions
`,
    )
    .action(async (opts: PublishOpts) => {
      const target = resolvePublishTarget(opts.source, opts.org);
      assertOptionalPath(opts.changelog);
      assertOptionalPath(opts.glob);
      assertOptionalPath(opts.cwd);
      if (opts.since !== undefined) assertCleanIdentifier(opts.since, "since");

      // Fail closed before any read or request. --dry-run stays local and
      // token-free so CI can print the plan without a secret.
      const token = opts.dryRun ? null : requirePublishToken();

      const plan = await collectPublishPlan({
        changelogPath: opts.changelog,
        glob: opts.glob,
        workingDirectory: opts.cwd,
        beforeSha: opts.since,
        urlTemplate: opts.urlTemplate,
        githubRepository: process.env.GITHUB_REPOSITORY,
        githubRefName: process.env.GITHUB_REF_NAME,
        warn: (message) => logger.warn(message),
      });

      if (opts.dryRun) {
        if (opts.json) {
          await writeJson(markDryRun(previewPayload(target, plan)));
          return;
        }
        logger.info(
          chalk.dim(
            `[dry-run] Would POST ${target.path} (upsert-content, ${plan.body.releases.length} releases).`,
          ),
        );
        if (plan.deleted.length > 0) {
          logger.info(
            chalk.dim(
              `[dry-run] Deleted files are not removed from the index: ${plan.deleted.join(", ")}`,
            ),
          );
        }
        await writeJson(plan.body);
        return;
      }

      if (plan.releases.length === 0) {
        const payload = {
          skipped: true,
          inserted: 0,
          total: 0,
          insertedIds: [] as string[],
          added: plan.added,
          modified: plan.modified,
          deleted: plan.deleted,
        };
        if (opts.json) {
          await writeJson(payload);
          return;
        }
        console.log("No changed changelog entries; nothing to publish.");
        if (plan.deleted.length > 0) {
          console.log(`Deleted files (not removed from the index): ${plan.deleted.join(", ")}`);
        }
        return;
      }

      if (token === null) throw new CliError(TOKEN_MISSING);
      const result = await postReleaseBatch(target.path, plan.body.releases, token);
      if (opts.json) {
        await writeJson({
          ...result,
          skipped: false,
          added: plan.added,
          modified: plan.modified,
          deleted: plan.deleted,
        });
        return;
      }
      console.log(
        `Published ${plan.releases.length} changelog entries (inserted ${result.inserted}, total ${result.total}).`,
      );
      if (plan.added.length > 0) console.log(`added: ${plan.added.join(", ")}`);
      if (plan.modified.length > 0) console.log(`modified: ${plan.modified.join(", ")}`);
      if (plan.deleted.length > 0) {
        console.log(`deleted (not removed from the index): ${plan.deleted.join(", ")}`);
      }
    });
}
