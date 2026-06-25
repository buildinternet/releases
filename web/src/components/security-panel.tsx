"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  useSession,
  changeEmail,
  requestPasswordReset,
  listAccounts,
  linkSocial,
  unlinkAccount,
  passkey,
  listSessions,
  revokeSession,
} from "@/lib/auth-client";
import { displayEmailOf } from "@/lib/auth-ui";
import { SOCIAL_PROVIDERS, PROVIDER_META, type SocialProvider } from "@/lib/social-providers";
import {
  PanelGrid,
  Aside,
  ErrorText,
  SuccessBanner,
  confirmRemoveButtonClass,
  inputClass,
  listCardClass,
  listRowClass,
  secondaryButtonClass,
  smallButtonClass,
  dangerLinkClass,
} from "@releases/design-system";
import { KeyIcon, DeviceIcon } from "@/components/account/icons";

/* ── shared row chrome ───────────────────────────────────────────────── */

const tileClass =
  "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300";

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

/* ── Email ───────────────────────────────────────────────────────────── */

function EmailSection({ user }: { user: { email: string; displayEmail?: string | null } }) {
  const [newEmail, setNewEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = newEmail.trim();
    if (saving || !next) return;
    if (next.toLowerCase() === user.email.toLowerCase()) {
      setError("That's already your email address.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await changeEmail({
        newEmail: next,
        callbackURL: `${window.location.origin}/account/security`,
      });
      if (res?.error) {
        setError(res.error.message ?? "Could not change your email.");
        return;
      }
      setSentTo(displayEmailOf(user));
      setNewEmail("");
    } catch {
      setError("Could not change your email.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">Email address</div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        Currently <span className="text-stone-700 dark:text-stone-200">{displayEmailOf(user)}</span>
        . A confirmation link goes to your current address.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {sentTo && (
        <div className="mb-3">
          <SuccessBanner>Confirmation link sent to {sentTo}.</SuccessBanner>
        </div>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-2.5 sm:flex-row">
        <input
          type="email"
          autoComplete="email"
          value={newEmail}
          onChange={(e) => {
            setNewEmail(e.target.value);
            setError(null);
            setSentTo(null);
          }}
          placeholder="new@email.com"
          className={`${inputClass} sm:flex-1`}
        />
        <button
          type="submit"
          disabled={saving || !newEmail.trim()}
          className={`${secondaryButtonClass} shrink-0`}
        >
          {saving ? "Sending…" : "Change email"}
        </button>
      </form>
    </section>
  );
}

/* ── Password ────────────────────────────────────────────────────────── */

function PasswordSection({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onReset() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (res?.error) {
        setError(res.error.message ?? "Could not send a reset link.");
        return;
      }
      setSent(true);
    } catch {
      setError("Could not send a reset link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">Password</div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        We'll email you a secure link to set a new password.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {sent ? (
        <SuccessBanner>Reset link sent to {email}.</SuccessBanner>
      ) : (
        <button type="button" onClick={onReset} disabled={busy} className={secondaryButtonClass}>
          {busy ? "Sending…" : "Change password"}
        </button>
      )}
    </section>
  );
}

/* ── Connected accounts ──────────────────────────────────────────────── */

type AccountRow = { id: string; providerId: string; accountId: string };

function ConnectionsSection() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [confirm, setConfirm] = useState<SocialProvider | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAccounts();
      if (res.error) {
        setError(res.error.message ?? "Failed to load connections.");
        return;
      }
      setAccounts((res.data ?? []) as AccountRow[]);
    } catch {
      setError("Failed to load connections.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (SOCIAL_PROVIDERS.length === 0) return null;

  async function onConnect(provider: SocialProvider) {
    if (busy) return;
    setBusy(provider);
    setError(null);
    try {
      const res = await linkSocial({
        provider,
        callbackURL: `${window.location.origin}/account/security`,
        errorCallbackURL: `${window.location.origin}/account/security`,
      });
      if (res?.error) {
        setError(res.error.message ?? `Could not connect ${PROVIDER_META[provider].label}.`);
        setBusy(null);
      }
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
        setError(res.error.message ?? `Could not disconnect ${PROVIDER_META[provider].label}.`);
        return;
      }
      setConfirm(null);
      await refresh();
    } catch {
      setError(`Could not disconnect ${PROVIDER_META[provider].label}.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Connected accounts
      </div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        Identity providers you can use to sign in to releases.sh.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      ) : (
        <div className={listCardClass}>
          {SOCIAL_PROVIDERS.map((provider) => {
            const meta = PROVIDER_META[provider];
            const linked = accounts.find((a) => a.providerId === provider);
            return (
              <div key={provider} className={listRowClass}>
                <span className={tileClass}>{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                    {meta.label}
                  </div>
                  <div className="text-[12.5px] text-stone-400 dark:text-stone-500">
                    {linked ? "Connected" : "Not connected"}
                  </div>
                </div>
                {linked ? (
                  confirm === provider ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={busy === provider}
                        onClick={() => onDisconnect(provider, linked.accountId)}
                        className={confirmRemoveButtonClass}
                      >
                        {busy === provider ? "Disconnecting…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirm(null)}
                        className="px-1 text-[13px] text-stone-400 hover:text-stone-900 dark:text-stone-500 dark:hover:text-stone-100"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirm(provider);
                        setError(null);
                      }}
                      className={smallButtonClass}
                    >
                      Disconnect
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={busy === provider}
                    onClick={() => onConnect(provider)}
                    className="inline-flex h-8 items-center rounded-lg bg-[var(--accent)] px-3 text-[12.5px] font-semibold text-[var(--on-accent)] disabled:opacity-60"
                  >
                    {busy === provider ? "Redirecting…" : "Connect"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ── Passkeys ────────────────────────────────────────────────────────── */

type PasskeyRow = {
  id: string;
  name?: string | null;
  deviceType?: string | null;
  createdAt?: string | Date | null;
};

function PasskeysSection() {
  const [keys, setKeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await passkey.listUserPasskeys();
      if (res.error) {
        setError(res.error.message ?? "Failed to load passkeys.");
        return;
      }
      setKeys((res.data ?? []) as PasskeyRow[]);
    } catch {
      setError("Failed to load passkeys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onAdd() {
    if (adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await passkey.addPasskey();
      if (res?.error) {
        setError(res.error.message ?? "Could not add a passkey.");
        return;
      }
      await refresh();
    } catch {
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
        setError(res.error.message ?? "Failed to remove passkey.");
        return;
      }
      setConfirmId(null);
      await refresh();
    } catch {
      setError("Failed to remove passkey.");
    }
  }

  return (
    <section>
      <div className="mb-3.5 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">Passkeys</div>
          <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">
            Sign in with Touch ID, Face ID, or a security key.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={adding}
          className={`${smallButtonClass} shrink-0`}
        >
          {adding ? "Waiting…" : "+ Add"}
        </button>
      </div>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 px-4 py-3.5 text-[13px] text-stone-500 dark:border-stone-700 dark:text-stone-400">
          No passkeys yet.
        </p>
      ) : (
        <div className={listCardClass}>
          {keys.map((pk) => (
            <div key={pk.id} className={listRowClass}>
              <span className={tileClass}>
                <KeyIcon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                  {pk.name?.trim() || "Passkey"}
                </div>
                <div className="font-mono text-[12px] text-stone-400 dark:text-stone-500">
                  {pk.deviceType === "multiDevice" ? "synced" : "this device"} · added{" "}
                  {formatDate(pk.createdAt)}
                </div>
              </div>
              {confirmId === pk.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onDelete(pk.id)}
                    className={confirmRemoveButtonClass}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="px-1 text-[13px] text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(pk.id)}
                  className={dangerLinkClass}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Active sessions ─────────────────────────────────────────────────── */

type SessionRow = {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  updatedAt?: string | Date | null;
  createdAt?: string | Date | null;
};

/** Best-effort "Browser · OS" from a user-agent string. */
function describeUA(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}

function SessionsSection({ currentToken }: { currentToken: string | undefined }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listSessions();
      if (res.error) {
        setError(res.error.message ?? "Failed to load sessions.");
        return;
      }
      setSessions((res.data ?? []) as SessionRow[]);
    } catch {
      setError("Failed to load sessions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onRevoke(token: string) {
    setBusyToken(token);
    setError(null);
    try {
      const res = await revokeSession({ token });
      if (res?.error) {
        setError(res.error.message ?? "Failed to revoke session.");
        return;
      }
      await refresh();
    } catch {
      setError("Failed to revoke session.");
    } finally {
      setBusyToken(null);
    }
  }

  // Current session first, then most-recent.
  const sorted = [...sessions].sort((a, b) => {
    if (a.token === currentToken) return -1;
    if (b.token === currentToken) return 1;
    return 0;
  });

  return (
    <section>
      <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
        Active sessions
      </div>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">No active sessions.</p>
      ) : (
        <div className={listCardClass}>
          {sorted.map((s) => {
            const isCurrent = s.token === currentToken;
            return (
              <div key={s.id} className={listRowClass}>
                <span className={tileClass}>
                  <DeviceIcon />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                    {describeUA(s.userAgent)}
                  </div>
                  <div className="font-mono text-[12px] text-stone-400 dark:text-stone-500">
                    {s.ipAddress || "unknown IP"} ·{" "}
                    {isCurrent ? "active now" : formatDate(s.updatedAt)}
                  </div>
                </div>
                {isCurrent ? (
                  <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]">
                    Current
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busyToken === s.token}
                    onClick={() => onRevoke(s.token)}
                    className={dangerLinkClass}
                  >
                    {busyToken === s.token ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ── Panel ───────────────────────────────────────────────────────────── */

export function SecurityPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const currentToken = (sessionData?.session as { token?: string } | undefined)?.token;

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
        to manage your security.
      </p>
    );
  }

  return (
    <PanelGrid
      aside={
        <Aside label="Tip">
          <p className="text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
            Passkeys are phishing-resistant and faster than passwords. Add one for each device you
            use.
          </p>
        </Aside>
      }
    >
      <div className="flex flex-col gap-9">
        <EmailSection user={user} />
        <PasswordSection email={user.email} />
        <ConnectionsSection />
        <PasskeysSection />
        <SessionsSection currentToken={currentToken} />
      </div>
    </PanelGrid>
  );
}
