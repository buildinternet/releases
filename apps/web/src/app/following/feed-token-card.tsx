"use client";

import { useEffect, useState } from "react";
import type { FeedToken } from "@buildinternet/releases-api-types";
import { getFeedToken, mintFeedToken, revokeFeedToken } from "@/lib/follows";
import { formatRelativeDate } from "@/lib/formatters";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

export function FeedTokenCard() {
  const [token, setToken] = useState<FeedToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getFeedToken()
      .then((t) => setToken(t))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load your feed URL."),
      )
      .finally(() => setLoading(false));
  }, []);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      setToken(await mintFeedToken());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to generate feed URL.");
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!window.confirm("Rotate your feed URL? Existing reader subscriptions will stop working."))
      return;
    await mint();
  }

  async function revoke() {
    if (!window.confirm("Revoke your feed URL?")) return;
    setBusy(true);
    setError(null);
    try {
      await revokeFeedToken();
      setToken(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to revoke feed URL.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
        Your feed
      </h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Subscribe to everything you follow in any RSS/Atom reader.
      </p>

      {error && <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</p>}

      {token ? (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={token.feedUrl}
              className="min-w-0 flex-1 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[13px] text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300"
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Your private feed URL"
            />
            <button
              type="button"
              onClick={() => copy(token.feedUrl)}
              className="shrink-0 rounded border border-stone-200 px-3 py-1 text-[13px] text-stone-700 hover:border-stone-300 hover:text-stone-900 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-600 dark:hover:text-stone-100"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <p className="text-[11px] text-stone-400 dark:text-stone-500">
            Keep this URL private — anyone with it can read your followed-releases feed. Rotate to
            invalidate the old one.
          </p>

          <div className="flex items-center gap-3 text-[12px] text-stone-400 dark:text-stone-500">
            <span>
              Created <time dateTime={token.createdAt}>{formatRelativeDate(token.createdAt)}</time>
            </span>
            {token.lastUsedAt && (
              <>
                <span aria-hidden>·</span>
                <span>
                  Last used{" "}
                  <time dateTime={token.lastUsedAt}>{formatRelativeDate(token.lastUsedAt)}</time>
                </span>
              </>
            )}
          </div>

          <div className="flex gap-3 pt-0.5 text-[13px]">
            <button
              type="button"
              onClick={() => void rotate()}
              disabled={busy}
              className="text-stone-500 hover:text-stone-800 hover:underline underline-offset-2 disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-200"
            >
              Rotate
            </button>
            <button
              type="button"
              onClick={() => void revoke()}
              disabled={busy}
              className="text-red-500 hover:text-red-700 hover:underline underline-offset-2 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
            >
              Revoke
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void mint()}
          disabled={busy}
          className="mt-3 rounded border border-stone-200 px-3 py-1.5 text-[13px] text-stone-700 hover:border-stone-300 hover:text-stone-900 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-600 dark:hover:text-stone-100"
        >
          {busy ? "Generating…" : "Generate a private feed URL"}
        </button>
      )}
    </div>
  );
}
