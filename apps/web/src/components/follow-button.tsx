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
 *
 * On a product page, pass `parentOrgId`/`parentOrgName`: when the user already
 * follows the owning org, the product is covered transitively (an org follow =
 * all its products), so the control becomes a non-interactive "Following <org>"
 * indicator. Unfollowing then happens on the org page, not here — preventing a
 * confusing redundant product follow.
 */
export function FollowButton({
  targetType,
  targetId,
  label,
  parentOrgId,
  parentOrgName,
}: {
  targetType: FollowTarget;
  targetId: string;
  label?: string;
  parentOrgId?: string;
  parentOrgName?: string;
}) {
  const follows = useFollows();
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  if (!follows || !follows.ready) return null;

  // A product already covered by an org follow can't be followed/unfollowed
  // here — surface a locked, informational state instead of a dead toggle.
  const coveredByOrg =
    targetType === "product" &&
    follows.signedIn &&
    parentOrgId !== undefined &&
    follows.isFollowing("org", parentOrgId);

  if (coveredByOrg) {
    const text = parentOrgName ? `Following ${parentOrgName}` : "Following organization";
    return (
      <span
        className="inline-flex min-h-9 cursor-default items-center rounded-full border border-stone-200 px-4 text-sm font-semibold text-stone-400 dark:border-stone-700 dark:text-stone-500"
        title={
          parentOrgName
            ? `You follow ${parentOrgName}, which already includes all its products.`
            : "You follow this organization, which already includes all its products."
        }
      >
        {text}
      </span>
    );
  }

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
          ? "inline-flex min-h-9 min-w-[88px] items-center justify-center rounded-full border border-stone-300 px-4 text-sm font-bold text-stone-600 transition-[color,background-color,border-color,transform] active:scale-[0.96] hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800"
          : "inline-flex min-h-9 min-w-[88px] items-center justify-center rounded-full bg-stone-900 px-4 text-sm font-bold text-white transition-[color,background-color,transform] active:scale-[0.96] hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
      }
      aria-pressed={following}
      {...(label ? { "aria-label": following ? `Following ${label}` : `Follow ${label}` } : {})}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
