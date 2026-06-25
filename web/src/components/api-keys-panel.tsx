"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  type UserApiKey,
  type CreatedUserApiKey,
} from "@/lib/api-keys";

const labelClass = "block text-sm font-medium text-stone-700 dark:text-stone-200";
const inputClass =
  "mt-1 w-full rounded-[9px] border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";
const buttonClass =
  "inline-flex h-10 items-center justify-center rounded-[9px] border border-stone-200 bg-white px-4 text-sm font-medium text-stone-800 transition hover:border-stone-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:border-stone-600";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

/** Coarse relative-time label for "last used" — keys may never have authed a request. */
function formatLastUsed(iso: string | null): string {
  if (!iso) return "never used";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never used";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "last used just now";
  if (minutes < 60) return `last used ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `last used ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `last used ${days}d ago`;
  return `last used ${formatDate(iso)}`;
}

export function ApiKeysPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<CreatedUserApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await listApiKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createApiKey({ name: name.trim() });
      setRevealed(created);
      setCopied(false);
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    setError(null);
    try {
      await revokeApiKey(id);
      setConfirmId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke API key");
    }
  }

  async function onCopy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (non-HTTPS origin, denied permission, or
      // missing) — the key shows only once, so tell the user to copy it manually
      // rather than failing silently.
      setCopied(false);
      setError("Could not copy automatically — select and copy the key above before dismissing.");
    }
  }

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/api-keys" className="underline">
          sign in
        </Link>{" "}
        to manage your API keys.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {revealed && (
        <div className="rounded-xl border border-green-600/30 bg-green-50 p-4 dark:border-green-500/30 dark:bg-green-950/40">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Key created. Copy it now — it won't be shown again.
          </p>
          <code className="mt-3 block overflow-x-auto whitespace-nowrap rounded-lg border border-green-600/30 bg-white px-3 py-2 font-mono text-xs text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            {revealed.key}
          </code>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={onCopy} className={buttonClass}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => setRevealed(null)} className={buttonClass}>
              I've saved it
            </button>
          </div>
        </div>
      )}

      <form
        onSubmit={onCreate}
        className="space-y-4 rounded-xl border border-stone-200 p-5 dark:border-stone-800"
      >
        <div>
          <label htmlFor="key-name" className={labelClass}>
            Name
          </label>
          <input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. CI pipeline"
            className={inputClass}
            required
          />
        </div>
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Keys are read-only — they can search and read the catalog, but cannot modify it.
        </p>
        <button type="submit" disabled={creating || !name.trim()} className={buttonClass}>
          {creating ? "Creating…" : "Create key"}
        </button>
      </form>

      <section>
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Your keys</h2>
        {loading ? (
          <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">No keys yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-200 overflow-hidden rounded-xl border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                    {k.name || "(unnamed)"}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-stone-500 dark:text-stone-400">
                    {k.start ? `${k.start}…` : "relu_…"} · {k.scope ?? "read"} · created{" "}
                    {formatDate(k.createdAt)} · {formatLastUsed(k.lastRequest)}
                    {k.expiresAt ? ` · expires ${formatDate(k.expiresAt)}` : ""}
                  </p>
                </div>
                {confirmId === k.id ? (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => onRevoke(k.id)}
                      className="inline-flex h-9 items-center justify-center rounded-lg border border-red-300 bg-white px-3 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-500/40 dark:bg-stone-950 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      Confirm revoke
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className={buttonClass}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmId(k.id)}
                    className="shrink-0 text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
