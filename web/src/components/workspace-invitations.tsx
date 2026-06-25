// web/src/components/workspace-invitations.tsx
"use client";

import { useCallback, useState } from "react";
import { organization } from "@/lib/auth-client";
import {
  ErrorText,
  inputClass,
  smallButtonClass,
  primaryButtonClass,
  listCardClass,
  listRowClass,
} from "@/components/account/ui";

const selectClass =
  "h-10 rounded-[9px] border border-stone-200 bg-white px-2 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

export type WorkspaceInvitationRow = { id: string; email: string; role: string; status: string };

/**
 * The roles invitable through this UI. A workspace `role` arrives as a bare string (from
 * the invitation row or the form), so narrow it to a supported value before handing it to
 * `inviteMember` rather than force-casting — anything unrecognized falls back to `member`.
 */
type InviteRole = "member" | "admin";
const toInviteRole = (role: string): InviteRole => (role === "admin" ? "admin" : "member");

export function WorkspaceInvitations({
  workspaceId,
  invitations,
  onChanged,
}: {
  workspaceId: string;
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
          role: toInviteRole(target.role),
          organizationId: workspaceId,
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
    [busy, workspaceId, onChanged],
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
      {error && <ErrorText>{error}</ErrorText>}

      <div className="flex items-center gap-2">
        <input
          type="email"
          aria-label="Email address to invite"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className={`${inputClass} flex-1`}
        />
        <select
          aria-label="Invite role"
          value={role}
          onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
          className={selectClass}
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
        <ul className={listCardClass}>
          {invitations.map((i) => (
            <li key={i.id} className={listRowClass}>
              <div className="min-w-0 flex-1">
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
                  className={smallButtonClass}
                  onClick={() => void invite({ email: i.email, role: i.role, resend: true })}
                >
                  Resend
                </button>
                <button
                  type="button"
                  aria-label={`Cancel invitation to ${i.email}`}
                  disabled={busy}
                  className={smallButtonClass}
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
