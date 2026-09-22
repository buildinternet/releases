"use client";

import { useEffect, useState } from "react";
import {
  ErrorText,
  Toggle,
  dangerLinkClass,
  listCardClass,
  listRowClass,
  smallButtonClass,
  textareaClass,
} from "@releases/design-system";
import {
  SEMANTIC_ALERT_MAX_PER_USER,
  SEMANTIC_ALERT_QUERY_MAX_CHARS,
  SEMANTIC_ALERT_THRESHOLD_DEFAULT,
  SEMANTIC_ALERT_THRESHOLD_MAX,
  SEMANTIC_ALERT_THRESHOLD_MIN,
  createSemanticAlert,
  deleteSemanticAlert,
  updateSemanticAlert,
  type SemanticAlert,
  type SemanticAlertWebhookOption,
} from "@/lib/semantic-alerts";

function webhookLabel(hook: SemanticAlertWebhookOption): string {
  if (hook.description?.trim()) return hook.description.trim();
  if (hook.scope === "follows") return "Follows webhook";
  return hook.orgName ?? hook.orgSlug ?? "Webhook";
}

/**
 * Account Notifications section for semantic alerts. Render only when the
 * settings bootstrap includes an array (`null` means the flag is off).
 * Matching and delivery are not live — this saves the preference.
 */
export function SemanticAlertsSection({
  alerts: initialAlerts,
  webhooks,
}: {
  alerts: SemanticAlert[];
  webhooks: SemanticAlertWebhookOption[];
}) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [query, setQuery] = useState("");
  const [threshold, setThreshold] = useState(String(SEMANTIC_ALERT_THRESHOLD_DEFAULT));
  const [deliverEmail, setDeliverEmail] = useState(true);
  const [deliverWebhook, setDeliverWebhook] = useState(false);
  const [webhookSubscriptionId, setWebhookSubscriptionId] = useState(webhooks[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAlerts(initialAlerts);
  }, [initialAlerts]);

  const atCap = alerts.length >= SEMANTIC_ALERT_MAX_PER_USER;

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
      setAlerts((prev) => [created, ...prev]);
      setQuery("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save interest alert.");
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(alert: SemanticAlert, enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const prev = alerts;
    setAlerts((rows) => rows.map((row) => (row.id === alert.id ? { ...row, enabled } : row)));
    try {
      const updated = await updateSemanticAlert(alert.id, { enabled });
      setAlerts((rows) => rows.map((row) => (row.id === alert.id ? updated : row)));
    } catch (e: unknown) {
      setAlerts(prev);
      setError(e instanceof Error ? e.message : "Failed to update interest alert.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(alert: SemanticAlert) {
    if (busy) return;
    if (!window.confirm("Delete this interest alert?")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSemanticAlert(alert.id);
      setAlerts((rows) => rows.filter((row) => row.id !== alert.id));
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
        Describe what you care about in plain language. Saved alerts are matched later against
        releases from organizations and products you follow. Matching and delivery are not live yet.
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
          {alerts.map((alert) => (
            <div key={alert.id} className={listRowClass}>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                  {alert.query}
                </div>
                <div className="mt-0.5 text-[12.5px] text-stone-400 dark:text-stone-500">
                  Threshold {alert.threshold.toFixed(2)}
                  {alert.deliverEmail ? " · Email" : ""}
                  {alert.deliverWebhook ? " · Webhook" : ""}
                  {alert.enabled ? "" : " · Off"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
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
          ))}
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
