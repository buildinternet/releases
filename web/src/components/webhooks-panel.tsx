"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { UserWebhookListItem, UserWebhookScope } from "@buildinternet/releases-api-types";
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

const MAX_ORG_WEBHOOKS = 10;

const inputClass =
  "mt-1 w-full rounded border border-stone-200 bg-white px-2 py-1.5 text-[13px] text-stone-900 outline-none focus:border-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100";
const buttonClass =
  "rounded border border-stone-200 px-3 py-1.5 text-[13px] text-stone-700 transition hover:border-stone-300 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-600 dark:hover:text-stone-100";

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

function WebhookDeliveriesLog({ subscriptionId }: { subscriptionId: string }) {
  const [rows, setRows] = useState<WebhookDeliveryRow[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setRows(undefined);
      setError(null);
      try {
        const data = await listWebhookDeliveries(subscriptionId, { limit: 15 });
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load activity.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriptionId]);

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

export function WebhooksPanel() {
  const [subs, setSubs] = useState<UserWebhookListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [scope, setScope] = useState<UserWebhookScope>("follows");
  const [url, setUrl] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [productSlug, setProductSlug] = useState("");
  const [sourceSlug, setSourceSlug] = useState("");
  const [releaseType, setReleaseType] = useState<"" | "feature" | "rollup">("");
  const [format, setFormat] = useState<UserWebhookFormat>("json");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [activityId, setActivityId] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();

  const orgCount = subs.filter((s) => s.scope === "org").length;
  const hasFollows = subs.some((s) => s.scope === "follows");
  const canCreateFollows = !hasFollows;
  const canCreateOrg = orgCount < MAX_ORG_WEBHOOKS;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSubs(await listWebhooks());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load webhooks.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (creating || !url.trim()) return;
    if (scope === "follows" && !canCreateFollows) return;
    if (scope === "org" && (!orgSlug.trim() || !canCreateOrg)) return;

    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createWebhook({
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
    if (
      !window.confirm("Rotate the signing key? Update your verifier — old signatures will fail.")
    ) {
      return;
    }
    setBusyId(id);
    setError(null);
    setSuccess(null);
    try {
      const { signingKey } = await rotateWebhookSecret(id);
      setRevealedKey(signingKey);
      setSuccess("Signing key rotated. Copy it before dismissing.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rotate signing key.");
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Delete this webhook? This cannot be undone.")) return;
    await runAction(id, () => deleteWebhook(id));
  }

  if (loading) return null;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
        Webhooks
      </h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Receive signed <code className="font-mono text-[0.9em]">release.created</code> POSTs in real
        time — for everything you follow or a single org.{" "}
        <Link href="/docs/api/webhooks" className="underline underline-offset-2">
          Docs
        </Link>
      </p>

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
            <button type="button" onClick={() => copy(revealedKey)} className={buttonClass}>
              {copied ? "Copied" : "Copy key"}
            </button>
            <button type="button" onClick={() => setRevealedKey(null)} className={buttonClass}>
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
                        await testWebhook(sub.id);
                      })
                    }
                    className={buttonClass}
                  >
                    {busy ? "…" : "Send test"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction(sub.id, async () => {
                        await updateWebhook(sub.id, { enabled: !sub.enabled });
                      })
                    }
                    className={buttonClass}
                  >
                    {sub.enabled ? "Pause" : "Resume"}
                  </button>
                  {sub.format !== "slack" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onRotate(sub.id)}
                      className={buttonClass}
                    >
                      Rotate key
                    </button>
                  )}
                  {sub.format === "slack" && (
                    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                      Slack
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setActivityId((cur) => (cur === sub.id ? null : sub.id))}
                    className={buttonClass}
                  >
                    {activityId === sub.id ? "Hide activity" : "Activity"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onDelete(sub.id)}
                    className="text-red-500 hover:text-red-700 hover:underline underline-offset-2 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
                  >
                    Delete
                  </button>
                </div>
                {activityId === sub.id && (
                  <div className="rounded border border-stone-100 bg-stone-50/80 p-2 dark:border-stone-800 dark:bg-stone-950/50">
                    <p className="mb-2 text-[11px] font-medium text-stone-500 dark:text-stone-400">
                      Recent deliveries
                    </p>
                    <WebhookDeliveriesLog subscriptionId={sub.id} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-stone-500 dark:text-stone-400">No webhooks yet.</p>
      )}

      <form
        onSubmit={onCreate}
        className="mt-4 space-y-3 border-t border-stone-200 pt-4 dark:border-stone-800"
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
          Add webhook
        </p>

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
                className={inputClass}
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
                className={inputClass}
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
                className={inputClass}
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
          <select
            id="webhook-release-type"
            value={releaseType}
            onChange={(e) => setReleaseType(e.target.value as "" | "feature" | "rollup")}
            className={inputClass}
          >
            <option value="">Any</option>
            <option value="feature">Feature</option>
            <option value="rollup">Rollup</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="webhook-format"
            className="text-[12px] text-stone-600 dark:text-stone-300"
          >
            Format
          </label>
          <select
            id="webhook-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as UserWebhookFormat)}
            className={inputClass}
          >
            <option value="json">JSON (signed payload)</option>
            <option value="slack">Slack message</option>
          </select>
          {format === "slack" && (
            <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
              Posts a formatted message to a Slack incoming webhook URL (hooks.slack.com). No
              signature is sent.
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
            placeholder="https://your.app/releases"
            className={inputClass}
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
            className={inputClass}
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
          className={buttonClass}
        >
          {creating ? "Creating…" : "Create webhook"}
        </button>
      </form>
    </div>
  );
}
