"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  useSession,
  organization,
  useListOrganizations,
  useActiveOrganization,
} from "@/lib/auth-client";
import { toSlug } from "@buildinternet/releases-core/slug";

const buttonClass =
  "inline-flex h-9 items-center justify-center gap-2 border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";

type WorkspaceRow = { id: string; name: string; slug: string };

export function WorkspacesPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  // The org-create / set-active actions trigger atom listeners that refetch these.
  const { data: workspaces, refetch } = useListOrganizations();
  const { data: active } = useActiveOrganization();

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await organization.create({
        name: trimmed,
        slug: toSlug(trimmed).slice(0, 48) || "workspace",
      });
      if (res?.error) {
        setError(res.error.message ?? "Could not create workspace.");
        return;
      }
      setName("");
      await refetch?.();
    } catch {
      setError("Could not create workspace.");
    } finally {
      setBusy(false);
    }
  }, [name, busy, refetch]);

  const onSwitch = useCallback(
    async (organizationId: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await organization.setActive({ organizationId });
        if (res?.error) setError(res.error.message ?? "Could not switch workspace.");
      } catch {
        setError("Could not switch workspace.");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  if (isPending) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/workspaces" className="underline">
          sign in
        </Link>{" "}
        to manage your workspaces.
      </p>
    );
  }

  const rows = (workspaces ?? []) as WorkspaceRow[];

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <ul className="divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
        {rows.length === 0 ? (
          <li className="px-4 py-3 text-sm text-stone-500 dark:text-stone-400">
            No workspaces yet.
          </li>
        ) : (
          rows.map((ws) => {
            const isActive = active?.id === ws.id;
            return (
              <li key={ws.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                    {ws.name}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-stone-500 dark:text-stone-400">
                    {isActive ? "active" : ws.slug}
                  </p>
                </div>
                {isActive ? (
                  <span className="shrink-0 text-sm text-stone-500 dark:text-stone-400">
                    Active
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSwitch(ws.id)}
                    className={buttonClass}
                  >
                    Switch
                  </button>
                )}
              </li>
            );
          })
        )}
      </ul>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New workspace name"
          className="h-9 flex-1 border border-stone-300 bg-white px-3 text-sm text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
        />
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={onCreate}
          className={buttonClass}
        >
          {busy ? "Creating…" : "Create workspace"}
        </button>
      </div>
    </div>
  );
}
