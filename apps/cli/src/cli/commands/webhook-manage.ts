/**
 * `releases webhook {list,add,…}` — manage outbound webhook subscriptions via
 * `/v1/me/webhooks`, or via `/v1/workspaces/:id/webhooks` when `--workspace
 * <id-or-slug>` is passed (releases-cli#406). Requires `releases login` (or
 * RELEASES_API_KEY). `releases webhook verify` stays in `webhook.ts` (no auth).
 */
import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { isAuthenticated } from "../../lib/mode.js";
import { writeJson } from "../../lib/output.js";
import type { WebhookDeliveryRow } from "../../api/webhooks.js";
import {
  createWebhook,
  deleteWebhook,
  getMyWebhookDeliveries,
  getWebhook,
  getWebhookDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  type AnyCreateWebhookResponse,
  type AnyWebhookListItem,
  type AnyWebhookSubscription,
  type RotateUserWebhookSecretResponse,
  type TestUserWebhookResponse,
  type UpdateMyWebhookInput,
  type UserWebhookFormat,
} from "../../api/me-webhooks.js";
import {
  assertWorkspaceScopeSupported,
  resolveWebhookOwner,
  translateWebhookApiError,
} from "./webhook-owner.js";
import { renderTable } from "../render/table.js";

/** A subscription row from either owner's list or single-item routes. */
type WebhookRow = AnyWebhookListItem | AnyWebhookSubscription;

function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error(
      chalk.red("Not signed in. Run `releases login` first (or set RELEASES_API_KEY)."),
    );
    process.exit(1);
  }
}

function statusLabel(enabled: boolean): string {
  return enabled ? chalk.green("enabled") : chalk.red("disabled");
}

function scopeLabel(sub: WebhookRow): string {
  if (sub.scope === "follows") return chalk.dim("follows");
  if ("orgSlug" in sub && sub.orgSlug) return sub.orgSlug;
  return sub.orgId ?? chalk.dim("org");
}

function subscriptionTitle(sub: WebhookRow): string {
  if (sub.description?.trim()) return sub.description.trim();
  if (sub.scope === "follows") return "Everything you follow";
  if ("orgName" in sub && sub.orgName) return sub.orgName;
  return sub.id;
}

function parseReleaseTypeOpt(value: string | undefined): "feature" | "rollup" | undefined {
  if (!value) return undefined;
  if (value === "feature" || value === "rollup") return value;
  logger.error("--type must be feature or rollup.");
  process.exit(1);
}

function parseFormatOpt(format: string | undefined): UserWebhookFormat {
  if (!format || format === "json") return "json";
  if (format === "slack") return "slack";
  if (format === "discord") return "discord";
  logger.error("--format must be 'json', 'slack', or 'discord'.");
  process.exit(1);
}

function parseLimit(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n === 0) return 20;
  return Math.min(100, Math.max(1, n));
}

/**
 * Human-readable webhook URL. Slack/Discord treat the URL as the secret;
 * JSON endpoints often bury a token in the last path segment too. Keep the
 * host + path prefix, drop the last segment and any query/hash. `--json`
 * still emits the raw URL.
 */
export function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return parsed.origin;
    const kept = parts.slice(0, -1);
    const path = kept.length > 0 ? `/${kept.join("/")}/••••` : "/••••";
    return `${parsed.origin}${path}`;
  } catch {
    return "••••";
  }
}

function printSubscription(sub: WebhookRow): void {
  logger.info(`${chalk.bold(sub.id)}  ${statusLabel(sub.enabled)}  ${scopeLabel(sub)}`);
  logger.info(`  url:     ${redactWebhookUrl(sub.url)}`);
  if (sub.scope === "org") {
    const product =
      "productSlug" in sub && sub.productSlug
        ? sub.productSlug
        : sub.productId
          ? sub.productId
          : chalk.dim("(all products)");
    const source =
      "sourceSlug" in sub && sub.sourceSlug
        ? sub.sourceSlug
        : sub.sourceId
          ? sub.sourceId
          : chalk.dim("(all org sources)");
    logger.info(`  product: ${product}`);
    logger.info(`  source:  ${source}`);
  }
  if (sub.releaseType) logger.info(`  type:    ${sub.releaseType}`);
  if (sub.format === "slack") logger.info(`  format:  slack (Slack Block Kit, unsigned)`);
  if (sub.format === "discord") logger.info(`  format:  discord (Discord embed, unsigned)`);
  if (sub.description) logger.info(`  desc:    ${sub.description}`);
  logger.info(`  secret:  v${sub.secretVersion}${chalk.dim(`  · created ${sub.createdAt}`)}`);
  logger.info(`  health:  ${sub.deliveryHealthSummary}`);
  logger.info(
    `  last ok: ${sub.lastSuccessAt ?? chalk.dim("—")}   failures: ${sub.consecutiveFailures}`,
  );
  if (sub.lastErrorAt) {
    logger.info(`  last err: ${sub.lastErrorAt} ${chalk.dim(sub.lastErrorMsg ?? "")}`);
  }
  if (!sub.enabled && sub.disabledReason) {
    logger.info(`  ${chalk.red(`disabled: ${sub.disabledReason}`)}`);
  }
}

function isDeliveriesUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\(501\)|deliveries_unavailable|CF_API_TOKEN/.test(msg);
}

function renderDeliveries(rows: WebhookDeliveryRow[]): string {
  return renderTable({
    head: [
      { label: "Time", noTruncate: true },
      { label: "Format" },
      { label: "Outcome" },
      { label: "HTTP" },
      { label: "Latency" },
      { label: "Attempt" },
      { label: "Error" },
    ],
    rows: rows.map((r) => [
      r.timestamp ?? chalk.dim("—"),
      r.format?.trim() || chalk.dim("—"),
      r.outcome ?? chalk.dim("—"),
      r.http_status != null ? String(r.http_status) : chalk.dim("—"),
      r.latency_ms != null ? `${r.latency_ms}ms` : chalk.dim("—"),
      r.attempt != null ? String(r.attempt) : chalk.dim("—"),
      r.error_message ?? chalk.dim("—"),
    ]),
  });
}

export function registerWebhookManageCommands(webhook: Command): void {
  webhook
    .command("list")
    .description("List your webhook subscriptions (or a workspace's, with --workspace)")
    .option("--enabled", "Only enabled subscriptions")
    .option("--disabled", "Only disabled subscriptions")
    .option("--workspace <id-or-slug>", "List a workspace's shared webhooks instead of your own")
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        enabled?: boolean;
        disabled?: boolean;
        workspace?: string;
        json?: boolean;
      }) => {
        requireAuth();
        if (opts.enabled && opts.disabled) {
          logger.error("Pass at most one of --enabled / --disabled.");
          process.exit(1);
        }
        let filter: { enabled?: boolean } | undefined;
        if (opts.enabled) filter = { enabled: true };
        else if (opts.disabled) filter = { enabled: false };
        const { owner } = await resolveWebhookOwner(opts.workspace);
        const { subscriptions, role, canManage } = await listWebhooks(owner, filter);
        if (opts.json) return writeJson({ subscriptions, role, canManage });
        if (role) {
          logger.info(chalk.dim(`Your role in this workspace: ${role}`));
        }
        if (subscriptions.length === 0) {
          logger.info("No webhook subscriptions.");
          return;
        }
        console.log(
          renderTable({
            head: [
              { label: "ID", noTruncate: true },
              { label: "Scope" },
              { label: "Label" },
              { label: "URL", noTruncate: true },
              { label: "Status" },
              { label: "Health" },
            ],
            rows: subscriptions.map((s) => [
              s.id,
              s.scope,
              subscriptionTitle(s),
              redactWebhookUrl(s.url),
              s.enabled ? "enabled" : "disabled",
              s.deliveryHealth,
            ]),
          }),
        );
      },
    );

  webhook
    .command("add")
    .description(
      "Create a webhook subscription (JSON signing key shown once; Slack/Discord use the URL as the secret)",
    )
    .requiredOption("--url <url>", "HTTPS delivery URL")
    .option("--scope <scope>", "org (default) or follows", "org")
    .option("--org <slug>", "Org slug or id (required for org scope)")
    .option("--source <slug>", "Limit to one source (org scope only)")
    .option("--product <slug>", "Limit to one product (org scope only)")
    .option("--type <kind>", "Limit to release type: feature or rollup")
    .option("--description <text>", "Human-readable label")
    .option("--format <format>", "Delivery format: json (default), slack, or discord")
    .option(
      "--workspace <id-or-slug>",
      "Create a workspace-owned webhook instead of your own (org scope only)",
    )
    .option("--json", "Output JSON")
    .action(
      async (opts: {
        url: string;
        scope: string;
        org?: string;
        source?: string;
        product?: string;
        type?: string;
        description?: string;
        format?: string;
        workspace?: string;
        json?: boolean;
      }) => {
        requireAuth();
        const format = parseFormatOpt(opts.format);
        const scope = opts.scope === "follows" ? "follows" : "org";
        assertWorkspaceScopeSupported(opts.workspace, scope);
        const releaseType = parseReleaseTypeOpt(opts.type);
        if (scope === "org" && !opts.org) {
          logger.error("--org is required for org-scoped webhooks.");
          process.exit(1);
        }
        if (scope === "follows" && (opts.org || opts.source || opts.product)) {
          logger.error("follows-scoped webhooks must not include --org, --source, or --product.");
          process.exit(1);
        }
        const { owner } = await resolveWebhookOwner(opts.workspace);
        let result: AnyCreateWebhookResponse;
        try {
          result = await createWebhook(owner, {
            url: opts.url,
            scope,
            format,
            ...(scope === "org"
              ? {
                  orgSlug: opts.org,
                  ...(opts.source ? { sourceSlug: opts.source } : {}),
                  ...(opts.product ? { productSlug: opts.product } : {}),
                }
              : {}),
            ...(releaseType ? { releaseType } : {}),
            description: opts.description,
          });
        } catch (err) {
          translateWebhookApiError(err, owner);
        }
        if (opts.json) return writeJson(result);
        printSubscription(result);
        if (result.signingKey) {
          logger.info("");
          logger.info(chalk.bold("Signing key (shown once — store it now):"));
          logger.info(`  ${chalk.green(result.signingKey)}`);
          logger.info(
            chalk.dim("  Re-derive only via `webhook rotate-secret` (invalidates the old key)."),
          );
        } else {
          logger.info("");
          const kind = format === "discord" ? "Discord" : "Slack";
          logger.info(chalk.dim(`  ${kind} webhook — no signing key (the URL is the secret).`));
        }
      },
    );

  webhook
    .command("show <id>")
    .description("Show one subscription plus its last 10 delivery attempts")
    .option("--workspace <id-or-slug>", "Look up a workspace-owned webhook instead of your own")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { workspace?: string; json?: boolean }) => {
      requireAuth();
      const { owner } = await resolveWebhookOwner(opts.workspace);
      const sub = await getWebhook(owner, id);
      if (!sub) {
        logger.error("Subscription not found.");
        process.exit(1);
      }
      let deliveries: WebhookDeliveryRow[] = [];
      let deliveriesUnavailable = false;
      try {
        deliveries = await getWebhookDeliveries(owner, id, { limit: 10 });
      } catch (err) {
        if (isDeliveriesUnavailable(err)) deliveriesUnavailable = true;
        else throw err;
      }
      if (opts.json) return writeJson({ ...sub, deliveries });
      printSubscription(sub);
      logger.info("");
      if (deliveriesUnavailable) {
        logger.info(chalk.dim("Delivery history unavailable (Analytics Engine not configured)."));
      } else if (deliveries.length === 0) {
        logger.info(chalk.dim("No delivery attempts recorded."));
      } else {
        logger.info(chalk.bold("Recent deliveries:"));
        console.log(renderDeliveries(deliveries));
      }
    });

  webhook
    .command("edit <id>")
    .description("Update a subscription's url / description / enabled state / filters")
    .option("--url <url>", "New HTTPS delivery URL (does not rotate the signing key)")
    .option("--description <text>", "New description")
    .option("--source <slug>", "Org scope: limit to this source slug")
    .option("--product <slug>", "Org scope: limit to this product slug")
    .option("--type <kind>", "Limit to release type: feature or rollup")
    .option("--clear-source", "Org scope: remove source filter")
    .option("--clear-product", "Org scope: remove product filter")
    .option("--clear-type", "Remove release-type filter")
    .option("--enable", "Enable the subscription (resets the failure counter)")
    .option("--disable", "Disable the subscription")
    .option("--format <format>", "Change delivery format: json, slack, or discord")
    .option("--workspace <id-or-slug>", "Edit a workspace-owned webhook instead of your own")
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: {
          url?: string;
          description?: string;
          source?: string;
          product?: string;
          type?: string;
          clearSource?: boolean;
          clearProduct?: boolean;
          clearType?: boolean;
          enable?: boolean;
          disable?: boolean;
          format?: string;
          workspace?: string;
          json?: boolean;
        },
      ) => {
        requireAuth();
        if (opts.enable && opts.disable) {
          logger.error("Pass at most one of --enable / --disable.");
          process.exit(1);
        }
        if (opts.clearSource && opts.source) {
          logger.error("Pass at most one of --source / --clear-source.");
          process.exit(1);
        }
        if (opts.clearProduct && opts.product) {
          logger.error("Pass at most one of --product / --clear-product.");
          process.exit(1);
        }
        if (opts.clearType && opts.type) {
          logger.error("Pass at most one of --type / --clear-type.");
          process.exit(1);
        }
        const fields: UpdateMyWebhookInput = {};
        if (opts.url !== undefined) fields.url = opts.url;
        if (opts.description !== undefined) fields.description = opts.description;
        if (opts.enable) fields.enabled = true;
        if (opts.disable) fields.enabled = false;
        if (opts.source) fields.sourceSlug = opts.source;
        if (opts.clearSource) fields.sourceId = null;
        if (opts.product) fields.productSlug = opts.product;
        if (opts.clearProduct) fields.productId = null;
        if (opts.clearType) fields.releaseType = null;
        else if (opts.type !== undefined)
          fields.releaseType = parseReleaseTypeOpt(opts.type) ?? null;
        if (opts.format) fields.format = parseFormatOpt(opts.format);
        if (Object.keys(fields).length === 0) {
          logger.error(
            "Nothing to change. Pass --url, --description, --format, filter flags, --enable, or --disable.",
          );
          process.exit(1);
        }
        const { owner } = await resolveWebhookOwner(opts.workspace);
        let updated: AnyWebhookSubscription;
        try {
          updated = await updateWebhook(owner, id, fields);
        } catch (err) {
          translateWebhookApiError(err, owner);
        }
        if (opts.json) return writeJson(updated);
        printSubscription(updated);
      },
    );

  webhook
    .command("remove <id>")
    .description("Hard-delete a subscription")
    .option("--workspace <id-or-slug>", "Delete a workspace-owned webhook instead of your own")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { workspace?: string; json?: boolean }) => {
      requireAuth();
      const { owner } = await resolveWebhookOwner(opts.workspace);
      try {
        await deleteWebhook(owner, id);
      } catch (err) {
        translateWebhookApiError(err, owner);
      }
      if (opts.json) return writeJson({ id, deleted: true });
      logger.info(`${id}: ${chalk.red("deleted")}`);
    });

  webhook
    .command("test <id>")
    .description("Enqueue a synthetic release.created event to the subscription URL")
    .option("--workspace <id-or-slug>", "Test a workspace-owned webhook instead of your own")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { workspace?: string; json?: boolean }) => {
      requireAuth();
      const { owner } = await resolveWebhookOwner(opts.workspace);
      let result: TestUserWebhookResponse;
      try {
        result = await testWebhook(owner, id);
      } catch (err) {
        translateWebhookApiError(err, owner);
      }
      if (opts.json) return writeJson(result);
      logger.info(`${chalk.green("enqueued")} test event ${chalk.dim(result.eventId)} → ${id}`);
    });

  webhook
    .command("rotate-secret <id>")
    .description("Rotate the signing key (new key shown once; old key invalidated)")
    .option(
      "--workspace <id-or-slug>",
      "Rotate a workspace-owned webhook's secret instead of your own",
    )
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { workspace?: string; json?: boolean }) => {
      requireAuth();
      const { owner } = await resolveWebhookOwner(opts.workspace);
      let result: RotateUserWebhookSecretResponse;
      try {
        result = await rotateWebhookSecret(owner, id);
      } catch (err) {
        translateWebhookApiError(err, owner);
      }
      if (opts.json) return writeJson(result);
      logger.info(
        chalk.bold(`New signing key (v${result.secretVersion}, shown once — store it now):`),
      );
      logger.info(`  ${chalk.green(result.signingKey)}`);
    });

  webhook
    .command("deliveries <id>")
    .description("Show recent delivery attempts from Analytics Engine")
    .option("--failed", "Only failed attempts (retry / perm_fail / dlq / auto_disabled)")
    .option("--since <iso>", "Only attempts at or after this ISO timestamp (filtered client-side)")
    .option("--limit <n>", "Max attempts to fetch (default 20, max 100)", parseLimit)
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: { failed?: boolean; since?: string; limit?: number; json?: boolean },
      ) => {
        requireAuth();
        let rows: WebhookDeliveryRow[];
        try {
          rows = await getMyWebhookDeliveries(id, { failed: opts.failed, limit: opts.limit });
        } catch (err) {
          if (isDeliveriesUnavailable(err)) {
            logger.error(
              "Delivery history unavailable — the API has no Analytics Engine query configured.",
            );
            process.exit(1);
          }
          throw err;
        }
        if (opts.since) {
          const cutoff = Date.parse(opts.since);
          if (Number.isNaN(cutoff)) {
            logger.error(`Invalid --since timestamp: ${opts.since}`);
            process.exit(1);
          }
          rows = rows.filter((r) => r.timestamp != null && Date.parse(r.timestamp) >= cutoff);
        }
        if (opts.json) return writeJson({ deliveries: rows });
        if (rows.length === 0) {
          logger.info("No delivery attempts.");
          return;
        }
        console.log(renderDeliveries(rows));
      },
    );
}
