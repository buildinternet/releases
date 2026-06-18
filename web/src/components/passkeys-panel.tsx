"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession, passkey } from "@/lib/auth-client";

const labelClass = "block text-sm font-medium text-stone-700 dark:text-stone-200";
const inputClass =
  "mt-1 w-full border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";
const buttonClass =
  "inline-flex h-10 items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";

/**
 * One passkey as returned by `passkey.listUserPasskeys`. The plugin's row carries
 * more (publicKey/counter/credentialID/aaguid/transports), but the panel only
 * renders these — typed loosely since the client's `Passkey` shape is plugin-owned.
 */
type PasskeyRow = {
  id: string;
  name?: string | null;
  deviceType?: string | null;
  createdAt?: string | Date | null;
};

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

/**
 * Friendly default label when a passkey was registered without a name. We avoid the
 * plugin's `getAuthenticatorName` (AAGUID lookup) here because it lives in the server
 * entry (`@better-auth/passkey`) and would pull `@simplewebauthn/server` into the
 * browser bundle — most passkeys are named at creation anyway, and the user can
 * rename. A plain "Passkey" is the honest fallback.
 */
function displayName(pk: PasskeyRow): string {
  return pk.name?.trim() || "Passkey";
}

export function PasskeysPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  const [keys, setKeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Inline-rename target + draft value move together, so one piece of state.
  const [rename, setRename] = useState<{ id: string; value: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await passkey.listUserPasskeys();
      if (res.error) {
        setError(res.error.message ?? "Failed to load passkeys");
        return;
      }
      setKeys((res.data ?? []) as PasskeyRow[]);
    } catch {
      setError("Failed to load passkeys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  async function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (adding) return;
    setAdding(true);
    setError(null);
    try {
      // Triggers the browser's WebAuthn registration prompt. The register response
      // always resolves with a data object carrying `error` (per the plugin docs —
      // `throw: true` has no effect here), so check `error` rather than catching.
      const res = await passkey.addPasskey({ name: name.trim() || undefined });
      if (res?.error) {
        setError(res.error.message ?? "Could not add a passkey. Please try again.");
        return;
      }
      setName("");
      await refresh();
    } catch {
      // A user-cancelled or unsupported WebAuthn ceremony rejects at the browser layer.
      setError("Passkey registration was cancelled or isn't available on this device.");
    } finally {
      setAdding(false);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      const res = await passkey.deletePasskey({ id });
      if (res?.error) {
        setError(res.error.message ?? "Failed to remove passkey");
        return;
      }
      setConfirmId(null);
      await refresh();
    } catch {
      setError("Failed to remove passkey");
    }
  }

  async function onRename() {
    if (!rename) return;
    const next = rename.value.trim();
    if (!next) return;
    setError(null);
    try {
      const res = await passkey.updatePasskey({ id: rename.id, name: next });
      if (res?.error) {
        setError(res.error.message ?? "Failed to rename passkey");
        return;
      }
      setRename(null);
      await refresh();
    } catch {
      setError("Failed to rename passkey");
    }
  }

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/security" className="underline">
          sign in
        </Link>{" "}
        to manage your passkeys.
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

      <form
        onSubmit={onAdd}
        className="space-y-4 border border-stone-200 p-5 dark:border-stone-800"
      >
        <div>
          <label htmlFor="passkey-name" className={labelClass}>
            Name <span className="text-stone-400">(optional)</span>
          </label>
          <input
            id="passkey-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. MacBook Touch ID"
            className={inputClass}
          />
        </div>
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Your browser will prompt you to create the passkey. Name it so you can recognize it later.
        </p>
        <button type="submit" disabled={adding} className={buttonClass}>
          {adding ? "Waiting for your device…" : "Add a passkey"}
        </button>
      </form>

      <section>
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Your passkeys</h2>
        {loading ? (
          <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">No passkeys yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {keys.map((pk) => (
              <li key={pk.id} className="flex items-center justify-between gap-4 px-4 py-3">
                {rename?.id === pk.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void onRename();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2"
                  >
                    <input
                      value={rename.value}
                      onChange={(e) => setRename({ id: pk.id, value: e.target.value })}
                      // oxlint-disable-next-line jsx-a11y/no-autofocus -- focuses the inline rename field the user just opened
                      autoFocus
                      className={`${inputClass} mt-0`}
                      aria-label="New passkey name"
                    />
                    <button type="submit" className={buttonClass}>
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setRename(null)}
                      className="shrink-0 text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                        {displayName(pk)}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-stone-500 dark:text-stone-400">
                        {pk.deviceType === "multiDevice" ? "synced" : "this device"} · added{" "}
                        {formatDate(pk.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setRename({ id: pk.id, value: pk.name ?? "" });
                          setConfirmId(null);
                        }}
                        className="text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                      >
                        Rename
                      </button>
                      {confirmId === pk.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => onDelete(pk.id)}
                            className="inline-flex h-9 items-center justify-center border border-red-300 bg-white px-3 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-500/40 dark:bg-stone-950 dark:text-red-400 dark:hover:bg-red-950/30"
                          >
                            Confirm remove
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmId(null)}
                            className="text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmId(pk.id)}
                          className="text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
