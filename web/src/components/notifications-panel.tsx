"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DigestCadence, FeedToken } from "@buildinternet/releases-api-types";
import { useSession } from "@/lib/auth-client";
import {
  getDigestCadence,
  setDigestCadence,
  getFeedToken,
  mintFeedToken,
  revokeFeedToken,
} from "@/lib/follows";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { PanelGrid } from "@/components/account/settings-section";
import {
  Toggle,
  ErrorText,
  listCardClass,
  listRowClass,
  secondaryButtonClass,
  smallButtonClass,
  dangerLinkClass,
} from "@/components/account/ui";

function EmailSection() {
  const [cadence, setCadence] = useState<DigestCadence>("off");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDigestCadence()
      .then(setCadence)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load settings."))
      .finally(() => setLoading(false));
  }, []);

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

  if (loading) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

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

        <div className={listRowClass}>
          <div className="flex-1">
            <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
              Instant release alerts{" "}
              <span className="font-normal text-stone-400">(coming soon)</span>
            </div>
            <div className="mt-0.5 text-[12.5px] text-stone-400 dark:text-stone-500">
              Email the moment a followed source ships. For now, use webhooks for real-time
              delivery.
            </div>
          </div>
          <Toggle label="Instant release alerts" checked={false} disabled onChange={() => {}} />
        </div>
      </div>
    </section>
  );
}

function FeedTokenSection() {
  const [token, setToken] = useState<FeedToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    getFeedToken()
      .then(setToken)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load your feed URL."),
      )
      .finally(() => setLoading(false));
  }, []);

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

  if (loading) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

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

export function NotificationsPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  if (isPending) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

  if (!user) {
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

  return (
    <PanelGrid>
      <div className="flex flex-col gap-9">
        <EmailSection />
        <FeedTokenSection />
      </div>
    </PanelGrid>
  );
}
