"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ADMIN_GROUP_LABEL, navItemForPath, visibleNavGroups } from "@/lib/account-nav";
import { ErrorText, eyebrowClass } from "@releases/design-system";
import { useIsAdmin } from "@/components/admin-only";
import { useWorkspaces } from "@/components/account/use-workspaces";
import { WorkspaceAvatar } from "@/components/account/workspace-avatar";
import {
  ChevronSelectorIcon,
  ChevronDownIcon,
  CheckIcon,
  PlusIcon,
} from "@/components/account/icons";

/**
 * Settings sidebar: workspace selector + Personal / Workspace / (admin-only) Admin
 * groups. Active item gets an accent-soft pill. Sticky on desktop; collapsible on mobile.
 */

function WorkspaceSelector() {
  const { workspaces, active, isLoading, busy, error, switchTo, create } = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  // Close the menu only after a successful switch, so a failure stays visible.
  const onSwitch = (id: string, isActive: boolean) => {
    if (isActive) {
      setOpen(false);
      return;
    }
    void switchTo(id).then((ok) => {
      if (ok) setOpen(false);
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Prefer active (live or cached); only fall back to list[0] once the list is ready.
  const current = active ?? (!isLoading ? (workspaces[0] ?? null) : null);

  return (
    <div className="relative mb-6" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={isLoading && !current}
        className="flex w-full items-center gap-2.5 rounded-[10px] border border-stone-200 bg-white p-2.5 text-left transition hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700"
      >
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--accent)] text-[13px] font-semibold text-[var(--on-accent)]">
          {current ? (
            <WorkspaceAvatar name={current.name} logo={current.logo} />
          ) : (
            <span
              className="h-full w-full animate-pulse bg-[var(--accent)]/40"
              aria-hidden="true"
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          {current ? (
            <>
              <span className="block truncate text-[13.5px] font-semibold text-stone-900 dark:text-stone-100">
                {current.name}
              </span>
              <span className="block truncate text-[11.5px] text-stone-400 dark:text-stone-500">
                Workspace
              </span>
            </>
          ) : isLoading ? (
            <>
              <span className="mb-1 block h-3.5 w-24 animate-pulse rounded bg-stone-200 dark:bg-stone-800" />
              <span className="block h-3 w-16 animate-pulse rounded bg-stone-100 dark:bg-stone-900" />
            </>
          ) : (
            <>
              <span className="block truncate text-[13.5px] font-semibold text-stone-900 dark:text-stone-100">
                Personal
              </span>
              <span className="block truncate text-[11.5px] text-stone-400 dark:text-stone-500">
                No workspace
              </span>
            </>
          )}
        </span>
        <ChevronSelectorIcon className="h-[15px] w-[15px] shrink-0 text-stone-400 dark:text-stone-500" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            className="absolute inset-x-0 top-[58px] z-30 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg dark:border-stone-800 dark:bg-stone-950"
          >
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
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-stone-100 disabled:opacity-60 dark:hover:bg-stone-900"
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
                    setOpen(false);
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
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-stone-600 transition hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900"
              >
                <PlusIcon className="h-4 w-4 text-stone-400 dark:text-stone-500" />
                Create workspace
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function NavBody({
  pathname,
  includeAdmin,
  onNavigate,
}: {
  pathname: string;
  includeAdmin: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div>
      <WorkspaceSelector />
      {visibleNavGroups({ includeAdmin }).map((group) => (
        <div key={group.label} className="mb-5 last:mb-0">
          <div
            className={`${eyebrowClass} mb-2 ml-2.5 text-[10.5px] text-stone-400 dark:text-stone-500`}
          >
            {group.label}
          </div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.Icon;
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-[11px] rounded-[9px] px-[11px] py-2 text-[13.5px] transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)] font-semibold text-stone-900 dark:text-stone-100"
                        : "font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900"
                    }`}
                  >
                    <Icon
                      className={`h-[17px] w-[17px] shrink-0 ${
                        active ? "text-[var(--accent)]" : "text-stone-400 dark:text-stone-500"
                      }`}
                    />
                    <span className="flex-1">{item.label}</span>
                    {item.badge && (
                      <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--accent)]">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AccountSettingsNav({ devAdmin = false }: { devAdmin?: boolean }) {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const includeAdmin = useIsAdmin(devAdmin);
  const currentLabel =
    navItemForPath(pathname)?.label ??
    (pathname.startsWith("/admin") ? ADMIN_GROUP_LABEL : "Settings");

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  return (
    <>
      <details
        ref={detailsRef}
        className="group rounded-xl border border-stone-200 md:hidden dark:border-stone-800"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>{currentLabel}</span>
          <ChevronDownIcon className="h-4 w-4 text-stone-500 transition-transform group-open:rotate-180" />
        </summary>
        <nav className="border-t border-stone-200 px-4 pb-4 pt-3 dark:border-stone-800">
          <NavBody
            pathname={pathname}
            includeAdmin={includeAdmin}
            onNavigate={() => {
              if (detailsRef.current) detailsRef.current.open = false;
            }}
          />
        </nav>
      </details>

      <nav className="hidden w-[248px] shrink-0 self-start md:sticky md:top-20 md:block">
        <div className={`${eyebrowClass} mb-4 ml-0.5 text-stone-400 dark:text-stone-500`}>
          Settings
        </div>
        <NavBody pathname={pathname} includeAdmin={includeAdmin} />
      </nav>
    </>
  );
}
