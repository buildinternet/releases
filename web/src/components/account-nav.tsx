"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { AUTH_UI_ENABLED, USER_API_KEYS_ENABLED } from "@/lib/auth-ui";

/**
 * Session-aware header control. Renders a "Sign in" link when signed out and a
 * compact account menu (name/email + sign out) when signed in.
 *
 * Gated on two things: the `NEXT_PUBLIC_AUTH_UI_ENABLED` master switch (so the
 * surface stays dark until opted in — see {@link AUTH_UI_ENABLED}) AND
 * `NEXT_PUBLIC_BETTER_AUTH_URL` (without it the Better Auth client resolves
 * `/api/auth/*` against the *web* origin and `useSession` 404s every page). When
 * either is absent we render nothing — and, critically, the guard sits in a
 * component that calls NO hooks, so we never invoke `useSession` where it can't
 * be served.
 */
const AUTH_ENABLED = AUTH_UI_ENABLED && Boolean(process.env.NEXT_PUBLIC_BETTER_AUTH_URL);

type Variant = "desktop" | "mobile";

export function AccountNav({
  variant = "desktop",
  adminEnabled = false,
}: {
  variant?: Variant;
  adminEnabled?: boolean;
}) {
  if (!AUTH_ENABLED) return null;
  return <AccountNavInner variant={variant} adminEnabled={adminEnabled} />;
}

function initialOf(name: string | undefined, email: string): string {
  const source = (name ?? "").trim() || email;
  return source.slice(0, 1).toUpperCase();
}

/**
 * Fills its (circular, sized by the parent) container with the user's avatar
 * `image` — imported from Google/GitHub on sign-in — falling back to the name/email
 * initial when there's no image (email-password users) or it fails to load. Each
 * instance tracks its own load error, so multiple avatars on screen degrade
 * independently. Plain <img> (not next/image) to cover both `lh3.googleusercontent.com`
 * and `*.githubusercontent.com` without an optimizer remote-pattern, and
 * `referrerPolicy="no-referrer"` — the convention for third-party profile photos.
 */
function UserAvatar({
  user,
}: {
  user: { name?: string | null; email: string; image?: string | null };
}) {
  const [broken, setBroken] = useState(false);
  // Clear a prior load error whenever the URL changes (avatar re-sync on a fresh
  // Google sign-in, a different user, or a session refetch) — otherwise `broken`
  // would permanently mask a NEW, valid `src` behind the initial fallback.
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

function AccountNavInner({ variant, adminEnabled }: { variant: Variant; adminEnabled: boolean }) {
  const router = useRouter();
  const { data, isPending } = useSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
      setOpen(false);
      router.push("/");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  // Avoid a flash of "Sign in" before the session resolves.
  if (isPending) {
    return variant === "mobile" ? null : <span className="h-7 w-7 shrink-0" aria-hidden="true" />;
  }

  const user = data?.user;

  if (variant === "mobile") {
    if (!user) {
      return (
        <Link href="/login" className="py-2 hover:text-stone-900 dark:hover:text-stone-100">
          Sign in
        </Link>
      );
    }
    return (
      <div className="border-t border-stone-200 pt-3 mt-2 dark:border-stone-800">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-stone-300 bg-stone-100 text-sm font-semibold text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">
            <UserAvatar user={user} />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-stone-400 dark:text-stone-500">Signed in as</p>
            <p className="truncate text-stone-700 dark:text-stone-200">{user.email}</p>
          </div>
        </div>
        <Link
          href="/following"
          className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          Following
        </Link>
        {adminEnabled && (
          <Link
            href="/admin"
            className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            Admin
          </Link>
        )}
        {USER_API_KEYS_ENABLED && (
          <Link
            href="/account"
            className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            API keys
          </Link>
        )}
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-2 py-1 text-left text-stone-500 hover:text-stone-900 disabled:opacity-60 dark:text-stone-400 dark:hover:text-stone-100"
        >
          {signingOut ? "Signing out..." : "Sign out"}
        </button>
      </div>
    );
  }

  if (!user) {
    return (
      <Link href="/login" className="hover:text-stone-700 dark:hover:text-stone-300">
        Sign in
      </Link>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-stone-300 bg-stone-100 text-xs font-semibold text-stone-700 transition hover:border-stone-400 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:border-stone-600"
      >
        <UserAvatar user={user} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 w-56 border border-stone-200 bg-white p-3 shadow-lg dark:border-stone-800 dark:bg-stone-950"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-stone-300 bg-stone-100 text-sm font-semibold text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">
                <UserAvatar user={user} />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
                  Signed in as
                </p>
                {user.name && (
                  <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                    {user.name}
                  </p>
                )}
                <p className="truncate text-sm text-stone-600 dark:text-stone-300">{user.email}</p>
              </div>
            </div>
            <Link
              href="/following"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="mt-3 block w-full border border-stone-300 px-3 py-1.5 text-center text-sm text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
            >
              Following
            </Link>
            {adminEnabled && (
              <Link
                href="/admin"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="mt-3 block w-full border border-stone-300 px-3 py-1.5 text-center text-sm text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
              >
                Admin
              </Link>
            )}
            {USER_API_KEYS_ENABLED && (
              <Link
                href="/account"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="mt-3 block w-full border border-stone-300 px-3 py-1.5 text-center text-sm text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
              >
                API keys
              </Link>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="mt-3 w-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
              role="menuitem"
            >
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
