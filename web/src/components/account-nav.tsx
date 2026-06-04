"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";

/**
 * Session-aware header control. Renders a "Sign in" link when signed out and a
 * compact account menu (name/email + sign out) when signed in.
 *
 * Hard-gated on `NEXT_PUBLIC_BETTER_AUTH_URL`: when it's unset the Better Auth
 * client would resolve `/api/auth/*` against the *web* origin (which has no auth
 * handler) and `useSession` would 404 on every page. So we render nothing — and,
 * critically, the guard sits in a component that calls NO hooks, so we never
 * invoke `useSession` in an environment that can't serve it.
 */
const AUTH_ENABLED = Boolean(process.env.NEXT_PUBLIC_BETTER_AUTH_URL);

type Variant = "desktop" | "mobile";

export function AccountNav({ variant = "desktop" }: { variant?: Variant }) {
  if (!AUTH_ENABLED) return null;
  return <AccountNavInner variant={variant} />;
}

function initialOf(name: string | undefined, email: string): string {
  const source = (name ?? "").trim() || email;
  return source.slice(0, 1).toUpperCase();
}

function AccountNavInner({ variant }: { variant: Variant }) {
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
        <p className="text-xs text-stone-400 dark:text-stone-500">Signed in as</p>
        <p className="truncate text-stone-700 dark:text-stone-200">{user.email}</p>
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
        className="flex h-7 w-7 items-center justify-center rounded-full border border-stone-300 bg-stone-100 text-xs font-semibold text-stone-700 transition hover:border-stone-400 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:border-stone-600"
      >
        {initialOf(user.name, user.email)}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 w-56 border border-stone-200 bg-white p-3 shadow-lg dark:border-stone-800 dark:bg-stone-950"
          >
            <p className="text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
              Signed in as
            </p>
            {user.name && (
              <p className="mt-1 truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                {user.name}
              </p>
            )}
            <p className="truncate text-sm text-stone-600 dark:text-stone-300">{user.email}</p>
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
