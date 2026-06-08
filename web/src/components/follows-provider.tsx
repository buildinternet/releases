"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";
import type { FollowTarget } from "@buildinternet/releases-api-types";
import { listFollows, follow as apiFollow, unfollow as apiUnfollow } from "@/lib/follows";

type Key = `${FollowTarget}:${string}`;
const keyOf = (t: FollowTarget, id: string): Key => `${t}:${id}`;

interface FollowsCtx {
  ready: boolean;
  /** Whether a user session is present. Drives the follow button's sign-in redirect. */
  signedIn: boolean;
  isFollowing: (t: FollowTarget, id: string) => boolean;
  toggle: (t: FollowTarget, id: string) => Promise<void>;
}

const Context = createContext<FollowsCtx | null>(null);

/** Null when follows is disabled or the user is signed out — buttons hide. */
export function useFollows(): FollowsCtx | null {
  return useContext(Context);
}

export function FollowsProvider({ children }: { children: React.ReactNode }) {
  const enabled = AUTH_UI_ENABLED && Boolean(process.env.NEXT_PUBLIC_BETTER_AUTH_URL);
  if (!enabled) return <>{children}</>;
  return <FollowsProviderInner>{children}</FollowsProviderInner>;
}

function FollowsProviderInner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [keys, setKeys] = useState<Set<Key>>(new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!session?.user) {
      setKeys(new Set());
      setReady(true);
      return;
    }
    setReady(false);
    listFollows()
      .then((follows) => {
        if (cancelled) return;
        setKeys(new Set(follows.map((f) => keyOf(f.targetType, f.targetId))));
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true); // fail open — buttons render as "not following"
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const signedIn = Boolean(session?.user);
  const isFollowing = useCallback((t: FollowTarget, id: string) => keys.has(keyOf(t, id)), [keys]);

  const toggle = useCallback(async (t: FollowTarget, id: string) => {
    const k = keyOf(t, id);
    // Derive the action from the latest state inside the updater (not a
    // closed-over snapshot) so concurrent toggles on different buttons can't
    // pick the wrong verb. This also keeps the callback stable (empty deps).
    let wasFollowing = false;
    setKeys((prev) => {
      wasFollowing = prev.has(k);
      const next = new Set(prev);
      if (wasFollowing) next.delete(k);
      else next.add(k);
      return next;
    });
    try {
      if (wasFollowing) await apiUnfollow(t, id);
      else await apiFollow(t, id);
    } catch (err) {
      setKeys((prev) => {
        const next = new Set(prev);
        if (wasFollowing) next.add(k);
        else next.delete(k);
        return next;
      });
      throw err;
    }
  }, []);

  const value = useMemo<FollowsCtx>(
    () => ({ ready, signedIn, isFollowing, toggle }),
    [ready, signedIn, isFollowing, toggle],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
