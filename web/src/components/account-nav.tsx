"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { AUTH_CONFIGURED, displayEmailOf } from "@/lib/auth-ui";
import { computeIsAdmin } from "@/components/admin-only";
import { ACCOUNT_SETTINGS_HOME, adminDefaultHref } from "@/lib/account-nav";
import { useWorkspaces } from "@/components/account/use-workspaces";
import { WorkspaceAvatar } from "@/components/account/workspace-avatar";
import { UserAvatar } from "@/components/account/user-avatar";
import {
  readUserDisplayCache,
  writeUserDisplayCache,
} from "@/components/account/user-display-cache";
import {
  ProfileIcon,
  HeartIcon,
  ShieldIcon,
  SignOutIcon,
  CheckIcon,
  PlusIcon,
} from "@/components/account/icons";
import { ErrorText, eyebrowClass } from "@releases/design-system";

/**
 * Session-aware header control. Renders a "Sign in" link when signed out and a
 * compact account menu (identity → links → workspace switcher → sign out) when
 * signed in.
 *
 * Gated solely on `NEXT_PUBLIC_BETTER_AUTH_URL` being configured (see
 * {@link AUTH_CONFIGURED}) — without it the Better Auth client resolves
 * `/api/auth/*` against the *web* origin and `useSession` 404s every page. When
 * it's absent we render nothing — and, critically, the guard sits in a component
 * that calls NO hooks, so we never invoke `useSession` where it can't be served.
 */
const AUTH_ENABLED = AUTH_CONFIGURED;

/** Bordered CTA — matches secondary auth buttons (passkey, magic link, account menu). */
const SIGN_IN_LINK_CLASS =
  "inline-flex items-center justify-center border border-stone-300 bg-white px-3 text-sm font-medium text-stone-800 transition hover:border-stone-400 hover:bg-stone-50 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100 dark:hover:border-stone-500 dark:hover:bg-stone-800";

type Variant = "desktop" | "mobile";

export function AccountNav({
  variant = "desktop",
  devAdmin = false,
}: {
  variant?: Variant;
  /** Server-evaluated local-dev admin override; OR'd with the session role. */
  devAdmin?: boolean;
}) {
  if (!AUTH_ENABLED) return null;
  return <AccountNavInner variant={variant} devAdmin={devAdmin} />;
}

const menuLinkClass =
  "flex items-center gap-[11px] rounded-lg px-2.5 py-2 text-[13.5px] text-stone-600 transition hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-stone-100";
const menuIconClass = "h-4 w-4 shrink-0 text-stone-400 dark:text-stone-500";

/** Inline workspace list + create, shown expanded inside the account dropdown. */
function MenuWorkspaces({ onDone }: { onDone: () => void }) {
  const { workspaces, active, isLoading, busy, error, switchTo, create } = useWorkspaces();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const current = active ?? (!isLoading ? (workspaces[0] ?? null) : null);

  // Close the menu only after a successful switch, so a failure stays visible.
  const onSwitch = (id: string, isActive: boolean) => {
    if (isActive) {
      onDone();
      return;
    }
    void switchTo(id).then((ok) => {
      if (ok) onDone();
    });
  };

  if (isLoading && workspaces.length === 0 && !creating) {
    return (
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <span className="h-6 w-6 shrink-0 animate-pulse rounded-md bg-stone-200 dark:bg-stone-800" />
        <span className="h-3.5 w-20 animate-pulse rounded bg-stone-200 dark:bg-stone-800" />
      </div>
    );
  }

  if (workspaces.length === 0 && !creating) {
    return (
      <button type="button" onClick={() => setCreating(true)} className={menuLinkClass}>
        <PlusIcon className={menuIconClass} />
        Create workspace
      </button>
    );
  }

  return (
    <>
      {workspaces.map((ws) => {
        const isActive = current?.id === ws.id;
        return (
          <button
            key={ws.id}
            type="button"
            role="menuitemradio"
            aria-checked={isActive}
            disabled={busy}
            onClick={() => onSwitch(ws.id, isActive)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-stone-100 disabled:opacity-60 dark:hover:bg-stone-900"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-stone-200 bg-stone-100 text-[11px] font-semibold text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">
              <WorkspaceAvatar name={ws.name} logo={ws.logo} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-stone-900 dark:text-stone-100">
              {ws.name}
            </span>
            {isActive && <CheckIcon className="h-[15px] w-[15px] text-[var(--accent)]" />}
          </button>
        );
      })}
      {error && (
        <div className="px-2.5 py-1.5">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {creating ? (
        <form
          className="flex items-center gap-1.5 p-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await create(name)) {
              setName("");
              setCreating(false);
              onDone();
            }
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focuses the field the user just opened
            autoFocus
            className="h-8 min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-2 text-[13px] text-stone-900 outline-none focus:border-[var(--accent)] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="h-8 shrink-0 rounded-md bg-[var(--accent)] px-2.5 text-[12px] font-semibold text-[var(--on-accent)] disabled:opacity-60"
          >
            Add
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setCreating(true)} className={menuLinkClass}>
          <PlusIcon className={menuIconClass} />
          Create workspace
        </button>
      )}
    </>
  );
}

function AccountNavInner({ variant, devAdmin }: { variant: Variant; devAdmin: boolean }) {
  const router = useRouter();
  const { data, isPending } = useSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [cachedUser, setCachedUser] = useState(() => readUserDisplayCache());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const liveUser = data?.user;
  useEffect(() => {
    if (!liveUser) return;
    const next = {
      id: liveUser.id,
      name: liveUser.name ?? null,
      email: liveUser.email,
      image: liveUser.image ?? null,
    };
    writeUserDisplayCache(next);
    setCachedUser(next);
  }, [liveUser?.id, liveUser?.name, liveUser?.email, liveUser?.image]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
      writeUserDisplayCache(null);
      setCachedUser(null);
      setOpen(false);
      router.push("/");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  // Prefer live session; while pending, paint last-known avatar so the header
  // doesn't go empty → photo on every navigation.
  const user = liveUser ?? (isPending ? cachedUser : null);
  if (isPending && !user) {
    return variant === "mobile" ? null : <span className="h-7 w-7 shrink-0" aria-hidden="true" />;
  }

  const role = (liveUser as { role?: string } | undefined)?.role ?? null;
  const showAdmin = computeIsAdmin(role, devAdmin);
  const adminHref = showAdmin ? adminDefaultHref() : null;

  if (variant === "mobile") {
    if (!user) {
      return (
        <Link href="/login" className={`${SIGN_IN_LINK_CLASS} mt-2 h-10 w-full`}>
          Sign in
        </Link>
      );
    }
    return (
      <div className="mt-2 border-t border-stone-200 pt-3 dark:border-stone-800">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-stone-300 bg-stone-100 text-sm font-semibold text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">
            <UserAvatar user={user} />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-stone-400 dark:text-stone-500">Signed in as</p>
            <p className="truncate text-stone-700 dark:text-stone-200">{displayEmailOf(user)}</p>
          </div>
        </div>
        <Link
          href={ACCOUNT_SETTINGS_HOME}
          className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          Settings
        </Link>
        <Link
          href="/following"
          className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          Following
        </Link>
        {adminHref && (
          <Link
            href={adminHref}
            className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            Admin
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
      <Link href="/login" className={`${SIGN_IN_LINK_CLASS} h-8 shrink-0`}>
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
            className="account-menu-pop absolute right-0 top-full z-40 mt-2 w-[296px] overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl dark:border-stone-800 dark:bg-stone-950"
          >
            <div className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent)] text-[15px] font-semibold text-[var(--on-accent)]">
                <UserAvatar user={user} />
              </span>
              <div className="min-w-0">
                {user.name && (
                  <p className="truncate text-[13.5px] font-semibold text-stone-900 dark:text-stone-100">
                    {user.name}
                  </p>
                )}
                <p className="truncate text-[12.5px] text-stone-400 dark:text-stone-500">
                  {displayEmailOf(user)}
                </p>
              </div>
            </div>

            <div className="h-px bg-stone-200 dark:bg-stone-800" />

            <div className="p-1.5">
              <Link
                href={ACCOUNT_SETTINGS_HOME}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={menuLinkClass}
              >
                <ProfileIcon className={menuIconClass} />
                Settings
              </Link>
              <Link
                href="/following"
                role="menuitem"
                onClick={() => setOpen(false)}
                className={menuLinkClass}
              >
                <HeartIcon className={menuIconClass} />
                Following
              </Link>
              {adminHref && (
                <Link
                  href={adminHref}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={menuLinkClass}
                >
                  <ShieldIcon className={menuIconClass} />
                  Admin
                </Link>
              )}
            </div>

            <div className="h-px bg-stone-200 dark:bg-stone-800" />

            <div className="px-1.5 pb-1.5 pt-2.5">
              <div
                className={`${eyebrowClass} mb-1.5 px-2.5 text-[10.5px] text-stone-400 dark:text-stone-500`}
              >
                Workspace
              </div>
              <MenuWorkspaces onDone={() => setOpen(false)} />
            </div>

            <div className="h-px bg-stone-200 dark:bg-stone-800" />

            <div className="p-1.5">
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                role="menuitem"
                className="flex w-full items-center gap-[11px] rounded-lg px-2.5 py-2 text-left text-[13.5px] text-stone-600 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:text-stone-400 dark:hover:bg-red-950/30 dark:hover:text-red-400"
              >
                <SignOutIcon className="h-4 w-4 shrink-0" />
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
