"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";
import type { Follow, FollowTarget } from "@buildinternet/releases-api-types";
import { listFollows, follow as apiFollow, unfollow as apiUnfollow } from "@/lib/follows";

type Key = `${FollowTarget}:${string}`;
const keyOf = (t: FollowTarget, id: string): Key => `${t}:${id}`;

interface FollowsCtx {
  ready: boolean;
  /** Whether a user session is present. Drives the follow button's sign-in redirect. */
  signedIn: boolean;
  /**
   * The caller's enriched follows (name/slug/avatar/orgSlug), newest-first — the
   * same payload `GET /v1/me/follows` returns. Exposed so the `/following` page
   * renders from here instead of re-fetching the list the provider already holds.
   * Empty until `ready`. `isFollowing` reads the optimistic `keys` set, not this
   * list, so a freshly-clicked Follow flips the button instantly while the
   * enriched row arrives on the next refetch.
   */
  follows: Follow[];
  isFollowing: (t: FollowTarget, id: string) => boolean;
  toggle: (t: FollowTarget, id: string) => Promise<void>;
}

const Context = createContext<FollowsCtx | null>(null);

/** Null when follows is disabled or the user is signed out — buttons hide. */
export function useFollows(): FollowsCtx | null {
  return useContext(Context);
}

export function FollowsProvider({ children }: { children: React.ReactNode }) {
  const enabled = AUTH_CONFIGURED;
  if (!enabled) return <>{children}</>;
  return <FollowsProviderInner>{children}</FollowsProviderInner>;
}

function FollowsProviderInner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  // `keys` is the optimistic authority for `isFollowing` (flips instantly on a
  // click); `follows` is the enriched list for rendering, reconciled from the
  // server on load and after each successful toggle.
  const [keys, setKeys] = useState<Set<Key>>(new Set());
  const [follows, setFollows] = useState<Follow[]>([]);
  const [ready, setReady] = useState(false);

  // Pull the enriched list from the server and sync both pieces of state to it.
  // Only setters are referenced, so the callback is stable (empty deps).
  const refetch = useCallback(async () => {
    const list = await listFollows();
    setFollows(list);
    setKeys(new Set(list.map((f) => keyOf(f.targetType, f.targetId))));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!session?.user) {
      setKeys(new Set());
      setFollows([]);
      setReady(true);
      return;
    }
    setReady(false);
    refetch()
      .catch(() => {
        // fail open — buttons render as "not following", list renders empty
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, refetch]);

  const signedIn = Boolean(session?.user);
  const isFollowing = useCallback((t: FollowTarget, id: string) => keys.has(keyOf(t, id)), [keys]);

  const toggle = useCallback(
    async (t: FollowTarget, id: string) => {
      const k = keyOf(t, id);
      // Derive the action from the latest state inside the updater (not a
      // closed-over snapshot) so concurrent toggles on different buttons can't
      // pick the wrong verb.
      let wasFollowing = false;
      setKeys((prev) => {
        wasFollowing = prev.has(k);
        const next = new Set(prev);
        if (wasFollowing) next.delete(k);
        else next.add(k);
        return next;
      });
      // Optimistically drop the row on unfollow so the list reacts instantly; a
      // fresh follow can't build an enriched row here (the button only knows the
      // id), so it appears after the post-success refetch instead.
      const removed = follows.find((f) => f.targetType === t && f.targetId === id);
      if (wasFollowing) {
        setFollows((prev) => prev.filter((f) => !(f.targetType === t && f.targetId === id)));
      }
      try {
        if (wasFollowing) await apiUnfollow(t, id);
        else await apiFollow(t, id);
        // Reconcile the enriched list (and keys) with the server — this is what
        // materializes a freshly-followed entity's row.
        await refetch();
      } catch (err) {
        setKeys((prev) => {
          const next = new Set(prev);
          if (wasFollowing) next.add(k);
          else next.delete(k);
          return next;
        });
        if (wasFollowing && removed) setFollows((prev) => [...prev, removed]);
        throw err;
      }
    },
    [follows, refetch],
  );

  const value = useMemo<FollowsCtx>(
    () => ({ ready, signedIn, follows, isFollowing, toggle }),
    [ready, signedIn, follows, isFollowing, toggle],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
