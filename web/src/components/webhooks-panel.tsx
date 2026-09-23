"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { UserWebhookListItem, UserWebhookScope } from "@buildinternet/releases-api-types";
import { inputClass, smallButtonClass } from "@releases/design-system";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WebhookFormatIcon,
  isUnsignedWebhookFormat,
  webhookFormatLabel,
  webhookFormatPickerLabel,
} from "@/components/webhook-format-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  type UserWebhookFormat,
  type WebhookDeliveryRow,
} from "@/lib/webhooks";
import { webhookCreateInitialState, type WebhookCreatePrefill } from "@/lib/webhook-create";

/** Applies to both personal (`/v1/me/webhooks`) and workspace-owned org subscriptions. */
export const MAX_ORG_WEBHOOKS = 10;

/**
 * The subset of the webhook CRUD surface {@link WebhooksPanel} drives. The
 * default (`defaultClient`, below) binds the personal `/v1/me/webhooks`
 * functions; {@link WorkspaceWebhooksPanel} in `workspace-webhooks-panel.tsx`
 * binds the `/v1/workspaces/:workspaceId/webhooks` ones (#2324) to the same
 * shape, parameterized by workspace id.
 */
export type WebhooksPanelClient = {
  list: () => Promise<UserWebhookListItem[]>;
  create: (input: {
    url: string;
    scope?: UserWebhookScope;
    orgSlug?: string;
    productSlug?: string;
    sourceSlug?: string;
    releaseType?: "feature" | "rollup";
    format?: UserWebhookFormat;
    description?: string;
  }) => Promise<{ signingKey?: string }>;
  update: (
    id: string,
    patch: { url?: string; description?: string | null; enabled?: boolean },
  ) => Promise<UserWebhookListItem>;
  delete: (id: string) => Promise<void>;
  rotateSecret: (id: string) => ReturnType<typeof rotateWebhookSecret>;
  test: (id: string) => ReturnType<typeof testWebhook>;
  listDeliveries: (
    id: string,
    opts?: { failed?: boolean; limit?: number },
  ) => Promise<WebhookDeliveryRow[] | null>;
};

const defaultClient: WebhooksPanelClient = {
  list: listWebhooks,
  create: createWebhook,
  update: updateWebhook,
  delete: deleteWebhook,
  rotateSecret: rotateWebhookSecret,
  test: testWebhook,
  listDeliveries: listWebhookDeliveries,
};

function subscriptionLabel(sub: UserWebhookListItem): string {
  if (sub.description?.trim()) return sub.description.trim();
  if (sub.scope === "follows") return "Everything you follow";
  if (sub.orgName) return sub.orgName;
  if (sub.orgSlug) return sub.orgSlug;
  return "Webhook";
}

function scopeDetail(sub: UserWebhookListItem): string {
  if (sub.scope === "follows") {
    return sub.releaseType ? `Follows · ${sub.releaseType} only` : "Follows · real-time";
  }
  const parts = [sub.orgSlug ?? sub.orgName ?? "org"];
  if (sub.productSlug) parts.push(sub.productSlug);
  if (sub.sourceSlug) parts.push(sub.sourceSlug);
  if (sub.releaseType) parts.push(sub.releaseType);
  return parts.filter(Boolean).join(" / ");
}

function outcomeTone(outcome: string | undefined): string {
  switch (outcome) {
    case "success":
      return "text-green-700 dark:text-green-400";
    case "retry":
      return "text-amber-700 dark:text-amber-400";
    case "perm_fail":
    case "dlq":
    case "auto_disabled":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-stone-500 dark:text-stone-400";
  }
}

function WebhookDeliveriesLog({
  subscriptionId,
  listDeliveries,
}: {
  subscriptionId: string;
  listDeliveries: WebhooksPanelClient["listDeliveries"];
}) {
  const [rows, setRows] = useState<WebhookDeliveryRow[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setRows(undefined);
      setError(null);
      try {
        const data = await listDeliveries(subscriptionId, { limit: 15 });
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load activity.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriptionId, listDeliveries]);

  if (rows === undefined) {
    return <p className="text-[11px] text-stone-400 dark:text-stone-500">Loading activity…</p>;
  }

  if (error) {
    return <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>;
  }

  if (rows === null) {
    return (
      <p className="text-[11px] text-stone-400 dark:text-stone-500">
        Delivery history is temporarily unavailable.
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-stone-400 dark:text-stone-500">
        No delivery attempts yet. Send a test to verify your endpoint.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-[11px] text-stone-600 dark:text-stone-300">
        <thead className="text-stone-400 dark:text-stone-500">
          <tr>
            <th className="py-1 pr-3 font-medium">Time</th>
            <th className="py-1 pr-3 font-medium">Format</th>
            <th className="py-1 pr-3 font-medium">Outcome</th>
            <th className="py-1 pr-3 font-medium">HTTP</th>
            <th className="py-1 pr-3 font-medium">Latency</th>
            <th className="py-1 pr-3 font-medium">Event</th>
            <th className="py-1 font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={`${row.timestamp ?? i}-${row.event_id ?? i}`}
              className="border-t border-stone-100 dark:border-stone-800"
            >
              <td className="py-1 pr-3 whitespace-nowrap">{row.timestamp ?? "—"}</td>
              <td className="py-1 pr-3">
                {row.format === "json" || row.format === "slack" || row.format === "discord" ? (
                  <span className="inline-flex items-center gap-1">
                    <WebhookFormatIcon format={row.format} className="size-3 shrink-0" />
                    {row.format}
                  </span>
                ) : (
                  row.format?.trim() || "—"
                )}
              </td>
              <td className={`py-1 pr-3 ${outcomeTone(row.outcome)}`}>{row.outcome ?? "—"}</td>
              <td className="py-1 pr-3">{row.http_status ?? "—"}</td>
              <td className="py-1 pr-3">{row.latency_ms != null ? `${row.latency_ms}ms` : "—"}</td>
              <td className="py-1 pr-3 font-mono text-[10px]">{row.event_id ?? "—"}</td>
              <td className="py-1 max-w-[12rem] truncate" title={row.error_message ?? undefined}>
                {row.error_message?.trim() || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function healthTone(health: UserWebhookListItem["deliveryHealth"]): string {
  switch (health) {
    case "healthy":
      return "text-green-700 dark:text-green-400";
    case "degraded":
      return "text-amber-700 dark:text-amber-400";
    case "failing":
    case "auto_paused":
      return "text-red-600 dark:text-red-400";
    case "paused":
      return "text-stone-500 dark:text-stone-400";
    default:
      return "text-stone-500 dark:text-stone-400";
  }
}

export function WebhooksPanel({
  initialWebhooks = null,
  createPrefill = null,
  client = defaultClient,
  allowFollows = true,
  canManage = true,
  intro = (
    <>
      Receive signed <code className="font-mono text-[0.9em]">release.created</code> POSTs in real
      time — for everything you follow or a single org.{" "}
      <Link href="/docs/api/webhooks" className="underline underline-offset-2">
        Docs
      </Link>
    </>
  ),
}: {
  /** Optional bootstrap from GET /v1/me/settings/developer (skips mount fetch). */
  initialWebhooks?: UserWebhookListItem[] | null;
  /** Org-page deep-link: start the create form on Org scope with the slug filled. */
  createPrefill?: WebhookCreatePrefill | null;
  /** CRUD surface to drive — defaults to personal `/v1/me/webhooks`; workspace mode
   *  (#2324) binds `/v1/workspaces/:workspaceId/webhooks` to the same shape. */
  client?: WebhooksPanelClient;
  /** False for workspace webhooks — there is no workspace follows scope. */
  allowFollows?: boolean;
  /** False hides create/edit/pause/rotate/delete; Test + the delivery log stay visible. */
  canManage?: boolean;
  /** Intro copy under the "Webhooks" heading. */
  intro?: React.ReactNode;
}) {
  const prefill = webhookCreateInitialState(createPrefill);
  const [subs, setSubs] = useState<UserWebhookListItem[]>(initialWebhooks ?? []);
  const [loading, setLoading] = useState(initialWebhooks == null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [scope, setScope] = useState<UserWebhookScope>(allowFollows ? prefill.scope : "org");
  const [url, setUrl] = useState("");
  const [orgSlug, setOrgSlug] = useState(prefill.orgSlug);
  const [productSlug, setProductSlug] = useState("");
  const [sourceSlug, setSourceSlug] = useState("");
  const [releaseType, setReleaseType] = useState<"" | "feature" | "rollup">("");
  const [format, setFormat] = useState<UserWebhookFormat>("json");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "delete" | "rotate"; id: string }>(null);
  const { copied, copy } = useCopyToClipboard();

  const orgCount = subs.filter((s) => s.scope === "org").length;
  const hasFollows = allowFollows && subs.some((s) => s.scope === "follows");
  const canCreateFollows = allowFollows && !hasFollows;
  const canCreateOrg = orgCount < MAX_ORG_WEBHOOKS;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSubs(await client.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load webhooks.");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (initialWebhooks != null) return;
    void refresh();
  }, [initialWebhooks, refresh]);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canManage) return;
    if (creating || !url.trim()) return;
    if (scope === "follows" && !canCreateFollows) return;
    if (scope === "org" && (!orgSlug.trim() || !canCreateOrg)) return;

    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await client.create({
        url: url.trim(),
        scope,
        format,
        ...(scope === "org"
          ? {
              orgSlug: orgSlug.trim(),
              ...(productSlug.trim() ? { productSlug: productSlug.trim() } : {}),
              ...(sourceSlug.trim() ? { sourceSlug: sourceSlug.trim() } : {}),
            }
          : {}),
        ...(releaseType ? { releaseType } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      if (created.signingKey) {
        setRevealedKey(created.signingKey);
        setSuccess("Webhook created. Copy the signing key before dismissing.");
      } else if (format === "discord") {
        setSuccess("Discord webhook created.");
      } else {
        setSuccess("Slack webhook created.");
      }
      setUrl("");
      setOrgSlug("");
      setProductSlug("");
      setSourceSlug("");
      setReleaseType("");
      setFormat("json");
      setDescription("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create webhook.");
    } finally {
      setCreating(false);
    }
  }

  async function runAction(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    setSuccess(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function onRotate(id: string) {
    if (!canManage) return;
    setBusyId(id);
    setError(null);
    setSuccess(null);
    try {
      const { signingKey } = await client.rotateSecret(id);
      setRevealedKey(signingKey);
      setSuccess("Signing key rotated. Copy it before dismissing.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rotate signing key.");
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  }

  async function onDelete(id: string) {
    if (!canManage) return;
    await runAction(id, () => client.delete(id));
    setConfirm(null);
  }

  if (loading) return null;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
        Webhooks
      </h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{intro}</p>
      {!canManage && (
        <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
          Only workspace owners and admins can add or change webhooks.
        </p>
      )}

      {error && <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="mt-2 text-[12px] text-green-700 dark:text-green-400">{success}</p>}

      {revealedKey && (
        <div className="mt-3 space-y-2 rounded border border-green-600/30 bg-green-50 p-3 dark:border-green-500/30 dark:bg-green-950/40">
          <p className="text-[12px] font-medium text-green-800 dark:text-green-300">
            Signing key — copy now, it won&apos;t be shown again.
          </p>
          <code className="block overflow-x-auto whitespace-nowrap rounded border border-green-600/30 bg-white px-2 py-1.5 font-mono text-[11px] text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            {revealedKey}
          </code>
          <div className="flex gap-2">
            <button type="button" onClick={() => copy(revealedKey)} className={smallButtonClass}>
              {copied ? "Copied" : "Copy key"}
            </button>
            <button type="button" onClick={() => setRevealedKey(null)} className={smallButtonClass}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {subs.length > 0 ? (
        <ul className="mt-4 divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {subs.map((sub) => {
            const busy = busyId === sub.id;
            return (
              <li key={sub.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                      {subscriptionLabel(sub)}
                      {!sub.enabled && (
                        <span className="ml-2 text-[11px] font-normal uppercase tracking-wide text-stone-400">
                          Paused
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-[11px] text-stone-400 dark:text-stone-500">
                      {scopeDetail(sub)}
                    </p>
                    <p className="mt-1 truncate font-mono text-[11px] text-stone-500 dark:text-stone-400">
                      {sub.url}
                    </p>
                    <p className={`mt-1 text-[11px] ${healthTone(sub.deliveryHealth)}`}>
                      {sub.deliveryHealthSummary}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[12px]">
                  <button
                    type="button"
                    disabled={busy || !sub.enabled}
                    onClick={() =>
                      void runAction(sub.id, async () => {
                        await client.test(sub.id);
                      })
                    }
                    className={smallButtonClass}
                  >
                    {busy ? "…" : "Send test"}
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction(sub.id, async () => {
                          await client.update(sub.id, { enabled: !sub.enabled });
                        })
                      }
                      className={smallButtonClass}
                    >
                      {sub.enabled ? "Pause" : "Resume"}
                    </button>
                  )}
                  <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                    <WebhookFormatIcon format={sub.format} className="size-3.5 shrink-0" />
                    {webhookFormatLabel(sub.format)}
                  </span>
                  {canManage && !isUnsignedWebhookFormat(sub.format) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: "rotate", id: sub.id })}
                      className={smallButtonClass}
                    >
                      Rotate key
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setActivityId((cur) => (cur === sub.id ? null : sub.id))}
                    className={smallButtonClass}
                  >
                    {activityId === sub.id ? "Hide activity" : "Activity"}
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: "delete", id: sub.id })}
                      className="text-red-500 hover:text-red-700 hover:underline underline-offset-2 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
                    >
                      Delete
                    </button>
                  )}
                </div>
                {activityId === sub.id && (
                  <div className="rounded border border-stone-100 bg-stone-50/80 p-2 dark:border-stone-800 dark:bg-stone-950/50">
                    <p className="mb-2 text-[11px] font-medium text-stone-500 dark:text-stone-400">
                      Recent deliveries
                    </p>
                    <WebhookDeliveriesLog
                      subscriptionId={sub.id}
                      listDeliveries={client.listDeliveries}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-stone-500 dark:text-stone-400">No webhooks yet.</p>
      )}

      {canManage && (
        <form
          id="add-webhook"
          onSubmit={onCreate}
          className="mt-4 space-y-3 border-t border-stone-200 pt-4 dark:border-stone-800"
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Add webhook
          </p>

          {allowFollows && (
            <div
              className="inline-flex overflow-hidden rounded border border-stone-200 dark:border-stone-700"
              role="group"
              aria-label="Webhook scope"
            >
              {(
                [
                  { value: "follows" as const, label: "Follows" },
                  { value: "org" as const, label: "Org" },
                ] as const
              ).map((o) => {
                const disabled = o.value === "follows" ? !canCreateFollows : !canCreateOrg;
                return (
                  <button
                    key={o.value}
                    type="button"
                    disabled={disabled}
                    aria-pressed={scope === o.value}
                    onClick={() => setScope(o.value)}
                    className={`px-3 py-1.5 text-[13px] disabled:opacity-40 ${
                      scope === o.value
                        ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
                        : "bg-white text-stone-700 hover:bg-stone-50 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}

          {scope === "org" && (
            <>
              <div>
                <label
                  htmlFor="webhook-org"
                  className="text-[12px] text-stone-600 dark:text-stone-300"
                >
                  Org slug
                </label>
                <input
                  id="webhook-org"
                  value={orgSlug}
                  onChange={(e) => setOrgSlug(e.target.value)}
                  placeholder="vercel"
                  className={`${inputClass} mt-1`}
                  required
                />
                <p className="mt-1 text-[11px] text-stone-400">
                  {orgCount}/{MAX_ORG_WEBHOOKS} org webhooks used
                </p>
              </div>
              <div>
                <label
                  htmlFor="webhook-product"
                  className="text-[12px] text-stone-600 dark:text-stone-300"
                >
                  Product slug (optional)
                </label>
                <input
                  id="webhook-product"
                  value={productSlug}
                  onChange={(e) => setProductSlug(e.target.value)}
                  placeholder="next-js"
                  className={`${inputClass} mt-1`}
                />
              </div>
              <div>
                <label
                  htmlFor="webhook-source"
                  className="text-[12px] text-stone-600 dark:text-stone-300"
                >
                  Source slug (optional)
                </label>
                <input
                  id="webhook-source"
                  value={sourceSlug}
                  onChange={(e) => setSourceSlug(e.target.value)}
                  placeholder="changelog"
                  className={`${inputClass} mt-1`}
                />
              </div>
            </>
          )}

          <div>
            <label
              htmlFor="webhook-release-type"
              className="text-[12px] text-stone-600 dark:text-stone-300"
            >
              Release type (optional)
            </label>
            <Select
              value={releaseType === "" ? "any" : releaseType}
              onValueChange={(v) => {
                if (v === "any" || v === "feature" || v === "rollup") {
                  setReleaseType(v === "any" ? "" : v);
                }
              }}
              items={[
                { value: "any", label: "Any" },
                { value: "feature", label: "Feature" },
                { value: "rollup", label: "Rollup" },
              ]}
            >
              <SelectTrigger id="webhook-release-type" className="mt-1 h-10 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                <SelectItem value="feature">Feature</SelectItem>
                <SelectItem value="rollup">Rollup</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label
              htmlFor="webhook-format"
              className="text-[12px] text-stone-600 dark:text-stone-300"
            >
              Format
            </label>
            <Select
              value={format}
              onValueChange={(v) => {
                if (v === "json" || v === "slack" || v === "discord") setFormat(v);
              }}
              items={[
                { value: "json", label: webhookFormatPickerLabel("json") },
                { value: "slack", label: webhookFormatPickerLabel("slack") },
                { value: "discord", label: webhookFormatPickerLabel("discord") },
              ]}
            >
              <SelectTrigger id="webhook-format" className="mt-1 h-10 w-full">
                <WebhookFormatIcon format={format} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="json">
                  <WebhookFormatIcon format="json" />
                  {webhookFormatPickerLabel("json")}
                </SelectItem>
                <SelectItem value="slack">
                  <WebhookFormatIcon format="slack" />
                  {webhookFormatPickerLabel("slack")}
                </SelectItem>
                <SelectItem value="discord">
                  <WebhookFormatIcon format="discord" />
                  {webhookFormatPickerLabel("discord")}
                </SelectItem>
              </SelectContent>
            </Select>
            {format === "slack" && (
              <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
                Posts a formatted message to a Slack incoming webhook URL (hooks.slack.com). No
                signature is sent.{" "}
                <Link href="/docs/integrations/slack" className="underline underline-offset-2">
                  Setup guide
                </Link>
              </p>
            )}
            {format === "discord" && (
              <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
                Posts a formatted embed to a Discord incoming webhook URL
                (discord.com/api/webhooks). No signature is sent.{" "}
                <Link href="/docs/integrations/discord" className="underline underline-offset-2">
                  Setup guide
                </Link>
              </p>
            )}
          </div>

          {scope === "follows" && hasFollows && (
            <p className="text-[11px] text-stone-400">You already have a follows webhook.</p>
          )}

          <div>
            <label htmlFor="webhook-url" className="text-[12px] text-stone-600 dark:text-stone-300">
              HTTPS endpoint
            </label>
            <input
              id="webhook-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                format === "slack"
                  ? "https://hooks.slack.com/services/…"
                  : format === "discord"
                    ? "https://discord.com/api/webhooks/…"
                    : "https://your.app/releases"
              }
              className={`${inputClass} mt-1`}
              required
            />
          </div>

          <div>
            <label
              htmlFor="webhook-description"
              className="text-[12px] text-stone-600 dark:text-stone-300"
            >
              Label (optional)
            </label>
            <input
              id="webhook-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Production hook"
              className={`${inputClass} mt-1`}
            />
          </div>

          <button
            type="submit"
            disabled={
              creating ||
              !url.trim() ||
              (scope === "org" && (!orgSlug.trim() || !canCreateOrg)) ||
              (scope === "follows" && !canCreateFollows)
            }
            className={smallButtonClass}
          >
            {creating ? "Creating…" : "Create webhook"}
          </button>
        </form>
      )}

      <ConfirmDialog
        open={confirm != null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.kind === "rotate" ? "Rotate signing key" : "Delete webhook"}
        description={
          confirm?.kind === "rotate"
            ? "Update your verifier — old signatures will fail."
            : "This cannot be undone. Delivery history for this endpoint will be removed."
        }
        confirmLabel={confirm?.kind === "rotate" ? "Rotate" : "Delete"}
        pending={busyId === confirm?.id}
        onConfirm={() => {
          if (confirm?.kind === "rotate") void onRotate(confirm.id);
          else if (confirm?.kind === "delete") void onDelete(confirm.id);
        }}
      />
    </div>
  );
}
