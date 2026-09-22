"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ErrorText,
  Toggle,
  dangerLinkClass,
  listCardClass,
  listRowClass,
  smallButtonClass,
  textareaClass,
} from "@releases/design-system";
import { formatDate, formatRelativeDate } from "@/lib/formatters";
import {
  SEMANTIC_ALERT_MAX_PER_USER,
  SEMANTIC_ALERT_QUERY_MAX_CHARS,
  SEMANTIC_ALERT_THRESHOLD_DEFAULT,
  SEMANTIC_ALERT_THRESHOLD_MAX,
  SEMANTIC_ALERT_THRESHOLD_MIN,
  createSemanticAlert,
  deleteSemanticAlert,
  emptySemanticAlertActivity,
  updateSemanticAlert,
  type SemanticAlert,
  type SemanticAlertActivity,
  type SemanticAlertListItem,
  type SemanticAlertWebhookOption,
} from "@/lib/semantic-alerts";

const quietLinkClass =
  "rounded-md px-1.5 py-1 text-[13px] text-stone-500 transition hover:text-stone-900 disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-100";

function webhookLabel(hook: SemanticAlertWebhookOption): string {
  if (hook.description?.trim()) return hook.description.trim();
  if (hook.scope === "follows") return "Follows webhook";
  return hook.orgName ?? hook.orgSlug ?? "Webhook";
}

interface AlertDraft {
  id: string;
  query: string;
  threshold: string;
  deliverEmail: boolean;
  deliverWebhook: boolean;
  webhookSubscriptionId: string;
}

function applyUpdate(row: SemanticAlertListItem, updated: SemanticAlert): SemanticAlertListItem {
  return { ...row, ...updated, activity: row.activity };
}

function windowCount(n: number, days: number): string {
  const noun = n === 1 ? "match" : "matches";
  return `${n} ${noun} in ${days} days`;
}

function ActivityLine({ activity }: { activity: SemanticAlertActivity }) {
  const counts = `${windowCount(activity.matches7d, 7)} · ${windowCount(activity.matches30d, 30)}`;
  if (!activity.lastMatchedAt) {
    return (
      <p className="mt-1 text-[12.5px] text-stone-400 dark:text-stone-500">
        No matches yet · {counts}
      </p>
    );
  }
  return (
    <p className="mt-1 text-[12.5px] text-stone-400 dark:text-stone-500">
      Last matched{" "}
      {activity.lastMatch ? (
        <Link
          href={activity.lastMatch.path}
          className="text-stone-600 underline decoration-stone-300 underline-offset-2 hover:text-stone-900 dark:text-stone-300 dark:decoration-stone-600 dark:hover:text-stone-100"
        >
          {activity.lastMatch.title}
        </Link>
      ) : null}
      {activity.lastMatch ? " " : null}
      <time dateTime={activity.lastMatchedAt} title={formatDate(activity.lastMatchedAt)}>
        {formatRelativeDate(activity.lastMatchedAt)}
      </time>
      {" · "}
      {counts}
    </p>
  );
}

/**
 * Account Notifications section for interest alerts. Render only when the
 * settings bootstrap includes an array (`null` means the flag is off).
 * Each row can be edited and shows recent claimed-match activity.
 */
export function SemanticAlertsSection({
  alerts: initialAlerts,
  webhooks,
}: {
  alerts: SemanticAlertListItem[];
  webhooks: SemanticAlertWebhookOption[];
}) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [query, setQuery] = useState("");
  const [threshold, setThreshold] = useState(String(SEMANTIC_ALERT_THRESHOLD_DEFAULT));
  const [deliverEmail, setDeliverEmail] = useState(true);
  const [deliverWebhook, setDeliverWebhook] = useState(false);
  const [webhookSubscriptionId, setWebhookSubscriptionId] = useState(webhooks[0]?.id ?? "");
  const [draft, setDraft] = useState<AlertDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAlerts(initialAlerts);
  }, [initialAlerts]);

  const atCap = alerts.length >= SEMANTIC_ALERT_MAX_PER_USER;

  function startEdit(alert: SemanticAlertListItem) {
    const known = webhooks.some((hook) => hook.id === alert.webhookSubscriptionId);
    setDraft({
      id: alert.id,
      query: alert.query,
      threshold: alert.threshold.toFixed(2),
      deliverEmail: alert.deliverEmail,
      deliverWebhook: alert.deliverWebhook,
      webhookSubscriptionId:
        known && alert.webhookSubscriptionId
          ? alert.webhookSubscriptionId
          : (webhooks[0]?.id ?? ""),
    });
    setError(null);
  }

  async function onCreate() {
    const trimmed = query.trim();
    if (!trimmed || busy || atCap) return;
    const parsedThreshold = Number(threshold);
    if (!Number.isFinite(parsedThreshold)) {
      setError("Enter a threshold between 0.50 and 1.00.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createSemanticAlert({
        query: trimmed,
        threshold: parsedThreshold,
        deliverEmail,
        deliverWebhook,
        webhookSubscriptionId:
          deliverWebhook && webhookSubscriptionId ? webhookSubscriptionId : null,
      });
      setAlerts((prev) => [{ ...created, activity: emptySemanticAlertActivity() }, ...prev]);
      setQuery("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save interest alert.");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveEdit(alert: SemanticAlertListItem) {
    if (!draft || draft.id !== alert.id || busy) return;
    const trimmed = draft.query.trim();
    if (!trimmed) {
      setError("Enter what you want to hear about.");
      return;
    }
    const parsedThreshold = Number(draft.threshold);
    if (
      !Number.isFinite(parsedThreshold) ||
      parsedThreshold < SEMANTIC_ALERT_THRESHOLD_MIN ||
      parsedThreshold > SEMANTIC_ALERT_THRESHOLD_MAX
    ) {
      setError("Enter a threshold between 0.50 and 1.00.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateSemanticAlert(alert.id, {
        query: trimmed,
        threshold: parsedThreshold,
        deliverEmail: draft.deliverEmail,
        deliverWebhook: draft.deliverWebhook,
        webhookSubscriptionId:
          draft.deliverWebhook && draft.webhookSubscriptionId ? draft.webhookSubscriptionId : null,
      });
      setAlerts((rows) =>
        rows.map((row) => (row.id === alert.id ? applyUpdate(row, updated) : row)),
      );
      setDraft(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update interest alert.");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(alert: SemanticAlertListItem, enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const prev = alerts;
    setAlerts((rows) => rows.map((row) => (row.id === alert.id ? { ...row, enabled } : row)));
    try {
      const updated = await updateSemanticAlert(alert.id, { enabled });
      setAlerts((rows) =>
        rows.map((row) => (row.id === alert.id ? applyUpdate(row, updated) : row)),
      );
    } catch (e: unknown) {
      setAlerts(prev);
      setError(e instanceof Error ? e.message : "Failed to update interest alert.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(alert: SemanticAlertListItem) {
    if (busy) return;
    if (!window.confirm("Delete this interest alert?")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSemanticAlert(alert.id);
      setAlerts((rows) => rows.filter((row) => row.id !== alert.id));
      setDraft((current) => (current?.id === alert.id ? null : current));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete interest alert.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Interest alerts
      </div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        Describe what you care about in plain language. When a release from an organization or
        product you follow matches, we send an email or a webhook.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      {alerts.length === 0 ? (
        <p className="mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
          No interest alerts yet.
        </p>
      ) : (
        <div className={`${listCardClass} mb-3.5`}>
          {alerts.map((alert) => {
            const editing = draft?.id === alert.id;
            return (
              <div key={alert.id} className={listRowClass}>
                <div className="min-w-0 flex-1">
                  {editing && draft ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={draft.query}
                        onChange={(e) =>
                          setDraft((current) =>
                            current ? { ...current, query: e.target.value } : current,
                          )
                        }
                        maxLength={SEMANTIC_ALERT_QUERY_MAX_CHARS}
                        rows={3}
                        disabled={busy}
                        aria-label="Edit interest"
                        className={textareaClass}
                      />
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-stone-600 dark:text-stone-300">
                        <label className="inline-flex items-center gap-2">
                          Threshold
                          <input
                            type="number"
                            min={SEMANTIC_ALERT_THRESHOLD_MIN}
                            max={SEMANTIC_ALERT_THRESHOLD_MAX}
                            step={0.01}
                            value={draft.threshold}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft((current) =>
                                current ? { ...current, threshold: e.target.value } : current,
                              )
                            }
                            className="h-9 w-20 rounded-lg border border-stone-200 bg-white px-2 text-[13px] dark:border-stone-700 dark:bg-stone-900"
                            aria-label="Edit match threshold"
                          />
                        </label>
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={draft.deliverEmail}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft((current) =>
                                current ? { ...current, deliverEmail: e.target.checked } : current,
                              )
                            }
                          />
                          Email
                        </label>
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={draft.deliverWebhook}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft((current) =>
                                current
                                  ? { ...current, deliverWebhook: e.target.checked }
                                  : current,
                              )
                            }
                          />
                          Webhook
                        </label>
                        {draft.deliverWebhook && webhooks.length > 0 && (
                          <select
                            value={draft.webhookSubscriptionId}
                            disabled={busy}
                            onChange={(e) =>
                              setDraft((current) =>
                                current
                                  ? { ...current, webhookSubscriptionId: e.target.value }
                                  : current,
                              )
                            }
                            aria-label="Edit webhook subscription"
                            className="h-9 max-w-full rounded-lg border border-stone-200 bg-white px-2 text-[13px] dark:border-stone-700 dark:bg-stone-900"
                          >
                            {webhooks.map((hook) => (
                              <option key={hook.id} value={hook.id}>
                                {webhookLabel(hook)}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void onSaveEdit(alert)}
                          disabled={busy || draft.query.trim().length === 0}
                          className={smallButtonClass}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraft(null)}
                          disabled={busy}
                          className={quietLinkClass}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                        {alert.query}
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-stone-400 dark:text-stone-500">
                        Threshold {alert.threshold.toFixed(2)}
                        {alert.deliverEmail ? " · Email" : ""}
                        {alert.deliverWebhook ? " · Webhook" : ""}
                        {alert.enabled ? "" : " · Off"}
                      </div>
                    </>
                  )}
                  <ActivityLine activity={alert.activity} />
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {editing ? null : (
                    <button
                      type="button"
                      onClick={() => startEdit(alert)}
                      disabled={busy}
                      className={quietLinkClass}
                    >
                      Edit
                    </button>
                  )}
                  <Toggle
                    label={alert.enabled ? "Disable interest alert" : "Enable interest alert"}
                    checked={alert.enabled}
                    disabled={busy}
                    onChange={(next) => void onToggle(alert, next)}
                  />
                  <button
                    type="button"
                    onClick={() => void onDelete(alert)}
                    disabled={busy}
                    className={dangerLinkClass}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <label className="mb-1.5 block text-[13px] font-medium text-stone-900 dark:text-stone-100">
        New alert
      </label>
      <textarea
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        maxLength={SEMANTIC_ALERT_QUERY_MAX_CHARS}
        rows={3}
        disabled={busy || atCap}
        placeholder="Slack integrations with B2B software"
        className={textareaClass}
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-stone-600 dark:text-stone-300">
        <label className="inline-flex items-center gap-2">
          Threshold
          <input
            type="number"
            min={SEMANTIC_ALERT_THRESHOLD_MIN}
            max={SEMANTIC_ALERT_THRESHOLD_MAX}
            step={0.01}
            value={threshold}
            disabled={busy || atCap}
            onChange={(e) => setThreshold(e.target.value)}
            className="h-9 w-20 rounded-lg border border-stone-200 bg-white px-2 text-[13px] dark:border-stone-700 dark:bg-stone-900"
            aria-label="Match threshold"
          />
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={deliverEmail}
            disabled={busy || atCap}
            onChange={(e) => setDeliverEmail(e.target.checked)}
          />
          Email
        </label>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={deliverWebhook}
            disabled={busy || atCap}
            onChange={(e) => setDeliverWebhook(e.target.checked)}
          />
          Webhook
        </label>
        {deliverWebhook && webhooks.length > 0 && (
          <select
            value={webhookSubscriptionId}
            disabled={busy || atCap}
            onChange={(e) => setWebhookSubscriptionId(e.target.value)}
            aria-label="Webhook subscription"
            className="h-9 max-w-full rounded-lg border border-stone-200 bg-white px-2 text-[13px] dark:border-stone-700 dark:bg-stone-900"
          >
            {webhooks.map((hook) => (
              <option key={hook.id} value={hook.id}>
                {webhookLabel(hook)}
              </option>
            ))}
          </select>
        )}
      </div>
      {deliverWebhook && webhooks.length === 0 && (
        <p className="mt-2 text-[12.5px] text-stone-400 dark:text-stone-500">
          No webhook is saved on this account yet. The preference is stored; attach a subscription
          later from Webhooks &amp; API.
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={busy || atCap || query.trim().length === 0}
          className={smallButtonClass}
        >
          {busy ? "Saving…" : "Save alert"}
        </button>
        <span className="text-[12.5px] text-stone-400 dark:text-stone-500">
          {alerts.length} of {SEMANTIC_ALERT_MAX_PER_USER}
          {atCap ? " — limit reached" : ""}
        </span>
      </div>
    </section>
  );
}
