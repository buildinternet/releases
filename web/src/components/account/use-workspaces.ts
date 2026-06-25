/**
 * Shared workspace (Better Auth organization) state for the settings surface —
 * the sidebar context selector, the header account dropdown, and the General
 * panel all read/switch/create through this one hook so they stay in lockstep.
 * `organization.create` / `setActive` trigger the plugin's atom listeners, which
 * refetch the list/active hooks, so callers don't manage that themselves.
 */
"use client";

import { useCallback, useState } from "react";
import { organization, useListOrganizations, useActiveOrganization } from "@/lib/auth-client";
import { toSlug } from "@buildinternet/releases-core/slug";

export type Workspace = { id: string; name: string; slug: string; logo?: string | null };

export function useWorkspaces() {
  const { data, refetch } = useListOrganizations();
  const { data: active } = useActiveOrganization();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspaces = (data ?? []) as Workspace[];
  const activeRaw = (active as Workspace | null) ?? null;
  // List refetch carries logo updates (avatar upload); active hook can lag behind.
  const activeResolved =
    activeRaw && workspaces.length > 0
      ? (workspaces.find((w) => w.id === activeRaw.id) ?? activeRaw)
      : activeRaw;

  const switchTo = useCallback(async (organizationId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await organization.setActive({ organizationId });
      if (res?.error) {
        setError(res.error.message ?? "Could not switch workspace.");
        return false;
      }
      return true;
    } catch {
      setError("Could not switch workspace.");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      setBusy(true);
      setError(null);
      try {
        const res = await organization.create({
          name: trimmed,
          slug: toSlug(trimmed).slice(0, 48) || "workspace",
        });
        if (res?.error) {
          setError(res.error.message ?? "Could not create workspace.");
          return false;
        }
        await refetch?.();
        return true;
      } catch {
        setError("Could not create workspace.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refetch],
  );

  return {
    workspaces,
    active: activeResolved,
    busy,
    error,
    setError,
    switchTo,
    create,
    refetch,
  };
}

/** First letter for a workspace avatar tile. */
export function workspaceInitial(name: string | undefined | null): string {
  return (name ?? "").trim().slice(0, 1).toUpperCase() || "W";
}
