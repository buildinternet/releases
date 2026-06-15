"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession, listAccounts, linkSocial, unlinkAccount } from "@/lib/auth-client";
import { SOCIAL_PROVIDERS, PROVIDER_META, type SocialProvider } from "@/lib/social-providers";

const buttonClass =
  "inline-flex h-9 items-center justify-center gap-2 border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";

/**
 * One linked account as returned by `listAccounts`. The row carries more
 * (userId/scopes/timestamps); the panel keys off `providerId` (`"credential"` for
 * email+password, `"google"` / `"github"` for social) and `accountId`.
 */
type AccountRow = {
  id: string;
  providerId: string;
  accountId: string;
  createdAt?: string | Date | null;
};

export function SocialConnectionsPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The provider mid-action (connect redirect / disconnect), to disable its button.
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState<SocialProvider | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAccounts();
      if (res.error) {
        setError(res.error.message ?? "Failed to load connections");
        return;
      }
      setAccounts((res.data ?? []) as AccountRow[]);
    } catch {
      setError("Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  // No social providers wired in this environment → nothing to manage.
  if (SOCIAL_PROVIDERS.length === 0) return null;

  async function onConnect(provider: SocialProvider) {
    if (busy) return;
    setBusy(provider);
    setError(null);
    try {
      // Redirects the browser to the provider's OAuth consent screen; on success it
      // returns to /account with the account linked. errorCallbackURL keeps a denied
      // or failed link from stranding the user off-site.
      const res = await linkSocial({
        provider,
        callbackURL: `${window.location.origin}/account`,
        errorCallbackURL: `${window.location.origin}/account`,
      });
      if (res?.error) {
        setError(res.error.message ?? `Could not connect ${PROVIDER_META[provider].label}.`);
        setBusy(null);
      }
      // On success the call navigates away; leave `busy` set so the button stays
      // disabled through the redirect.
    } catch {
      setError(`Could not connect ${PROVIDER_META[provider].label}.`);
      setBusy(null);
    }
  }

  async function onDisconnect(provider: SocialProvider, accountId: string) {
    if (busy) return;
    setBusy(provider);
    setError(null);
    try {
      const res = await unlinkAccount({ providerId: provider, accountId });
      if (res?.error) {
        // Better Auth refuses to unlink your last remaining sign-in method — surface
        // that (and any other failure) rather than silently no-op.
        setError(res.error.message ?? `Could not disconnect ${PROVIDER_META[provider].label}.`);
        return;
      }
      setConfirmUnlink(null);
      await refresh();
    } catch {
      setError(`Could not disconnect ${PROVIDER_META[provider].label}.`);
    } finally {
      setBusy(null);
    }
  }

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account" className="underline">
          sign in
        </Link>{" "}
        to manage your connections.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
          Account
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          Connections
        </h1>
        <p className="mt-3 max-w-prose text-sm leading-6 text-stone-500 dark:text-stone-400">
          Link a social account to sign in with one click. You can connect more than one — but you
          can&rsquo;t remove your last remaining way to sign in.
        </p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      ) : (
        <ul className="divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {SOCIAL_PROVIDERS.map((provider) => {
            const meta = PROVIDER_META[provider];
            const linked = accounts.find((a) => a.providerId === provider);
            return (
              <li key={provider} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 text-stone-700 dark:text-stone-200">{meta.icon}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                      {meta.label}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-stone-500 dark:text-stone-400">
                      {linked ? "connected" : "not connected"}
                    </p>
                  </div>
                </div>
                {linked ? (
                  confirmUnlink === provider ? (
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        disabled={busy === provider}
                        onClick={() => onDisconnect(provider, linked.accountId)}
                        className="inline-flex h-9 items-center justify-center border border-red-300 bg-white px-3 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/40 dark:bg-stone-950 dark:text-red-400 dark:hover:bg-red-950/30"
                      >
                        {busy === provider ? "Disconnecting…" : "Confirm disconnect"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmUnlink(null)}
                        className="text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmUnlink(provider);
                        setError(null);
                      }}
                      className="shrink-0 text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                    >
                      Disconnect
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={busy === provider}
                    onClick={() => onConnect(provider)}
                    className={buttonClass}
                  >
                    {busy === provider ? "Redirecting…" : "Connect"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
