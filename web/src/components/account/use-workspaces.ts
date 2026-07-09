/**
 * Shared workspace (Better Auth organization) state for the settings surface —
 * the sidebar context selector, the header account dropdown, and the General
 * panel all read/switch/create through this one hook so they stay in lockstep.
 * `organization.create` / `setActive` trigger the plugin's atom listeners, which
 * refetch the list/active hooks, so callers don't manage that themselves.
 *
 * Last-known active workspace is mirrored to localStorage so the selector can
 * paint a stable name/logo on the first frame instead of flashing "Personal" /
 * "No workspace" while the Better Auth hooks resolve.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { organization, useListOrganizations, useActiveOrganization } from "@/lib/auth-client";
import { toSlug } from "@buildinternet/releases-core/slug";

export type Workspace = { id: string; name: string; slug: string; logo?: string | null };

const ACTIVE_WORKSPACE_CACHE_KEY = "releases.active_workspace";

function readActiveCache(): Workspace | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(ACTIVE_WORKSPACE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Workspace>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.slug !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      slug: parsed.slug,
      logo: typeof parsed.logo === "string" ? parsed.logo : (parsed.logo ?? null),
    };
  } catch {
    return null;
  }
}

function writeActiveCache(ws: Workspace | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!ws) {
      localStorage.removeItem(ACTIVE_WORKSPACE_CACHE_KEY);
      return;
    }
    localStorage.setItem(
      ACTIVE_WORKSPACE_CACHE_KEY,
      JSON.stringify({
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        logo: ws.logo ?? null,
      }),
    );
  } catch {
    // Quota / private mode — display still works without the cache.
  }
}

export function useWorkspaces() {
  const list = useListOrganizations();
  const activeHook = useActiveOrganization();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous seed so the first client paint can reuse the last visit.
  const [cachedActive, setCachedActive] = useState<Workspace | null>(() => readActiveCache());

  const workspaces = (list.data ?? []) as Workspace[];
  const activeRaw = (activeHook.data as Workspace | null | undefined) ?? null;
  // List refetch carries logo updates (avatar upload); active hook can lag behind.
  const liveActive =
    activeRaw && workspaces.length > 0
      ? (workspaces.find((w) => w.id === activeRaw.id) ?? activeRaw)
      : activeRaw;

  // Better Auth hooks expose isPending; fall back to "undefined data = still loading".
  const listPending = (list as { isPending?: boolean }).isPending ?? list.data === undefined;
  const activePending =
    (activeHook as { isPending?: boolean }).isPending ?? activeHook.data === undefined;
  const isLoading = listPending || activePending;

  // Prefer live active; while loading, keep the cached snapshot so the UI doesn't
  // flash "Personal". Once hooks settle with no active org, clear the fallback.
  const active = liveActive ?? (isLoading ? cachedActive : null);

  useEffect(() => {
    if (liveActive) {
      writeActiveCache(liveActive);
      setCachedActive(liveActive);
      return;
    }
    if (!isLoading && !liveActive) {
      // Confirmed empty (not "still fetching") — drop a stale cache so we don't
      // keep showing a deleted/left workspace forever.
      writeActiveCache(null);
      setCachedActive(null);
    }
  }, [liveActive, isLoading]);

  const switchTo = useCallback(
    async (workspaceId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await organization.setActive({ organizationId: workspaceId });
        if (res?.error) {
          setError(res.error.message ?? "Could not switch workspace.");
          return false;
        }
        // Optimistic cache update so the selector doesn't drop to empty mid-switch.
        const next = workspaces.find((w) => w.id === workspaceId);
        if (next) {
          writeActiveCache(next);
          setCachedActive(next);
        }
        return true;
      } catch {
        setError("Could not switch workspace.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [workspaces],
  );

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
        await list.refetch?.();
        return true;
      } catch {
        setError("Could not create workspace.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [list],
  );

  return {
    workspaces,
    active,
    /** True while Better Auth list/active hooks have not resolved yet. */
    isLoading,
    busy,
    error,
    setError,
    switchTo,
    create,
    refetch: list.refetch,
  };
}

/** First letter for a workspace avatar tile. */
export function workspaceInitial(name: string | undefined | null): string {
  return (name ?? "").trim().slice(0, 1).toUpperCase() || "W";
}
