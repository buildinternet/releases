"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useFollows } from "./follows-provider";
import {
  listCollectionDigestSubscriptions,
  subscribeCollectionDigest,
  unsubscribeCollectionDigest,
} from "@/lib/follows";

/**
 * "Email me this digest weekly" toggle for a collection. Pages are ISR, so the
 * caller's subscription state is fetched client-side once signed in. Hidden when
 * auth isn't configured (`useFollows()` is null). Signed-out visitors see the
 * call-to-action; a click routes to `/login?redirect=<current path>`.
 */
export function CollectionDigestSubscribe({
  slug,
  className = "",
}: {
  slug: string;
  className?: string;
}) {
  const follows = useFollows();
  const router = useRouter();
  const pathname = usePathname();
  const [subscribedState, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const signedIn = Boolean(follows?.ready && follows.signedIn);
  const subscribed = signedIn && subscribedState;

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    listCollectionDigestSubscriptions()
      .then((subs) => {
        if (!cancelled) setSubscribed(subs.some((s) => s.collectionSlug === slug));
      })
      .catch(() => {
        // Leave as unsubscribed; the toggle is idempotent.
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, slug]);

  if (!follows || !follows.ready) return null;

  async function onClick() {
    if (!signedIn) {
      router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
      return;
    }
    const next = !subscribed;
    setBusy(true);
    setError(false);
    setSubscribed(next);
    try {
      if (next) await subscribeCollectionDigest(slug);
      else await unsubscribeCollectionDigest(slug);
    } catch {
      setSubscribed(!next);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type="button"
        disabled={busy}
        aria-pressed={subscribed}
        onClick={onClick}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--line)] px-3.5 text-[13px] font-semibold text-[var(--fg-2)] transition-[color,background-color,transform] hover:text-[var(--fg)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg
          viewBox="0 0 16 16"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.75" />
          <path d="m2.5 4.5 5.5 4 5.5-4" />
        </svg>
        {subscribed ? "Emailing you weekly" : "Email me this digest weekly"}
        {subscribed && <span className="font-normal text-[var(--fg-3)]">· Turn off</span>}
      </button>
      {error && (
        <span role="alert" className="text-[12px] text-[var(--fg-3)]">
          Couldn&apos;t update. Try again.
        </span>
      )}
    </div>
  );
}
