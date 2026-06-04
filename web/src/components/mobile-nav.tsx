"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "./theme-toggle";
import { AccountNav } from "./account-nav";
import { GITHUB_REPO_URL, visibleNavItems } from "./nav-items";

const PANEL_ID = "mobile-nav-panel";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Close the panel whenever the route changes (e.g. tapping "Sign in" or being
  // redirected home after sign-out) so it never lingers over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((v) => !v)}
        className="relative z-50 flex h-9 w-9 items-center justify-center rounded text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-5 w-5 fill-none stroke-current"
          strokeWidth="2"
          strokeLinecap="round"
        >
          {open ? (
            <>
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </>
          ) : (
            <>
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </>
          )}
        </svg>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/20 dark:bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            id={PANEL_ID}
            className="absolute left-0 right-0 top-full z-40 border-b border-stone-200 bg-white shadow-lg dark:border-stone-800 dark:bg-stone-950"
          >
            <nav className="flex flex-col px-6 py-4 text-sm text-stone-700 dark:text-stone-300">
              {visibleNavItems({ mobile: true }).map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="py-2 hover:text-stone-900 dark:hover:text-stone-100"
                >
                  {item.label}
                </Link>
              ))}
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between py-2 hover:text-stone-900 dark:hover:text-stone-100"
              >
                <span>GitHub</span>
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="h-[18px] w-[18px] fill-current"
                >
                  <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.71 21.39 24 17.08 24 12 24 5.73 18.77.5 12 .5Z" />
                </svg>
              </a>
              <AccountNav variant="mobile" />
              <div className="flex items-center justify-between border-t border-stone-200 pt-3 mt-2 dark:border-stone-800">
                <span className="text-stone-500 dark:text-stone-400">Theme</span>
                <ThemeToggle />
              </div>
            </nav>
          </div>
        </>
      )}
    </div>
  );
}
