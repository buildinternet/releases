"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

/**
 * Signed-out-only footnote under the home-page CLI demo nudging account
 * creation. Renders nothing while the session is loading (no flash for
 * signed-in visitors), when a session exists, or when the auth UI surface is
 * dark.
 *
 * Same gating shape as {@link AccountNav}: the master switch AND
 * `NEXT_PUBLIC_BETTER_AUTH_URL` are checked in a hook-free wrapper so
 * `useSession` is never invoked where `/api/auth/*` can't be served.
 */
const AUTH_ENABLED = AUTH_CONFIGURED;

export function SignupCta() {
  if (!AUTH_ENABLED) return null;
  return <SignupCtaInner />;
}

function SignupCtaInner() {
  const { data: session, isPending } = useSession();
  if (isPending || session) return null;
  return (
    <p className="mt-3 text-center text-[12px] text-stone-400 dark:text-stone-500">
      <Link
        href="/signup"
        className="underline decoration-stone-300 dark:decoration-stone-600 underline-offset-2 hover:text-stone-600 dark:hover:text-stone-300"
      >
        Create an account for personalized feeds and higher rate limits →
      </Link>
    </p>
  );
}
