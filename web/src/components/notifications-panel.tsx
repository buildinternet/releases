"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { DigestCard } from "@/app/following/digest-card";
import { FeedTokenCard } from "@/app/following/feed-token-card";

export function NotificationsPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/notifications" className="underline">
          sign in
        </Link>{" "}
        to manage notifications.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <DigestCard />
      <FeedTokenCard />
    </div>
  );
}
