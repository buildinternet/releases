"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client";
import { displayEmailOf } from "@/lib/auth-ui";
import { DemographicsPanel } from "@/components/demographics-panel";

function initialOf(name: string | undefined, email: string): string {
  const source = (name ?? "").trim() || email;
  return source.slice(0, 1).toUpperCase();
}

function ProfileAvatar({
  user,
}: {
  user: { name?: string | null; email: string; image?: string | null };
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [user.image]);
  if (user.image && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
    );
  }
  return <span aria-hidden="true">{initialOf(user.name ?? undefined, user.email)}</span>;
}

export function ProfilePanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/profile" className="underline">
          sign in
        </Link>{" "}
        to view your profile.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="border border-stone-200 p-5 dark:border-stone-800">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
          Profile
        </p>
        <div className="mt-4 flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-stone-300 bg-stone-100 text-base font-semibold text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">
            <ProfileAvatar user={user} />
          </span>
          <div className="min-w-0">
            {user.name && (
              <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                {user.name}
              </p>
            )}
            <p className="truncate text-sm text-stone-600 dark:text-stone-300">
              {displayEmailOf(user)}
            </p>
          </div>
        </div>
      </div>

      <div className="border border-stone-200 p-5 dark:border-stone-800">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Email</h2>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Your sign-in address and where account notifications are delivered.
        </p>
        <p className="mt-3 text-sm font-medium text-stone-900 dark:text-stone-100">
          {displayEmailOf(user)}
        </p>
        <Link
          href="/account/email"
          className="mt-3 inline-block text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          Change email
        </Link>
      </div>

      <DemographicsPanel />
    </div>
  );
}
