import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { MobileNav } from "./mobile-nav";
import { SearchBar } from "./search-bar";
import { SearchTrigger } from "./search-trigger";
import { AccountNav } from "./account-nav";
import { GitHubStar } from "./github-star";
import { visibleNavItems } from "./nav-items";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";

export function Header() {
  const devAdmin = isLocalAdminEnabled();
  // Local dev gets a loud orange "DEV" badge so the environment is unmistakable
  // at a glance; deployed preview/prod keep the subtle gray "preview" chip.
  const isLocalDev = process.env.NODE_ENV === "development";
  return (
    <header
      className="relative z-40 border-b border-stone-200 dark:border-stone-800 px-6 py-4 flex items-center gap-4 sm:gap-6"
      style={{ viewTransitionName: "site-header" }}
    >
      <Link
        href="/"
        className="font-bold text-base sm:text-lg tracking-tight text-stone-900 dark:text-stone-100 flex shrink-0 items-center gap-2"
      >
        <svg viewBox="0 0 64 64" aria-hidden="true" className="h-5 w-5 shrink-0">
          <rect
            width="64"
            height="64"
            rx="14"
            fill="currentColor"
            className="text-stone-900 dark:text-stone-100"
          />
          <rect
            x="14"
            y="18"
            width="28"
            height="6"
            rx="1.5"
            className="fill-stone-50 dark:fill-stone-900"
          />
          <rect
            x="14"
            y="29"
            width="22"
            height="6"
            rx="1.5"
            className="fill-stone-50/70 dark:fill-stone-900/70"
          />
          <rect x="14" y="40" width="36" height="6" rx="1.5" fill="oklch(0.60 0.18 252)" />
        </svg>
        releases.sh
        {isLocalDev ? (
          <span className="text-[10px] font-bold uppercase tracking-wider text-stone-950 bg-amber-400 rounded px-1.5 py-0.5 leading-none">
            dev
          </span>
        ) : (
          <span className="text-[10px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500 border border-stone-300 dark:border-stone-700 rounded px-1.5 py-0.5 leading-none">
            preview
          </span>
        )}
      </Link>
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchBar className="hidden lg:block w-full max-w-[420px]" autoFocus={false} />
        <SearchTrigger className="hidden sm:flex lg:hidden w-fit" />
      </div>
      <MobileNav devAdmin={devAdmin} />
      <nav className="hidden sm:flex shrink-0 items-center gap-5 text-sm text-stone-500 dark:text-stone-400">
        {visibleNavItems().map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`hover:text-stone-700 dark:hover:text-stone-300 ${item.desktopClassName ?? ""}`}
          >
            {item.label}
          </Link>
        ))}
        <GitHubStar />
        <ThemeToggle />
        <AccountNav devAdmin={devAdmin} />
      </nav>
    </header>
  );
}
