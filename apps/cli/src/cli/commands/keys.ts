import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import type {
  UserApiKey,
  CreatedUserApiKey,
  ListUserApiKeysResponse,
} from "@buildinternet/releases-api-types";
import { getApiUrl } from "../../lib/mode.js";
import { withSession } from "../../lib/session.js";
import { newIdempotencyKey } from "../../lib/idempotency.js";
import { ApiError } from "../../lib/errors.js";
import { apiFetch } from "../../api/core.js";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { renderTable } from "../render/table.js";
import { promptConfirm, defaultPromptReader } from "../../lib/confirm.js";

/**
 * Strict parser for `--expires-in-days`. `parseInt("abc")` yields NaN (which
 * would serialize to `null`) and `parseInt("3d")` silently yields 3 — so parse
 * with `Number`, require a whole number in 1–365, and reject anything else with
 * a commander argument error rather than letting a bad value reach the server.
 */
export function parseExpiresInDays(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new InvalidArgumentError("must be an integer between 1 and 365.");
  }
  return n;
}

/**
 * Session-authed request to the /v1/api-keys (or /v1/me/publish-tokens)
 * management surface, routed through the shared `apiFetch` transport. Sends
 * the given (freshly established, one-shot) session token as a Bearer
 * credential — `skipDefaultAuth` stops `apiFetch` from overwriting it with
 * the static admin/API key when one happens to be configured too. There is
 * no stale token to retry past here: the caller wraps its whole body in one
 * `withSession(...)`, which hands this a session that was just minted for
 * this exact call.
 */
export async function keysRequest<T>(
  path: string,
  init: RequestInit,
  sessionToken: string,
): Promise<T> {
  const idempotencyKey = init.method === "POST" ? newIdempotencyKey() : undefined;
  return apiFetch<T>(path, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${sessionToken}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    skipDefaultAuth: true,
  });
}

/** apiFetch/ApiError already resolve the standardized error envelope (and the
 * 409 idempotency-conflict message) into a clean human message — surface
 * that directly rather than re-deriving it. Exported for reuse by other
 * session-authed commands (e.g. `publish-token`). */
export function keysErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.serverMessage;
  return err instanceof Error ? err.message : String(err);
}

export function registerKeysCommand(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage your user API keys (read-only relu_ keys)");

  keys
    .command("create")
    .description("Create a read-only API key (revealed once)")
    .requiredOption("--name <name>", "Label for the key")
    .option("--expires-in-days <n>", "Expiry in days (1-365)", parseExpiresInDays)
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would be created without minting a key")
    .option("--no-browser", "Print the device-approval URL instead of opening a browser")
    .action(
      async (opts: {
        name: string;
        expiresInDays?: number;
        json?: boolean;
        dryRun?: boolean;
        browser?: boolean;
      }) => {
        const apiUrl = getApiUrl();
        const body: Record<string, unknown> = { name: opts.name, scope: "read" };
        // parseExpiresInDays guarantees a valid integer or commander exits before
        // this runs; the Number.isInteger guard is belt-and-suspenders so a NaN/null
        // can never be serialized into the request body.
        if (opts.expiresInDays !== undefined && Number.isInteger(opts.expiresInDays)) {
          body.expiresInDays = opts.expiresInDays;
        }
        if (opts.dryRun) {
          if (opts.json) {
            await writeJson(markDryRun({ wouldCreate: body }));
            return;
          }
          const expiresHint =
            opts.expiresInDays !== undefined ? ` (expires in ${opts.expiresInDays}d)` : "";
          logger.warn(`[dry-run] Would create read-only API key "${opts.name}"${expiresHint}.`);
          return;
        }
        let created: CreatedUserApiKey;
        try {
          created = await withSession(
            apiUrl,
            "keys",
            (sessionToken) =>
              keysRequest<CreatedUserApiKey>(
                "/v1/api-keys",
                { method: "POST", body: JSON.stringify(body) },
                sessionToken,
              ),
            { openInBrowser: opts.browser !== false },
          );
        } catch (err) {
          console.error(chalk.red(keysErrorMessage(err)));
          process.exit(1);
        }
        if (opts.json) {
          await writeJson(created);
          return;
        }
        console.log(
          chalk.green("API key created (read-only). Store it now — it won't be shown again:"),
        );
        console.log(`\n  ${chalk.bold(created.key)}\n`);
        console.log(chalk.dim(`  id: ${created.id}  scope: ${created.scope}`));
      },
    );

  keys
    .command("list")
    .description("List your API keys")
    .option("--json", "Output as JSON")
    .option("--no-browser", "Print the device-approval URL instead of opening a browser")
    .action(async (opts: { json?: boolean; browser?: boolean }) => {
      const apiUrl = getApiUrl();
      let data: ListUserApiKeysResponse | null;
      try {
        data = await withSession(
          apiUrl,
          "keys",
          (sessionToken) =>
            keysRequest<ListUserApiKeysResponse | null>(
              "/v1/api-keys",
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
        console.error(chalk.red("Failed to list keys (HTTP 404)"));
        process.exit(1);
      }
      if (opts.json) {
        await writeJson(data);
        return;
      }
      if (data.apiKeys.length === 0) {
        console.log(
          chalk.yellow("No API keys. Create one with `releases keys create --name <name>`."),
        );
        return;
      }
      console.log(
        renderTable({
          head: [
            { label: "ID", noTruncate: true },
            { label: "Name" },
            { label: "Scope", noTruncate: true },
            { label: "Prefix", noTruncate: true },
            { label: "Created", noTruncate: true },
            { label: "Expires", noTruncate: true },
          ],
          rows: data.apiKeys.map((k: UserApiKey) => [
            k.id,
            k.name ?? chalk.dim("—"),
            k.scope ?? chalk.dim("—"),
            k.start ?? chalk.dim("—"),
            k.createdAt.slice(0, 10),
            k.expiresAt ? k.expiresAt.slice(0, 10) : chalk.dim("never"),
          ]),
        }),
      );
    });

  keys
    .command("revoke <id>")
    .description("Revoke (delete) an API key by id")
    .option("--yes", "Skip the confirmation prompt")
    .option("--dry-run", "Show what would be revoked without deleting")
    .option("--no-browser", "Print the device-approval URL instead of opening a browser")
    .action(async (id: string, opts: { yes?: boolean; dryRun?: boolean; browser?: boolean }) => {
      if (opts.dryRun) {
        logger.warn(`[dry-run] Would revoke API key ${id}.`);
        return;
      }
      if (!opts.yes) {
        const ok = await promptConfirm(
          `Type the key id to confirm revoke (${id}): `,
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
          "keys",
          (sessionToken) =>
            keysRequest(
              `/v1/api-keys/${encodeURIComponent(id)}`,
              { method: "DELETE" },
              sessionToken,
            ),
          { openInBrowser: opts.browser !== false },
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          console.error(chalk.red("No such key (or not owned by you)."));
          process.exit(1);
        }
        console.error(chalk.red(keysErrorMessage(err)));
        process.exit(1);
      }
      console.log(chalk.green(`Revoked ${id}.`));
    });
}
