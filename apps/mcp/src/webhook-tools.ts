import { type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getEntityType } from "@buildinternet/releases-core/id";
import { logEvent } from "@releases/lib/log-event";
import { callMe, text, apiErrorMessage, type ToolReturn } from "./lib/user-api-proxy.js";
import type { Env } from "./mcp-agent.js";
import type {
  MeWorkspace,
  MeWorkspacesResponse,
  UserWebhookListItem,
  UserWebhookListResponse,
  WorkspaceWebhookListItem,
  WorkspaceWebhookListResponse,
  WorkspaceMemberRole,
  CreateUserWebhookResponse,
  CreateWorkspaceWebhookResponse,
  RotateUserWebhookSecretResponse,
  WebhookDeliveryRow,
} from "@buildinternet/releases-api-types";

/**
 * Per-user + per-workspace webhook tools (#1678, #2326) — `list_webhooks` and
 * `manage_webhook`. Like the follows tools (`follows-tools.ts`, #1520), these
 * act on the CALLER'S account rather than the shared registry, so they proxy
 * through the API worker's `/v1/me/webhooks` and `/v1/workspaces/:id/webhooks`
 * routes over the `API` service binding, forwarding the caller's own
 * credential (`McpIdentity.userToken`). A `relu_` user key or an OAuth JWT
 * resolves to a user; anonymous / machine (`relk_`) / root callers do not and
 * are refused with an actionable error, the same as follows.
 *
 * Two tools, not one, so MCP tool annotations stay honest: `list_webhooks` is
 * read-only, `manage_webhook` is a destructive write that reaches an external
 * URL (`openWorldHint: true`). Both accept an optional `workspace` (an id or
 * slug) to target a workspace's webhooks instead of the caller's personal
 * ones — resolved once per call via `GET /v1/me/workspaces` (see
 * `resolveWorkspace`). Workspace membership is confirmed by that resolution,
 * so a subsequent 403/404 from the workspace webhook routes maps to a plain
 * "you can't manage this" / "not found" message rather than a raw HTTP code.
 */

/** Shared message when the caller has no user identity to act as. */
function userRequired(): ToolReturn {
  return text(
    "Managing webhooks requires a signed-in user. Authenticate with a `relu_…` user API key " +
      "or a 'Sign in with Releases' OAuth token (Authorization: Bearer …). Anonymous, " +
      "machine (`relk_…`), and root credentials have no personal or workspace webhooks.",
    true,
  );
}

const READ_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MANAGE_HINTS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Fetch the caller's workspaces from `GET /v1/me/workspaces`, or null on any failure. */
async function fetchWorkspaces(env: Env, userToken: string): Promise<MeWorkspace[] | null> {
  try {
    const { status, json } = await callMe(env, userToken, "/v1/me/workspaces", { method: "GET" });
    if (status !== 200) return null;
    return (json as MeWorkspacesResponse).workspaces ?? null;
  } catch {
    return null;
  }
}

function formatWorkspaceList(workspaces: MeWorkspace[]): string {
  if (workspaces.length === 0) return "You don't belong to any workspaces.";
  return workspaces.map((w) => `- ${w.name} (${w.role}) — id: ${w.id}, slug: ${w.slug}`).join("\n");
}

type ResolvedWorkspace = { ok: true; workspace: MeWorkspace } | { ok: false; error: ToolReturn };

/**
 * Resolve a `workspace` input (id or slug) against the caller's own
 * workspaces. Exact id match first, then exact slug match. On a miss, the
 * error lists the caller's workspaces so the agent can pick a valid one.
 */
async function resolveWorkspace(
  env: Env,
  userToken: string,
  workspace: string,
): Promise<ResolvedWorkspace> {
  const workspaces = await fetchWorkspaces(env, userToken);
  if (workspaces === null) {
    return {
      ok: false,
      error: text("Couldn't load your workspaces to resolve `workspace`. Try again shortly.", true),
    };
  }
  const byId = workspaces.find((w) => w.id === workspace);
  if (byId) return { ok: true, workspace: byId };
  const bySlug = workspaces.find((w) => w.slug === workspace);
  if (bySlug) return { ok: true, workspace: bySlug };
  return {
    ok: false,
    error: text(
      `No workspace matches '${workspace}'. Your workspaces:\n${formatWorkspaceList(workspaces)}`,
      true,
    ),
  };
}

/** Map a free-form org/product/source identifier onto the API's `{ *Id }` / `{ *Slug }` body field. */
function mapEntityField(kind: "org" | "product" | "source", value: string): Record<string, string> {
  const entityType = getEntityType(value.trim());
  const isTypedId =
    (kind === "org" && entityType === "org") ||
    (kind === "product" && entityType === "product") ||
    (kind === "source" && entityType === "source");
  const field = isTypedId ? `${kind}Id` : `${kind}Slug`;
  return { [field]: value.trim() };
}

function apiErrorText(status: number, json: unknown, fallback: string): string {
  return apiErrorMessage(json) ?? `${fallback} (HTTP ${status}).`;
}

/** Map a webhook-route status code to a plain message, given whether the call targets a workspace. */
function statusMessage(
  status: number,
  json: unknown,
  ctx: { inWorkspace: boolean; action: "read" | "write" | "test" },
): string {
  if (status === 403 && ctx.inWorkspace) {
    return "Only workspace owners and admins can change workspace webhooks.";
  }
  if (status === 404) {
    return ctx.inWorkspace ? "Webhook not found in this workspace." : "Webhook not found.";
  }
  if (status === 429) {
    return `${apiErrorText(status, json, "Rate limited")} Try again in a bit.`;
  }
  return apiErrorText(status, json, "Request failed");
}

/** Minimal shape shared by personal and workspace list items, for rendering. */
interface WebhookLike {
  id: string;
  scope: "org" | "follows";
  url: string;
  format: "json" | "slack" | "discord";
  enabled: boolean;
  description: string | null;
  orgName?: string | null;
  productName?: string | null;
  sourceName?: string | null;
  deliveryHealth: string;
  deliveryHealthSummary: string;
  lastErrorMsg?: string | null;
}

function targetLabel(w: WebhookLike): string {
  if (w.scope === "follows") return "everything you follow";
  const parts = [w.orgName, w.productName, w.sourceName].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return parts.length > 0 ? parts.join(" / ") : "(org scope)";
}

function renderWebhookLine(w: WebhookLike): string {
  const status = w.enabled ? w.deliveryHealth : "disabled";
  const lastError = w.lastErrorMsg ? ` · last error: ${w.lastErrorMsg}` : "";
  return `- ${w.id} — ${targetLabel(w)} · ${w.url} · ${w.format} · ${status}${lastError}`;
}

function renderDeliveries(rows: WebhookDeliveryRow[]): string {
  if (rows.length === 0) return "No recent deliveries.";
  return rows
    .map((r) => {
      const when = r.timestamp ?? "?";
      const outcome = r.outcome ?? "?";
      const httpStatus = r.http_status != null ? ` HTTP ${r.http_status}` : "";
      const latency = r.latency_ms != null ? ` (${r.latency_ms}ms)` : "";
      const err = r.error_message ? ` — ${r.error_message}` : "";
      return `- ${when} · ${outcome}${httpStatus}${latency}${err}`;
    })
    .join("\n");
}

function signingKeyNote(format: string, signingKey: string | undefined): string {
  if (format === "slack" || format === "discord") {
    return "This format has no signing key — Slack/Discord deliveries aren't HMAC-signed.";
  }
  if (!signingKey) return "";
  return `\n\nSigning key (shown once — store it now, it will not be shown again):\n${signingKey}`;
}

export function registerWebhookTools(
  server: McpServer,
  env: Env,
  opts: { userToken: string | null },
) {
  const { userToken } = opts;

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhooks",
      annotations: { title: "List webhooks", ...READ_HINTS },
      description: [
        "List your outbound release webhooks, personal or workspace. Requires a signed-in user (a `relu_` user key or an OAuth token).",
        "",
        "With no `workspace`, lists your personal webhooks (`GET /v1/me/webhooks`) and includes a short list of your workspaces (id, slug, role) so you can target one next. Pass `workspace` (an id or a slug) to list that workspace's webhooks instead. Pass `id` to see one webhook plus its 10 most recent deliveries. Pass `enabled` to filter by enabled/disabled state.",
      ].join("\n"),
      inputSchema: z.object({
        workspace: z
          .string()
          .optional()
          .describe("Workspace id or slug. Omit for your personal webhooks."),
        id: z
          .string()
          .optional()
          .describe("Show one webhook (with recent deliveries) instead of the full list."),
        enabled: z.boolean().optional().describe("Filter to enabled or disabled webhooks."),
      }),
    },
    async ({ workspace, id, enabled }) => {
      if (!userToken) return userRequired();
      try {
        let ws: MeWorkspace | null = null;
        if (workspace) {
          const resolved = await resolveWorkspace(env, userToken, workspace);
          if (!resolved.ok) return resolved.error;
          ws = resolved.workspace;
        }
        const base = ws
          ? `/v1/workspaces/${encodeURIComponent(ws.id)}/webhooks`
          : "/v1/me/webhooks";

        if (id) {
          const { status, json } = await callMe(
            env,
            userToken,
            `${base}/${encodeURIComponent(id)}`,
            {
              method: "GET",
            },
          );
          if (status === 0) return text("Webhooks are unavailable in this environment.", true);
          if (status === 401) return userRequired();
          if (status !== 200) {
            return text(statusMessage(status, json, { inWorkspace: !!ws, action: "read" }), true);
          }
          const sub = json as WorkspaceWebhookListItem | UserWebhookListItem;
          const { status: dStatus, json: dJson } = await callMe(
            env,
            userToken,
            `${base}/${encodeURIComponent(id)}/deliveries?limit=10`,
            { method: "GET" },
          );
          const deliveries =
            dStatus === 200 ? ((dJson as { data?: WebhookDeliveryRow[] })?.data ?? []) : [];
          const header = ws ? `Workspace webhook (${ws.name}):` : "Webhook:";
          return text(
            `${header}\n${renderWebhookLine(sub)}\n\nRecent deliveries:\n${renderDeliveries(deliveries)}`,
          );
        }

        const qs = enabled !== undefined ? `?enabled=${enabled}` : "";
        const { status, json } = await callMe(env, userToken, `${base}${qs}`, { method: "GET" });
        if (status === 0) return text("Webhooks are unavailable in this environment.", true);
        if (status === 401) return userRequired();
        if (status !== 200) {
          return text(statusMessage(status, json, { inWorkspace: !!ws, action: "read" }), true);
        }

        if (ws) {
          const body = json as WorkspaceWebhookListResponse;
          const subs = body.subscriptions ?? [];
          const roleLine = `Your role: ${body.role} (${body.canManage ? "can manage" : "read-only"}).`;
          const list =
            subs.length === 0
              ? "No webhooks in this workspace yet."
              : subs.map(renderWebhookLine).join("\n");
          return text(`Workspace "${ws.name}" webhooks (${subs.length}). ${roleLine}\n${list}`);
        }

        const body = json as UserWebhookListResponse;
        const subs = body.subscriptions ?? [];
        const list =
          subs.length === 0 ? "No personal webhooks yet." : subs.map(renderWebhookLine).join("\n");
        const workspaces = await fetchWorkspaces(env, userToken);
        const workspacesSection =
          workspaces && workspaces.length > 0
            ? `\n\nYour workspaces (pass one as \`workspace\` to see its webhooks):\n${formatWorkspaceList(workspaces)}`
            : "";
        return text(`Personal webhooks (${subs.length}):\n${list}${workspacesSection}`);
      } catch (err) {
        logEvent("error", { component: "mcp-webhooks", event: "list-failed", err });
        return text("Failed to load webhooks (internal error).", true);
      }
    },
  );

  server.registerTool(
    "manage_webhook",
    {
      title: "Manage webhook",
      annotations: { title: "Manage webhook", ...MANAGE_HINTS },
      description: [
        "Create, update, delete, test, or rotate the signing key of an outbound release webhook — personal or workspace. Requires a signed-in user. This tool sends requests to an external URL you supply and can delete or disable delivery, so treat it as a write.",
        "",
        'Pass `workspace` (an id or slug) to act on a workspace\'s webhooks instead of your personal ones; workspace webhooks are always org-scoped (`scope: "follows"` is personal-only and is rejected up front). Only workspace owners and admins can create, update, delete, or rotate a workspace webhook — any member can test one.',
        "",
        '`action: "create"` needs `url` and `format` (`json`, `slack`, or `discord`), plus either `scope: "follows"` (personal only — everything you follow) or an org-scoped target: `org` (an org slug or `org_…` id), optionally narrowed by `product` (slug or `prod_…` id) or `source` (slug or `src_…` id). `action: "update"` needs `id` plus any fields to change; pass `source: null` or `product: null` to clear a filter. `action: "delete"`, `action: "test"`, and `action: "rotate_secret"` need only `id`.',
        "",
        "`create` and `rotate_secret` return a one-time `signingKey` for `json`-format webhooks — store it now, it will not be shown again. `slack` and `discord` deliveries aren't signed, so those formats never return one.",
      ].join("\n"),
      inputSchema: z.object({
        action: z.enum(["create", "update", "delete", "test", "rotate_secret"]),
        workspace: z
          .string()
          .optional()
          .describe("Workspace id or slug. Omit to act on your personal webhooks."),
        id: z
          .string()
          .optional()
          .describe("Webhook id — required for update, delete, test, and rotate_secret."),
        url: z.string().optional().describe("Delivery URL. Required for create."),
        scope: z
          .enum(["org", "follows"])
          .optional()
          .describe(
            'Create only. "follows" is personal-only and defaults org-scoped when omitted.',
          ),
        org: z
          .string()
          .optional()
          .describe("Org slug or org_… id. Required for an org-scoped create."),
        product: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Product slug or prod_… id to narrow an org-scoped webhook. null clears it on update.",
          ),
        source: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Source slug or src_… id to narrow an org-scoped webhook. null clears it on update.",
          ),
        releaseType: z
          .enum(["feature", "rollup"])
          .optional()
          .describe("Optional filter on release taxonomy type."),
        format: z.enum(["json", "slack", "discord"]).optional().describe("Delivery format."),
        description: z.string().optional().describe("Freeform label for the webhook."),
        enabled: z.boolean().optional().describe("Update only. Enable or disable delivery."),
      }),
    },
    async ({
      action,
      workspace,
      id,
      url,
      scope,
      org,
      product,
      source,
      releaseType,
      format,
      description,
      enabled,
    }) => {
      if (!userToken) return userRequired();
      try {
        let ws: MeWorkspace | null = null;
        if (workspace) {
          const resolved = await resolveWorkspace(env, userToken, workspace);
          if (!resolved.ok) return resolved.error;
          ws = resolved.workspace;
        }
        const base = ws
          ? `/v1/workspaces/${encodeURIComponent(ws.id)}/webhooks`
          : "/v1/me/webhooks";

        if (ws && scope === "follows") {
          return text(
            'Workspace webhooks must be org-scoped — "follows" scope only exists for personal webhooks. Omit `workspace` to create a follows-scoped webhook on your own account.',
            true,
          );
        }

        switch (action) {
          case "create": {
            if (!url) return text("`url` is required to create a webhook.", true);
            if (!format) {
              return text(
                "`format` is required to create a webhook: json, slack, or discord.",
                true,
              );
            }
            const body: Record<string, unknown> = {
              url,
              format,
              description: description ?? null,
            };
            if (scope === "follows") {
              if (org || product || source) {
                return text(
                  'A follows-scoped webhook can\'t also target `org`/`product`/`source` — remove those or use `scope: "org"`.',
                  true,
                );
              }
              body.scope = "follows";
              if (releaseType) body.releaseType = releaseType;
            } else {
              if (!org) {
                return text(
                  "`org` (an org slug or org_… id) is required for an org-scoped webhook.",
                  true,
                );
              }
              if (!ws) body.scope = "org";
              Object.assign(body, mapEntityField("org", org));
              if (product) Object.assign(body, mapEntityField("product", product));
              if (source) Object.assign(body, mapEntityField("source", source));
              if (releaseType) body.releaseType = releaseType;
            }
            const { status, json } = await callMe(env, userToken, base, {
              method: "POST",
              body: JSON.stringify(body),
            });
            if (status === 0) return text("Webhooks are unavailable in this environment.", true);
            if (status === 401) return userRequired();
            if (status !== 201) {
              return text(
                statusMessage(status, json, { inWorkspace: !!ws, action: "write" }),
                true,
              );
            }
            const created = json as CreateUserWebhookResponse | CreateWorkspaceWebhookResponse;
            const note = signingKeyNote(created.format, created.signingKey);
            return text(
              `Created webhook ${created.id} (${targetLabel(created as unknown as WebhookLike)} · ${created.format}).${note}`,
            );
          }

          case "update": {
            if (!id) return text("`id` is required to update a webhook.", true);
            const patch: Record<string, unknown> = {};
            if (url !== undefined) patch.url = url;
            if (description !== undefined) patch.description = description;
            if (enabled !== undefined) patch.enabled = enabled;
            if (format !== undefined) patch.format = format;
            if (releaseType !== undefined) patch.releaseType = releaseType;
            if (source !== undefined) {
              Object.assign(
                patch,
                source === null ? { sourceId: null } : mapEntityField("source", source),
              );
            }
            if (product !== undefined) {
              Object.assign(
                patch,
                product === null ? { productId: null } : mapEntityField("product", product),
              );
            }
            if (Object.keys(patch).length === 0) {
              return text(
                "Provide at least one field to update (url, description, enabled, format, releaseType, source, or product).",
                true,
              );
            }
            const { status, json } = await callMe(
              env,
              userToken,
              `${base}/${encodeURIComponent(id)}`,
              { method: "PATCH", body: JSON.stringify(patch) },
            );
            if (status === 0) return text("Webhooks are unavailable in this environment.", true);
            if (status === 401) return userRequired();
            if (status !== 200) {
              return text(
                statusMessage(status, json, { inWorkspace: !!ws, action: "write" }),
                true,
              );
            }
            const updated = json as WorkspaceWebhookListItem | UserWebhookListItem;
            return text(`Updated webhook ${id}.\n${renderWebhookLine(updated)}`);
          }

          case "delete": {
            if (!id) return text("`id` is required to delete a webhook.", true);
            const { status, json } = await callMe(
              env,
              userToken,
              `${base}/${encodeURIComponent(id)}`,
              { method: "DELETE" },
            );
            if (status === 0) return text("Webhooks are unavailable in this environment.", true);
            if (status === 401) return userRequired();
            if (status !== 204) {
              return text(
                statusMessage(status, json, { inWorkspace: !!ws, action: "write" }),
                true,
              );
            }
            return text(`Deleted webhook ${id}.`);
          }

          case "test": {
            if (!id) return text("`id` is required to send a test delivery.", true);
            const { status, json } = await callMe(
              env,
              userToken,
              `${base}/${encodeURIComponent(id)}/test`,
              { method: "POST", body: "" },
            );
            if (status === 0) return text("Webhooks are unavailable in this environment.", true);
            if (status === 401) return userRequired();
            if (status !== 200) {
              return text(statusMessage(status, json, { inWorkspace: !!ws, action: "test" }), true);
            }
            return text(`Test delivery queued for webhook ${id}.`);
          }

          case "rotate_secret": {
            if (!id) return text("`id` is required to rotate a signing key.", true);
            const { status, json } = await callMe(
              env,
              userToken,
              `${base}/${encodeURIComponent(id)}/rotate-secret`,
              { method: "POST", body: "" },
            );
            if (status === 0) return text("Webhooks are unavailable in this environment.", true);
            if (status === 401) return userRequired();
            if (status !== 200) {
              return text(
                statusMessage(status, json, { inWorkspace: !!ws, action: "write" }),
                true,
              );
            }
            const rotated = json as RotateUserWebhookSecretResponse;
            return text(
              `Rotated signing key for webhook ${id} (secret version ${rotated.secretVersion}).\n\nSigning key (shown once — store it now, it will not be shown again):\n${rotated.signingKey}`,
            );
          }
        }
      } catch (err) {
        logEvent("error", { component: "mcp-webhooks", event: "manage-failed", err });
        return text("Failed to manage webhook (internal error).", true);
      }
    },
  );
}

// Re-exported for tests that assert on workspace member roles.
export type { WorkspaceMemberRole };
