import { Command } from "commander";
import chalk from "chalk";
import type {
  PublishToken,
  CreatedPublishToken,
  ListPublishTokensResponse,
} from "@buildinternet/releases-api-types";
import { getApiUrl } from "../../lib/mode.js";
import { withSession } from "../../lib/session.js";
import { ApiError } from "../../lib/errors.js";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { renderTable } from "../render/table.js";
import { promptConfirm, defaultPromptReader } from "../../lib/confirm.js";
// Reuse the exact session-authed request machinery `releases keys` uses for
// its own /v1/api-keys management surface — the shared `apiFetch` transport,
// the Idempotency-Key handling, and the server-message passthrough. This
// endpoint accepts the SAME kind of device-flow session Bearer token (not a
// `relk_` key), so there's nothing publish-token-specific to add here beyond
// a distinct approval purpose ("publish-tokens") passed to `withSession`.
import { keysRequest, keysErrorMessage } from "./keys.js";

const DEFAULT_TOKEN_NAME = "GitHub Actions";

/**
 * Render a freshly-minted token. Only `created.token` goes to stdout — so
 * `releases publish-token create --source src_x | gh secret set RELEASES_API_TOKEN`
 * works without any extra parsing — every other line (it's shown once, the
 * workflow snippet) is guidance and goes to stderr. Split out from the
 * `create` action so it's testable without a network/session round trip.
 */
export async function printCreatedPublishToken(
  created: CreatedPublishToken,
  json?: boolean,
): Promise<void> {
  if (json) {
    await writeJson(created);
    return;
  }
  console.log(created.token);
  console.error(
    chalk.green(`Publish token created for ${created.sourceId}. It won't be shown again.`),
  );
  console.error(chalk.dim(`  id: ${created.id}  name: ${created.name}`));
  console.error("");
  console.error("Add it as a workflow step:");
  console.error("");
  console.error("  - uses: buildinternet/releases/actions/publish-changelog@main");
  console.error("    with:");
  console.error(`      source: ${created.sourceId}`);
  console.error("      api-token: ${{ secrets.RELEASES_API_TOKEN }}");
}

/**
 * Render the publish-token list (table, empty-state hint, or `--json`).
 * Split out from the `list` action so it's testable without a network/session
 * round trip.
 */
export async function printPublishTokenList(
  data: ListPublishTokensResponse,
  json?: boolean,
): Promise<void> {
  if (json) {
    await writeJson(data);
    return;
  }
  if (data.publishTokens.length === 0) {
    console.log(
      chalk.yellow(
        "No publish tokens. Create one with `releases publish-token create --source <src_…>`.",
      ),
    );
    return;
  }
  console.log(
    renderTable({
      head: [
        { label: "ID", noTruncate: true },
        { label: "Name" },
        { label: "Source", noTruncate: true },
        { label: "Created", noTruncate: true },
        { label: "Last used", noTruncate: true },
        { label: "Revoked", noTruncate: true },
      ],
      rows: data.publishTokens.map((t: PublishToken) => [
        t.id,
        t.name,
        t.orgSlug && t.sourceSlug ? `${t.orgSlug}/${t.sourceSlug}` : t.sourceId,
        t.createdAt.slice(0, 10),
        t.lastUsedAt ? t.lastUsedAt.slice(0, 10) : chalk.dim("never"),
        t.revokedAt ? t.revokedAt.slice(0, 10) : chalk.dim("—"),
      ]),
    }),
  );
}

export function registerPublishTokenCommand(program: Command): void {
  const publishToken = program
    .command("publish-token")
    .description(
      "Manage publish tokens for pushing a changelog into one source (e.g. the publish-changelog GitHub Action). Requires a verified domain ownership claim on the source's org.",
    );

  publishToken
    .command("create")
    .description("Mint a publish token bound to one source (shown once)")
    .requiredOption("--source <sourceId>", "Source ID to bind the token to (src_…)")
    .option("--name <name>", "Label for the token", DEFAULT_TOKEN_NAME)
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would be created without minting a token")
    .option("--no-browser", "Print the device-approval URL instead of opening a browser")
    .action(
      async (opts: {
        source: string;
        name: string;
        json?: boolean;
        dryRun?: boolean;
        browser?: boolean;
      }) => {
        const apiUrl = getApiUrl();
        const body = { sourceId: opts.source, name: opts.name };
        if (opts.dryRun) {
          if (opts.json) {
            await writeJson(markDryRun({ wouldCreate: body }));
            return;
          }
          logger.warn(`[dry-run] Would create publish token "${opts.name}" for ${opts.source}.`);
          return;
        }
        let created: CreatedPublishToken;
        try {
          created = await withSession(
            apiUrl,
            "publish-tokens",
            (sessionToken) =>
              keysRequest<CreatedPublishToken>(
                "/v1/me/publish-tokens",
                { method: "POST", body: JSON.stringify(body) },
                sessionToken,
              ),
            { openInBrowser: opts.browser !== false },
          );
        } catch (err) {
          console.error(chalk.red(keysErrorMessage(err)));
          process.exit(1);
        }
        await printCreatedPublishToken(created, opts.json);
      },
    );

  publishToken
    .command("list")
    .description("List your publish tokens")
    .option("--json", "Output as JSON")
    .option("--no-browser", "Print the device-approval URL instead of opening a browser")
    .action(async (opts: { json?: boolean; browser?: boolean }) => {
      const apiUrl = getApiUrl();
      let data: ListPublishTokensResponse | null;
      try {
        data = await withSession(
          apiUrl,
          "publish-tokens",
          (sessionToken) =>
            keysRequest<ListPublishTokensResponse | null>(
              "/v1/me/publish-tokens",
              { method: "GET" },
              sessionToken,
            ),
          { openInBrowser: opts.browser !== false },
        );
      } catch (err) {
        console.error(chalk.red(keysErrorMessage(err)));
        process.exit(1);
      }
      if (!data) {
        console.error(chalk.red("Failed to list publish tokens (HTTP 404)"));
        process.exit(1);
      }
      await printPublishTokenList(data, opts.json);
    });

  publishToken
    .command("revoke <id>")
    .description("Revoke a publish token by id")
    .option("--yes", "Skip the confirmation prompt")
    .option("--dry-run", "Show what would be revoked without deleting")
    .option("--no-browser", "Print the device-approval URL instead of opening a browser")
    .action(async (id: string, opts: { yes?: boolean; dryRun?: boolean; browser?: boolean }) => {
      if (opts.dryRun) {
        logger.warn(`[dry-run] Would revoke publish token ${id}.`);
        return;
      }
      if (!opts.yes) {
        const ok = await promptConfirm(
          `Type the token id to confirm revoke (${id}): `,
          id,
          defaultPromptReader,
        );
        if (!ok) {
          console.error(chalk.red("Aborted."));
          process.exit(1);
        }
      }
      const apiUrl = getApiUrl();
      try {
        await withSession(
          apiUrl,
          "publish-tokens",
          (sessionToken) =>
            keysRequest(
              `/v1/me/publish-tokens/${encodeURIComponent(id)}`,
              { method: "DELETE" },
              sessionToken,
            ),
          { openInBrowser: opts.browser !== false },
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          console.error(chalk.red("No such publish token (or not owned by you)."));
          process.exit(1);
        }
        console.error(chalk.red(keysErrorMessage(err)));
        process.exit(1);
      }
      console.log(chalk.green(`Revoked ${id}.`));
    });
}
