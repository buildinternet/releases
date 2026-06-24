// web/src/components/workspace-members.tsx
"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { organization } from "@/lib/auth-client";
import { canActOnMember, roleToggleTarget } from "@/lib/workspace-permissions";

const buttonClass =
  "inline-flex h-8 items-center justify-center gap-2 border border-stone-300 bg-white px-2.5 text-xs font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";
const dangerButtonClass =
  "inline-flex h-8 items-center justify-center gap-2 border border-red-300 bg-white px-2.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/40 dark:bg-stone-950 dark:text-red-400 dark:hover:bg-red-950/30";
const cancelLinkClass =
  "text-xs text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100";

export type WorkspaceMemberRow = {
  id: string;
  role: string;
  userId: string;
  user: { name?: string | null; email: string };
};

export function WorkspaceMembers({
  organizationId,
  members,
  viewerRole,
  viewerUserId,
  onChanged,
}: {
  organizationId: string;
  members: WorkspaceMemberRow[];
  viewerRole: string | null;
  viewerUserId: string;
  onChanged: () => void | Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Confirm-on-second-click gate for the irreversible actions (leave / remove), keyed
  // `<action>:<memberId>` so only one row's action is armed at a time. Mirrors the
  // confirm pattern in passkeys-panel / social-connections-panel.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const router = useRouter();

  const run = useCallback(
    async (
      rowId: string,
      fn: () => Promise<{ error?: { message?: string } | null }>,
      after: () => void | Promise<void>,
      errorMessage = "Could not update this member.",
    ) => {
      if (busyId) return;
      setBusyId(rowId);
      setError(null);
      try {
        const res = await fn();
        if (res.error) {
          setError(res.error.message ?? errorMessage);
          return;
        }
        await after();
      } catch {
        setError(errorMessage);
      } finally {
        setBusyId(null);
      }
    },
    [busyId],
  );

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <ul className="divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
        {members.map((m) => {
          const isSelf = m.userId === viewerUserId;
          const actionable = canActOnMember(viewerRole, m.role, isSelf);
          const toggle = roleToggleTarget(m.role);
          return (
            <li key={m.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                  {m.user.name?.trim() || m.user.email}
                </p>
                <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                  {m.user.email} · {m.role}
                  {isSelf ? " · you" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isSelf &&
                  m.role !== "owner" &&
                  (confirmKey === `leave:${m.id}` ? (
                    <>
                      <button
                        type="button"
                        aria-label="Confirm leaving this workspace"
                        disabled={busyId !== null}
                        className={dangerButtonClass}
                        onClick={() => {
                          setConfirmKey(null);
                          void run(
                            m.id,
                            () => organization.leave({ organizationId }),
                            () => router.push("/account/workspaces"),
                            "Could not leave this workspace.",
                          );
                        }}
                      >
                        Confirm leave
                      </button>
                      <button
                        type="button"
                        className={cancelLinkClass}
                        onClick={() => setConfirmKey(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label="Leave this workspace"
                      disabled={busyId !== null}
                      className={buttonClass}
                      onClick={() => setConfirmKey(`leave:${m.id}`)}
                    >
                      Leave
                    </button>
                  ))}
                {actionable && toggle && (
                  <button
                    type="button"
                    aria-label={`${toggle === "admin" ? "Make admin" : "Make member"}: ${m.user.name?.trim() || m.user.email}`}
                    disabled={busyId !== null}
                    className={buttonClass}
                    onClick={() =>
                      void run(
                        m.id,
                        () =>
                          organization.updateMemberRole({
                            memberId: m.id,
                            role: toggle,
                            organizationId,
                          }),
                        onChanged,
                      )
                    }
                  >
                    {toggle === "admin" ? "Make admin" : "Make member"}
                  </button>
                )}
                {actionable &&
                  (confirmKey === `remove:${m.id}` ? (
                    <>
                      <button
                        type="button"
                        aria-label={`Confirm removing ${m.user.name?.trim() || m.user.email}`}
                        disabled={busyId !== null}
                        className={dangerButtonClass}
                        onClick={() => {
                          setConfirmKey(null);
                          void run(
                            m.id,
                            () =>
                              organization.removeMember({ memberIdOrEmail: m.id, organizationId }),
                            onChanged,
                          );
                        }}
                      >
                        Confirm remove
                      </button>
                      <button
                        type="button"
                        className={cancelLinkClass}
                        onClick={() => setConfirmKey(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove ${m.user.name?.trim() || m.user.email}`}
                      disabled={busyId !== null}
                      className={buttonClass}
                      onClick={() => setConfirmKey(`remove:${m.id}`)}
                    >
                      Remove
                    </button>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
