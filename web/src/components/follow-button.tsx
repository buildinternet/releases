"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { FollowTarget } from "@buildinternet/releases-api-types";
import { useFollows } from "./follows-provider";

/**
 * Follow/unfollow toggle for an org or product. Renders nothing only when the
 * follows feature is disabled (`useFollows()` is null). For signed-out visitors
 * the button still shows as a "Follow" call-to-action, but a click routes to
 * `/login?redirect=<current path>` instead of silently failing the unauthorized
 * write — once signed back in, the user lands where they left off.
 */
export function FollowButton({
  targetType,
  targetId,
  label,
}: {
  targetType: FollowTarget;
  targetId: string;
  label?: string;
}) {
  const follows = useFollows();
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  if (!follows || !follows.ready) return null;

  const following = follows.isFollowing(targetType, targetId);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!follows.signedIn) {
          router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
          return;
        }
        setBusy(true);
        try {
          await follows.toggle(targetType, targetId);
        } catch {
          // toggle already rolled back; swallow.
        } finally {
          setBusy(false);
        }
      }}
      className={
        following
          ? "rounded-md border border-stone-300 dark:border-stone-700 px-3 py-1 text-sm text-stone-600 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-stone-300 dark:hover:bg-stone-800"
          : "rounded-md bg-stone-900 dark:bg-stone-100 px-3 py-1 text-sm text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:text-stone-900 dark:hover:bg-stone-200"
      }
      aria-pressed={following}
      {...(label ? { "aria-label": following ? `Following ${label}` : `Follow ${label}` } : {})}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
