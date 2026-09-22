"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type {
  DigestCadence,
  FeedToken,
  NotificationSettingsResponse,
  UserWebhookFormat,
  UserWebhookListItem,
} from "@buildinternet/releases-api-types";
import { getNotificationSettings } from "@/lib/me-settings";
import { setDigestCadence, mintFeedToken, revokeFeedToken } from "@/lib/follows";
import { listWebhooks, createWebhook, testWebhook, deleteWebhook } from "@/lib/webhooks";
import { WebhookFormatIcon } from "@/components/webhook-format-icon";
import { detectChatWebhookFormat, type ChatWebhookFormat } from "@/lib/chat-webhook-url";
import { SemanticAlertsSection } from "@/components/semantic-alerts-section";
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

const CHAT_APPS: Record<
  ChatWebhookFormat,
  { label: string; placeholder: string; docsHref: string; docsLabel: string }
> = {
  slack: {
    label: "Slack",
    placeholder: "https://hooks.slack.com/services/…",
    docsHref: "/docs/integrations/slack",
    docsLabel: "Get a Slack webhook URL",
  },
  discord: {
    label: "Discord",
    placeholder: "https://discord.com/api/webhooks/…",
    docsHref: "/docs/integrations/discord",
    docsLabel: "Get a Discord webhook URL",
  },
};

function isChatFormat(format: UserWebhookFormat): format is ChatWebhookFormat {
  return format === "slack" || format === "discord";
}

/**
 * Slack / Discord delivery for everything the user follows. Both ride the one
 * `scope: "follows"` webhook a user may hold, so this is a single connection
 * with an app picker — not one row per app.
 */
function ChatSection({ webhooks: initialWebhooks }: { webhooks: UserWebhookListItem[] }) {
  const [hooks, setHooks] = useState<UserWebhookListItem[]>(initialWebhooks);
  const [app, setApp] = useState<ChatWebhookFormat>("slack");
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

  const followsHook = hooks.find((h) => h.scope === "follows") ?? null;
  const chatHook = followsHook && isChatFormat(followsHook.format) ? followsHook : null;
  const connectedApp = chatHook ? CHAT_APPS[chatHook.format as ChatWebhookFormat] : null;
  const followsTakenByJson = followsHook != null && chatHook == null;
  const selected = CHAT_APPS[app];

  function onUrlChange(next: string) {
    setUrl(next);
    // Pasting the other app's URL switches the picker rather than erroring.
    const detected = detectChatWebhookFormat(next);
    if (detected && detected !== app) setApp(detected);
  }

  async function onCreate() {
    if (busy) return;
    if (detectChatWebhookFormat(url) !== app) {
      setError(
        app === "slack"
          ? "Enter a Slack incoming webhook URL (hooks.slack.com)."
          : "Enter a Discord webhook URL (discord.com/api/webhooks/…).",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await createWebhook({ url: url.trim(), scope: "follows", format: app });
      setUrl("");
      setSuccess(`${selected.label} connected.`);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `Failed to connect ${selected.label}.`);
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    if (!chatHook || !connectedApp || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await testWebhook(chatHook.id);
      setSuccess(`Sent a test message to ${connectedApp.label}.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send test message.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (!chatHook || !connectedApp || busy) return;
    if (
      !window.confirm(
        `Remove this ${connectedApp.label} connection? The Index will stop posting to it.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await deleteWebhook(chatHook.id);
      await refresh();
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : `Failed to remove ${connectedApp.label} connection.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Slack &amp; Discord
      </div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        Post a message to a channel whenever something you follow ships.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {success && <p className="mb-3 text-[12.5px] text-[var(--accent)]">{success}</p>}

      {chatHook && connectedApp ? (
        <div className={listCardClass}>
          <div className={listRowClass}>
            <WebhookFormatIcon format={chatHook.format} className="size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                {chatHook.description?.trim() || `${connectedApp.label} channel`}
              </div>
              <div className="mt-0.5 text-[12.5px] text-stone-400 dark:text-stone-500">
                {chatHook.enabled ? (
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
      ) : followsTakenByJson ? (
        <p className="text-[13px] text-stone-500 dark:text-stone-400">
          Your follows webhook already sends JSON. To post to Slack or Discord instead, remove it in{" "}
          <Link
            href="/account/webhooks"
            className="underline underline-offset-2 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Webhooks &amp; API
          </Link>
          .
        </p>
      ) : (
        <>
          <div
            className="mb-2.5 inline-flex overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700"
            role="group"
            aria-label="Chat app"
          >
            {(Object.keys(CHAT_APPS) as ChatWebhookFormat[]).map((key) => (
              <button
                key={key}
                type="button"
                disabled={busy}
                aria-pressed={app === key}
                onClick={() => {
                  setApp(key);
                  setError(null);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] disabled:opacity-50 ${
                  app === key
                    ? "bg-[var(--accent-soft)] font-semibold text-stone-900 dark:text-stone-100"
                    : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                }`}
              >
                <WebhookFormatIcon format={key} className="size-3.5 shrink-0" />
                {CHAT_APPS[key].label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2.5">
            <input
              type="url"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              placeholder={selected.placeholder}
              aria-label={`${selected.label} webhook URL`}
              className="h-10 min-w-0 flex-1 rounded-[9px] border border-stone-200 bg-white px-3 font-mono text-[12.5px] text-stone-700 placeholder:text-stone-400 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200"
            />
            <button
              type="button"
              onClick={() => void onCreate()}
              disabled={busy || !url.trim()}
              className={`${smallButtonClass} h-10 shrink-0`}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
          <p className="mt-2 text-[12.5px] text-stone-400 dark:text-stone-500">
            <Link
              href={selected.docsHref}
              className="underline underline-offset-2 hover:text-stone-700 dark:hover:text-stone-300"
            >
              {selected.docsLabel}
            </Link>
          </p>
        </>
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
        <ChatSection webhooks={data.webhooks} />
        {data.semanticAlerts != null && (
          <SemanticAlertsSection alerts={data.semanticAlerts} webhooks={data.webhooks} />
        )}
      </div>
    </PanelGrid>
  );
}
