"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CollectionDigestSubscription } from "@buildinternet/releases-api-types";
import { listCollectionDigestSubscriptions, unsubscribeCollectionDigest } from "@/lib/follows";
import { VerifyEmailHint } from "@/components/verify-email-hint";
import { useSession } from "@/lib/auth-client";
import { ErrorText, listCardClass, listRowClass, dangerLinkClass } from "@releases/design-system";

/**
 * Weekly collection digest emails the user has turned on from a collection's
 * digest page. Fetched client-side (like the other panels' follow-ups); the
 * list is small and per-user, so there is no server bootstrap.
 */
export function CollectionDigestsSection() {
  const { data: session } = useSession();
  const [subs, setSubs] = useState<CollectionDigestSubscription[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCollectionDigestSubscriptions()
      .then((list) => {
        if (!cancelled) setSubs(list);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOff(slug: string) {
    if (busySlug) return;
    setBusySlug(slug);
    setError(null);
    try {
      await unsubscribeCollectionDigest(slug);
      setSubs((prev) => prev?.filter((s) => s.collectionSlug !== slug) ?? prev);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to turn off this digest.");
    } finally {
      setBusySlug(null);
    }
  }

  const unverified = session?.user != null && !session.user.emailVerified;

  return (
    <section>
      <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        Collection digests
      </div>
      <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
        A weekly email for each collection you subscribe to.
      </p>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {loadFailed ? (
        <ErrorText>Couldn&apos;t load your collection digests.</ErrorText>
      ) : subs === null ? (
        <p className="text-[13px] text-stone-500 dark:text-stone-400">Loading…</p>
      ) : subs.length === 0 ? (
        <p className="text-[13px] text-stone-500 dark:text-stone-400">
          No collection digests yet. Subscribe from any collection&apos;s digest page, or browse{" "}
          <Link
            href="/collections"
            className="underline underline-offset-2 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Collections
          </Link>
          .
        </p>
      ) : (
        <>
          <div className={listCardClass}>
            {subs.map((s) => (
              <div key={s.collectionSlug} className={listRowClass}>
                <div className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                  <Link
                    href={`/collections/${s.collectionSlug}`}
                    className="hover:underline underline-offset-2"
                  >
                    {s.collectionName}
                  </Link>
                </div>
                <button
                  type="button"
                  onClick={() => void turnOff(s.collectionSlug)}
                  disabled={busySlug !== null}
                  className={`${dangerLinkClass} shrink-0 text-[13px]`}
                >
                  Turn off
                </button>
              </div>
            ))}
          </div>
          {unverified && session?.user && (
            <VerifyEmailHint
              email={session.user.email}
              message="Verify your email to start getting these digests."
              className="mt-2.5 block"
            />
          )}
        </>
      )}
    </section>
  );
}
