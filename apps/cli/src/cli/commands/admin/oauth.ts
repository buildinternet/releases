/**
 * `releases admin oauth client …` — manage "Sign in with Releases" OAuth
 * clients. Thin wrapper over the root-key-gated `/v1/admin/oauth/clients`
 * routes (buildinternet/releases#1482); the admin gate is applied by
 * `gateAdminSubtree` in program.ts. Mirrors the `admin user` verb shape.
 */
import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../../lib/output.js";
import {
  createOAuthClient,
  listOAuthClients,
  getOAuthClient,
  updateOAuthClient,
  rotateOAuthClientSecret,
  deleteOAuthClient,
  type OAuthClient,
} from "../../../api/admin.js";
import { renderTable } from "../../render/table.js";

/** Commander collector for repeatable options (`--redirect-uri a --redirect-uri b`). */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** One-line human summary of a client's flags. */
function flagSummary(client: OAuthClient): string {
  const flags: string[] = [];
  flags.push(client.public ? chalk.cyan("public/PKCE") : "confidential");
  if (client.trusted) flags.push(chalk.yellow("trusted"));
  if (client.official) flags.push(chalk.green("official"));
  if (client.disabled) flags.push(chalk.red("disabled"));
  return flags.join(" · ");
}

function printClient(client: OAuthClient): void {
  logger.info(`${chalk.bold(client.clientId)}  ${client.name ?? chalk.dim("(unnamed)")}`);
  logger.info(`  ${flagSummary(client)}`);
  logger.info(`  redirect: ${client.redirectUris.join(", ") || chalk.dim("(none)")}`);
  logger.info(`  scopes:   ${client.scopes.join(" ") || chalk.dim("(none)")}`);
}

export function registerOauthCommand(program: Command) {
  const oauth = program
    .command("oauth")
    .description('Manage "Sign in with Releases" OAuth clients');
  const client = oauth.command("client").description("Register and manage OAuth clients");

  client
    .command("create")
    .description("Register a new OAuth client (secret shown once)")
    .requiredOption(
      "--redirect-uri <uri>",
      "Allowed redirect URI (repeatable)",
      collect,
      [] as string[],
    )
    .requiredOption("--scope <scope>", "Granted scope (repeatable)", collect, [] as string[])
    .option("--name <name>", "Human-readable client name")
    .option("--trusted", "Skip the consent screen (trusted first-party client)")
    .option(
      "--official",
      'Show the "Verified by Releases Index" badge on the consent page (server default when neither flag is given)',
    )
    .option("--no-official", "Do not show the verified badge (e.g. a third-party client)")
    .option("--public", "Public/PKCE client with no secret (tokenEndpointAuthMethod=none)")
    .option(
      "--grant-type <type>",
      "Grant type (repeatable; default authorization_code)",
      collect,
      [] as string[],
    )
    .option("--no-pkce", "Do not require PKCE (default: required)")
    .option("--client-uri <url>", "Client homepage URL")
    .option("--logo-uri <url>", "Client logo URL")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        redirectUri: string[];
        scope: string[];
        name?: string;
        trusted?: boolean;
        official?: boolean;
        public?: boolean;
        grantType: string[];
        pkce: boolean;
        clientUri?: string;
        logoUri?: string;
        json?: boolean;
      }) => {
        const result = await createOAuthClient({
          name: opts.name,
          redirectUris: opts.redirectUri,
          scopes: opts.scope,
          trusted: opts.trusted,
          official: opts.official,
          tokenEndpointAuthMethod: opts.public ? "none" : undefined,
          grantTypes: opts.grantType.length > 0 ? opts.grantType : undefined,
          requirePKCE: opts.pkce,
          clientUri: opts.clientUri,
          logoUri: opts.logoUri,
        });
        if (opts.json) {
          await writeJson(result);
          return;
        }
        printClient(result);
        if (result.clientSecret) {
          logger.info("");
          logger.info(chalk.bold("Client secret (shown once — store it now):"));
          logger.info(`  ${chalk.green(result.clientSecret)}`);
        } else {
          logger.info(`  ${chalk.dim("public client — no secret")}`);
        }
      },
    );

  client
    .command("list")
    .description("List all registered OAuth clients")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const clients = await listOAuthClients();
      if (opts.json) {
        await writeJson({ clients });
        return;
      }
      if (clients.length === 0) {
        logger.info("No OAuth clients registered.");
        return;
      }
      console.log(
        renderTable({
          head: [
            { label: "Client ID", noTruncate: true },
            { label: "Name" },
            { label: "Type" },
            { label: "Flags" },
          ],
          rows: clients.map((c) => [
            c.clientId,
            c.name ?? chalk.dim("—"),
            c.public ? "public" : "confidential",
            [c.trusted ? "trusted" : "", c.official ? "official" : "", c.disabled ? "disabled" : ""]
              .filter(Boolean)
              .join(",") || chalk.dim("—"),
          ]),
        }),
      );
    });

  client
    .command("get <clientId>")
    .description("Show one OAuth client")
    .option("--json", "Output JSON")
    .action(async (clientId: string, opts: { json?: boolean }) => {
      const found = await getOAuthClient(clientId);
      if (!found) {
        logger.error("Client not found.");
        process.exit(1);
      }
      if (opts.json) {
        await writeJson(found);
        return;
      }
      printClient(found);
    });

  client
    .command("update <clientId>")
    .description("Update a client's flags (at least one flag required)")
    .option("--official", 'Show the "Verified by Releases Index" badge on the consent page')
    .option("--no-official", "Remove the verified badge")
    .option("--trusted", "Skip the consent screen")
    .option("--no-trusted", "Require the consent screen again")
    .option("--disabled", "Disable the client")
    .option("--no-disabled", "Re-enable the client")
    .option("--json", "Output JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin oauth client update <clientId> --official
  releases admin oauth client update <clientId> --no-official --no-trusted`,
    )
    .action(
      async (
        clientId: string,
        opts: { official?: boolean; trusted?: boolean; disabled?: boolean; json?: boolean },
      ) => {
        const fields: { official?: boolean; trusted?: boolean; disabled?: boolean } = {};
        if (opts.official !== undefined) fields.official = opts.official;
        if (opts.trusted !== undefined) fields.trusted = opts.trusted;
        if (opts.disabled !== undefined) fields.disabled = opts.disabled;
        if (Object.keys(fields).length === 0) {
          logger.error(
            "Nothing to update: pass at least one of --official/--no-official, --trusted/--no-trusted, --disabled/--no-disabled.",
          );
          process.exit(1);
        }
        const updated = await updateOAuthClient(clientId, fields);
        if (opts.json) return writeJson(updated);
        printClient(updated);
      },
    );

  client
    .command("disable <clientId>")
    .description("Disable a client (reversible kill switch)")
    .option("--json", "Output JSON")
    .action(async (clientId: string, opts: { json?: boolean }) => {
      const updated = await updateOAuthClient(clientId, { disabled: true });
      if (opts.json) return writeJson(updated);
      logger.info(`${updated.clientId}: ${chalk.red("disabled")}`);
    });

  client
    .command("enable <clientId>")
    .description("Re-enable a disabled client")
    .option("--json", "Output JSON")
    .action(async (clientId: string, opts: { json?: boolean }) => {
      const updated = await updateOAuthClient(clientId, { disabled: false });
      if (opts.json) return writeJson(updated);
      logger.info(`${updated.clientId}: ${chalk.green("enabled")}`);
    });

  client
    .command("trust <clientId>")
    .description("Mark a client trusted (skips the consent screen)")
    .option("--json", "Output JSON")
    .action(async (clientId: string, opts: { json?: boolean }) => {
      const updated = await updateOAuthClient(clientId, { trusted: true });
      if (opts.json) return writeJson(updated);
      logger.info(`${updated.clientId}: ${chalk.yellow("trusted")}`);
    });

  client
    .command("untrust <clientId>")
    .description("Remove trusted status (consent screen required again)")
    .option("--json", "Output JSON")
    .action(async (clientId: string, opts: { json?: boolean }) => {
      const updated = await updateOAuthClient(clientId, { trusted: false });
      if (opts.json) return writeJson(updated);
      logger.info(`${updated.clientId}: ${chalk.dim("untrusted")}`);
    });

  client
    .command("rotate-secret <clientId>")
    .description("Rotate a confidential client's secret (new secret shown once)")
    .option("--json", "Output JSON")
    .action(async (clientId: string, opts: { json?: boolean }) => {
      const result = await rotateOAuthClientSecret(clientId);
      if (opts.json) return writeJson(result);
      logger.info(chalk.bold("New client secret (shown once — store it now):"));
      logger.info(`  ${chalk.green(result.clientSecret)}`);
    });

  client
    .command("delete <clientId>")
    .description("Delete a client (hard removal; use disable for a reversible switch)")
    .option("--json", "Output JSON")
    .action(async (clientId: string, opts: { json?: boolean }) => {
      const result = await deleteOAuthClient(clientId);
      if (opts.json) return writeJson(result);
      logger.info(`${result.clientId}: ${chalk.red("deleted")}`);
    });
}
