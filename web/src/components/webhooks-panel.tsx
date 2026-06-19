"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { UserWebhookListItem, UserWebhookScope } from "@buildinternet/releases-api-types";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
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
  if (sub.scope === "follows") return "Follows · real-time";
  const parts = [sub.orgSlug ?? sub.orgName ?? "org"];
  if (sub.sourceSlug) parts.push(sub.sourceSlug);
  return parts.filter(Boolean).join(" / ");
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
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
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
        ...(scope === "org" ? { orgSlug: orgSlug.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setRevealedKey(created.signingKey);
      setUrl("");
      setOrgSlug("");
      setDescription("");
      setSuccess("Webhook created. Copy the signing key before dismissing.");
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onRotate(sub.id)}
                    className={buttonClass}
                  >
                    Rotate key
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
          <div>
            <label htmlFor="webhook-org" className="text-[12px] text-stone-600 dark:text-stone-300">
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
        )}

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
