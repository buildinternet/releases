"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type {
  DigestCadence,
  FeedToken,
  NotificationSettingsResponse,
  UserWebhookListItem,
} from "@buildinternet/releases-api-types";
import { getNotificationSettings } from "@/lib/me-settings";
import { setDigestCadence, mintFeedToken, revokeFeedToken } from "@/lib/follows";
import { listWebhooks, createWebhook, testWebhook, deleteWebhook } from "@/lib/webhooks";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { useSettingsBootstrap } from "@/components/account/use-settings-bootstrap";
import {
  PanelGrid,
  Toggle,
  ErrorText,
  listCardClass,
  listRowClass,
  secondaryButtonClass,
  smallButtonClass,
  dangerLinkClass,
} from "@releases/design-system";

function EmailSection({ cadence: initialCadence }: { cadence: DigestCadence }) {
  const [cadence, setCadence] = useState<DigestCadence>(initialCadence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stay in sync if the parent re-bootstraps (e.g. after a full refresh).
  useEffect(() => {
    setCadence(initialCadence);
  }, [initialCadence]);

  async function apply(next: DigestCadence) {
    if (next === cadence || busy) return;
    const prev = cadence;
    setBusy(true);
    setError(null);
    setCadence(next); // optimistic
    try {
      setCadence(await setDigestCadence(next));
    } catch (e: unknown) {
      setCadence(prev);
      setError(e instanceof Error ? e.message : "Failed to update settings.");
    } finally {
      setBusy(false);
    }
  }

  const digestOn = cadence !== "off";

  return (
    <section>
      <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">Email</div>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className={listCardClass}>
        <div className={listRowClass}>
          <div className="flex-1">
            <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
              Release digest
            </div>
            <div className="mt-0.5 text-[12.5px] text-stone-400 dark:text-stone-500">
              A summary of new releases from the sources you follow.
            </div>
            {digestOn && (
              <div
                className="mt-2.5 inline-flex overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700"
                role="group"
                aria-label="Digest frequency"
              >
                {(["daily", "weekly"] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    disabled={busy}
                    aria-pressed={cadence === c}
                    onClick={() => void apply(c)}
                    className={`px-3 py-1 text-[12.5px] capitalize disabled:opacity-50 ${
                      cadence === c
                        ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
                        : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Toggle
            label="Release digest"
            checked={digestOn}
            disabled={busy}
            onChange={(on) => void apply(on ? "weekly" : "off")}
          />
        </div>
      </div>
    </section>
  );
}

function FeedTokenSection({ token: initialToken }: { token: FeedToken | null }) {
  const [token, setToken] = useState<FeedToken | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    setToken(initialToken);
  }, [initialToken]);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      setToken(await mintFeedToken());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to generate feed URL.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke your feed URL? Existing reader subscriptions will stop working."))
      return;
    setBusy(true);
    setError(null);
    try {
      await revokeFeedToken();
      setToken(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to revoke feed URL.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Personal feed token
      </div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        A private RSS/Atom feed of everything you follow. Keep the URL secret.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {token ? (
        <>
          <div className="flex items-center gap-2.5">
            <code className="flex h-10 min-w-0 flex-1 items-center overflow-hidden rounded-[9px] border border-stone-200 bg-stone-50 px-3 font-mono text-[12.5px] text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
              <span className="truncate">{token.feedUrl}</span>
            </code>
            <button
              type="button"
              onClick={() => copy(token.feedUrl)}
              className={`${secondaryButtonClass} h-10 shrink-0`}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="mt-2.5 flex gap-3 text-[13px]">
            <button
              type="button"
              onClick={() => void mint()}
              disabled={busy}
              className="text-stone-500 hover:text-stone-900 disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-100"
            >
              Regenerate
            </button>
            <button
              type="button"
              onClick={() => void revoke()}
              disabled={busy}
              className={dangerLinkClass}
            >
              Revoke
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void mint()}
          disabled={busy}
          className={smallButtonClass}
        >
          {busy ? "Generating…" : "Generate a private feed URL"}
        </button>
      )}
    </section>
  );
}

const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

function isSlackWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && SLACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function slackRowLabel(hook: UserWebhookListItem): string {
  return hook.description?.trim() || "Slack channel";
}

function SlackSection({ webhooks: initialWebhooks }: { webhooks: UserWebhookListItem[] }) {
  const [hooks, setHooks] = useState<UserWebhookListItem[]>(initialWebhooks);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setHooks(initialWebhooks);
  }, [initialWebhooks]);

  async function refresh() {
    setHooks(await listWebhooks());
  }

  const slackHook = hooks.find((h) => h.format === "slack" && h.scope === "follows") ?? null;
  const followsTakenByOther = !slackHook && hooks.some((h) => h.scope === "follows");

  async function onCreate() {
    if (busy) return;
    if (!isSlackWebhookUrl(url)) {
      setError("Enter a Slack incoming webhook URL (hooks.slack.com).");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await createWebhook({ url: url.trim(), scope: "follows", format: "slack" });
      setUrl("");
      setSuccess("Slack connected.");
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to connect Slack.");
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    if (!slackHook || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await testWebhook(slackHook.id);
      setSuccess("Sent a test message to Slack.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send test message.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (!slackHook || busy) return;
    if (!window.confirm("Remove this Slack connection? Releases will stop posting to it.")) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await deleteWebhook(slackHook.id);
      setSuccess(null);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to remove Slack connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">Slack</div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        Post a message to a Slack channel whenever something you follow ships.{" "}
        <Link
          href="/docs/integrations/slack"
          className="underline underline-offset-2 hover:text-stone-900 dark:hover:text-stone-100"
        >
          How to get a Slack webhook URL
        </Link>
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {success && <p className="mb-3 text-[12.5px] text-[var(--accent)]">{success}</p>}

      {slackHook ? (
        <div className={listCardClass}>
          <div className={listRowClass}>
            <div className="flex-1">
              <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                {slackRowLabel(slackHook)}
              </div>
              <div className="mt-0.5 text-[12.5px] text-stone-400 dark:text-stone-500">
                {slackHook.enabled ? (
                  "Connected — receiving everything you follow."
                ) : (
                  <>
                    Paused after delivery failures — remove and reconnect, or manage it in{" "}
                    <Link
                      href="/account/webhooks"
                      className="underline underline-offset-2 hover:text-stone-900 dark:hover:text-stone-100"
                    >
                      Webhooks &amp; API
                    </Link>
                    .
                  </>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-3 text-[13px]">
              <button
                type="button"
                onClick={() => void onTest()}
                disabled={busy}
                className="text-stone-500 hover:text-stone-900 disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-100"
              >
                Test
              </button>
              <button
                type="button"
                onClick={() => void onRemove()}
                disabled={busy}
                className={dangerLinkClass}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : followsTakenByOther ? (
        <p className="text-[13px] text-stone-500 dark:text-stone-400">
          You already have a follows webhook. Manage it — or switch it to Slack — in{" "}
          <Link
            href="/account/webhooks"
            className="underline underline-offset-2 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Webhooks &amp; API
          </Link>
          .
        </p>
      ) : (
        <div className="flex items-center gap-2.5">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="h-10 min-w-0 flex-1 rounded-[9px] border border-stone-200 bg-white px-3 font-mono text-[12.5px] text-stone-700 placeholder:text-stone-400 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200"
          />
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={busy || !url.trim()}
            className={`${smallButtonClass} h-10 shrink-0`}
          >
            {busy ? "Connecting…" : "Create"}
          </button>
        </div>
      )}

      <p className="mt-2.5 text-[12.5px] text-stone-400 dark:text-stone-500">
        Need org-specific alerts, filters, or the JSON payload?{" "}
        <Link
          href="/account/webhooks"
          className="underline underline-offset-2 hover:text-stone-700 dark:hover:text-stone-300"
        >
          Advanced options
        </Link>
      </p>
    </section>
  );
}

export function NotificationsPanel({
  initial = null,
}: {
  /** Optional RSC-hydrated bootstrap from GET /v1/me/settings/notifications. */
  initial?: NotificationSettingsResponse | null;
}) {
  const { data, status, error, retry } = useSettingsBootstrap(
    initial,
    getNotificationSettings,
    "Failed to load notification settings.",
  );

  if (status === "loading") {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (status === "unsigned") {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/notifications" className="underline">
          sign in
        </Link>{" "}
        to manage notifications.
      </p>
    );
  }

  if (status === "error" || !data) {
    return (
      <div className="space-y-3">
        <ErrorText>{error ?? "Failed to load notification settings."}</ErrorText>
        <button type="button" onClick={() => void retry()} className={secondaryButtonClass}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <PanelGrid>
      <div className="flex flex-col gap-9">
        <EmailSection cadence={data.cadence} />
        <FeedTokenSection token={data.feedToken} />
        <SlackSection webhooks={data.webhooks} />
      </div>
    </PanelGrid>
  );
}
