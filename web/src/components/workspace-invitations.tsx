// web/src/components/workspace-invitations.tsx
"use client";

import { useCallback, useState } from "react";
import { organization } from "@/lib/auth-client";

const buttonClass =
  "inline-flex h-8 items-center justify-center gap-2 border border-stone-300 bg-white px-2.5 text-xs font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";
const primaryButtonClass =
  "inline-flex h-9 items-center justify-center gap-2 border border-stone-900 bg-stone-900 px-3 text-sm font-medium text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200";
const inputClass =
  "h-9 flex-1 border border-stone-300 bg-white px-3 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

export type WorkspaceInvitationRow = { id: string; email: string; role: string; status: string };

export function WorkspaceInvitations({
  organizationId,
  invitations,
  onChanged,
}: {
  organizationId: string;
  invitations: WorkspaceInvitationRow[];
  onChanged: () => void | Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invite = useCallback(
    async (target: { email: string; role: string; resend?: boolean }) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await organization.inviteMember({
          email: target.email,
          role: target.role as "member" | "admin",
          organizationId,
          ...(target.resend ? { resend: true } : {}),
        });
        if (res.error) {
          setError(res.error.message ?? "Could not send the invitation.");
          return;
        }
        if (!target.resend) setEmail("");
        await onChanged();
      } catch {
        setError("Could not send the invitation.");
      } finally {
        setBusy(false);
      }
    },
    [busy, organizationId, onChanged],
  );

  const cancel = useCallback(
    async (invitationId: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await organization.cancelInvitation({ invitationId });
        if (res.error) {
          setError(res.error.message ?? "Could not cancel the invitation.");
          return;
        }
        await onChanged();
      } catch {
        setError("Could not cancel the invitation.");
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged],
  );

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          type="email"
          aria-label="Email address to invite"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className={inputClass}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
          className="h-9 border border-stone-300 bg-white px-2 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button
          type="button"
          disabled={busy || !email.trim()}
          onClick={() => void invite({ email: email.trim(), role })}
          className={primaryButtonClass}
        >
          {busy ? "Sending…" : "Send invite"}
        </button>
      </div>

      {invitations.length > 0 && (
        <ul className="divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
          {invitations.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-stone-900 dark:text-stone-100">{i.email}</p>
                <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                  {i.role} · pending
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  aria-label={`Resend invitation to ${i.email}`}
                  disabled={busy}
                  className={buttonClass}
                  onClick={() => void invite({ email: i.email, role: i.role, resend: true })}
                >
                  Resend
                </button>
                <button
                  type="button"
                  aria-label={`Cancel invitation to ${i.email}`}
                  disabled={busy}
                  className={buttonClass}
                  onClick={() => void cancel(i.id)}
                >
                  Cancel
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {invitations.length === 0 && (
        <p className="text-sm text-stone-500 dark:text-stone-400">No pending invitations.</p>
      )}
    </div>
  );
}
